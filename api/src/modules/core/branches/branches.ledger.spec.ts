import { BranchesService } from './branches.service';

/**
 * A0-01 — Completar el ledger de inventario.
 *
 * Transferencias, ajustes manuales y conteos (bulk) modificaban BranchInventory
 * SIN registrar InventoryMovement. Estas pruebas demuestran que ahora SÍ generan
 * el movimiento correspondiente, sin duplicados y sin alterar el stock resultante.
 */

const TENANT = 'tenant-1';

/** El inventario cuelga de la variante default; el fake la deriva del producto. */
const variantOf = (productId: string) => `v-${productId}`;

function build() {
  const invCreate = jest.fn().mockResolvedValue({ id: 'mov' });
  const biUpsert = jest.fn().mockResolvedValue({ stock: 0 });
  const biUpdate = jest.fn().mockResolvedValue({});
  const biFindUnique = jest.fn().mockResolvedValue({ stock: 100 });
  const biFindMany = jest.fn().mockResolvedValue([]);
  const ensureDefaultVariantId = jest.fn((_tx: unknown, productId: string) =>
    Promise.resolve(variantOf(productId)),
  );

  const prisma = {
    branch: { findFirst: jest.fn().mockResolvedValue({ id: 'branch' }), updateMany: jest.fn(), update: jest.fn() },
    // Los `productId` llegan en la URL/body y ahora se validan contra el tenant
    // antes de tocar inventario. En estos tests todos son del tenant; el caso
    // del producto ajeno vive en el spec de aislamiento.
    product: {
      findFirst: jest.fn(({ where }: { where: { id: string } }) => Promise.resolve({ id: where.id })),
      findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(where.id.in.map((id) => ({ id }))),
      ),
    },
    branchInventory: { findUnique: biFindUnique, findMany: biFindMany, upsert: biUpsert, update: biUpdate },
    inventoryMovement: { create: invCreate },
    $transaction: jest.fn((arg: unknown) =>
      Array.isArray(arg)
        ? Promise.all(arg)
        : (arg as (tx: unknown) => Promise<unknown>)({
            branchInventory: { upsert: biUpsert },
            inventoryMovement: { create: invCreate },
          }),
    ),
  };

  const service = new BranchesService(
    prisma as never,
    { requireTenantId: () => TENANT } as never,
    { log: jest.fn() } as never,
    {} as never,
    {
      ensureDefaultVariantId,
      // Solo se usa cuando la línea nombra una variante explícita; devuelve el
      // mismo id tras comprobar la propiedad.
      assertVariantOfProduct: jest.fn((_tx: unknown, _p: string, _t: string, variantId: string) =>
        Promise.resolve(variantId),
      ),
    } as never,
  );

  return { service, invCreate, biUpsert, biUpdate, biFindUnique, biFindMany, ensureDefaultVariantId };
}

const movData = (m: jest.Mock, i = 0) => m.mock.calls[i][0].data;

describe('BranchesService — ledger de inventario (A0-01)', () => {
  describe('transferStock', () => {
    it('genera TRANSFER_OUT en origen y TRANSFER_IN en destino, enlazados por referenceId', async () => {
      const { service, invCreate, biUpdate, biUpsert } = build();
      await service.transferStock('A', { toBranchId: 'B', productId: 'p1', quantity: 5 });

      // El stock se mueve entre filas (sucursal, variante), no (sucursal, producto).
      expect(biUpdate).toHaveBeenCalledWith({
        where: { branchId_variantId: { branchId: 'A', variantId: 'v-p1' } },
        data: { stock: { decrement: 5 } },
      });
      expect(biUpsert).toHaveBeenCalledWith({
        where: { branchId_variantId: { branchId: 'B', variantId: 'v-p1' } },
        update: { stock: { increment: 5 } },
        create: { branchId: 'B', productId: 'p1', variantId: 'v-p1', stock: 5 },
      });

      expect(invCreate).toHaveBeenCalledTimes(2);
      const out = movData(invCreate, 0);
      const inn = movData(invCreate, 1);
      expect(out).toMatchObject({ type: 'TRANSFERENCIA', branchId: 'A', productId: 'p1', quantity: 5, referenceType: 'TRANSFER_OUT', tenantId: TENANT });
      expect(inn).toMatchObject({ type: 'TRANSFERENCIA', branchId: 'B', productId: 'p1', quantity: 5, referenceType: 'TRANSFER_IN', tenantId: TENANT });
      expect(out.referenceId).toBe(inn.referenceId); // mismo transferId
    });
  });

  describe('updateInventoryItem (ajuste manual)', () => {
    it('registra AJUSTE con el delta (nuevo - anterior)', async () => {
      const { service, invCreate, biFindUnique, biUpsert } = build();
      biFindUnique.mockResolvedValue({ stock: 8 });
      biUpsert.mockResolvedValue({ stock: 12 });

      await service.updateInventoryItem('branch', 'p1', 12);

      // El delta se calcula contra la fila de la variante default del producto.
      expect(biFindUnique).toHaveBeenCalledWith({
        where: { branchId_variantId: { branchId: 'branch', variantId: 'v-p1' } },
        select: { stock: true },
      });
      expect(biUpsert).toHaveBeenCalledWith({
        where: { branchId_variantId: { branchId: 'branch', variantId: 'v-p1' } },
        update: { stock: 12 },
        create: { branchId: 'branch', productId: 'p1', variantId: 'v-p1', stock: 12 },
      });

      expect(invCreate).toHaveBeenCalledTimes(1);
      expect(movData(invCreate)).toMatchObject({
        type: 'AJUSTE', branchId: 'branch', productId: 'p1', quantity: 4, referenceType: 'INVENTORY_ADJUST',
      });
    });

    it('delta 0 (sin cambio) no genera movimiento (sin duplicados/ruido)', async () => {
      const { service, invCreate, biFindUnique, biUpsert } = build();
      biFindUnique.mockResolvedValue({ stock: 5 });
      biUpsert.mockResolvedValue({ stock: 5 });

      await service.updateInventoryItem('branch', 'p1', 5);
      expect(invCreate).not.toHaveBeenCalled();
    });
  });

  describe('bulkUpdateInventory (conteo físico)', () => {
    it('genera un AJUSTE por cada diferencia; omite los items sin cambio', async () => {
      const { service, invCreate, biFindMany, biUpsert, ensureDefaultVariantId } = build();
      // La existencia previa se indexa por VARIANTE: un producto puede tener
      // varias filas en la misma sucursal, una por presentación contada.
      biFindMany.mockResolvedValue([
        { variantId: variantOf('p1'), stock: 10 },
        { variantId: variantOf('p2'), stock: 0 },
      ]);

      await service.bulkUpdateInventory('branch', {
        items: [
          { productId: 'p1', stock: 7 }, // delta -3
          { productId: 'p2', stock: 0 }, // delta 0 → sin movimiento
        ],
      });

      // Cada item del conteo se resuelve a su variante default antes del upsert.
      expect(ensureDefaultVariantId).toHaveBeenCalledTimes(2);
      expect(biUpsert).toHaveBeenCalledWith({
        where: { branchId_variantId: { branchId: 'branch', variantId: 'v-p1' } },
        update: { stock: 7 },
        create: { branchId: 'branch', productId: 'p1', variantId: 'v-p1', stock: 7 },
      });

      expect(invCreate).toHaveBeenCalledTimes(1);
      expect(movData(invCreate)).toMatchObject({
        type: 'AJUSTE', productId: 'p1', branchId: 'branch', quantity: -3, referenceType: 'INVENTORY_COUNT',
      });
    });

    it('item sin variante default resoluble → se omite del conteo (no rompe el lote)', async () => {
      const { service, invCreate, biFindMany, biUpsert, ensureDefaultVariantId } = build();
      biFindMany.mockResolvedValue([{ productId: 'p1', stock: 10 }]);
      ensureDefaultVariantId.mockResolvedValue(null as never);

      await service.bulkUpdateInventory('branch', { items: [{ productId: 'p1', stock: 7 }] });

      expect(biUpsert).not.toHaveBeenCalled();
      expect(invCreate).not.toHaveBeenCalled();
    });
  });
});
