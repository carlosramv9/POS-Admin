import { BranchesService } from './branches.service';

/**
 * Regresión: una sucursal nueva nace con su catálogo, en cero.
 *
 * Antes `create` insertaba la sucursal y nada más. Sin filas en
 * `branch_inventory`, la pantalla de inventario de la sucursal salía vacía y la
 * primera venta o compra creaba la fila sobre la marcha — sembrándola con
 * `products.stock`, el espejo legacy que es la suma de TODAS las variantes de
 * TODAS las sucursales. Abrir una sucursal multiplicaba el inventario.
 *
 * Ahora se siembra explícitamente: una fila por variante, existencia CERO y los
 * valores comerciales del producto. Abrir una sucursal no crea mercancía.
 */
const TENANT = 'tenant-1';

function build(variants: { id: string; productId: string }[]) {
  const createMany = jest.fn().mockResolvedValue({ count: variants.length });

  const prisma = {
    branch: {
      findUnique: jest.fn().mockResolvedValue(null), // código libre
      updateMany: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: 'b-nueva', name: 'Centro' }),
    },
    productVariant: {
      findMany: jest.fn().mockResolvedValue(
        variants.map((v) => ({
          id: v.id,
          productId: v.productId,
          product: {
            price: 100,
            costPrice: 60,
            comparePrice: 120,
            lastCost: 58,
            avgCost: 59,
            lowStockAlert: 3,
          },
        })),
      ),
    },
    branchInventory: { createMany },
  };

  const service = new BranchesService(
    prisma as never,
    { requireTenantId: () => TENANT } as never,
    { log: jest.fn() } as never,
    { assertCanAddBranch: jest.fn() } as never,
    {} as never,
  );

  return { service, prisma, createMany };
}

const dto = { code: 'CEN', name: 'Centro' };

describe('BranchesService.create — siembra del catálogo en la sucursal nueva', () => {
  it('crea una fila por variante, toda en cero', async () => {
    const { service, createMany } = build([
      { id: 'v-default-p1', productId: 'p1' },
      { id: 'v-talla-m', productId: 'p1' },
      { id: 'v-default-p2', productId: 'p2' },
    ]);

    await service.create(dto);

    const rows = createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(3);
    expect(rows.map((r: { variantId: string; stock: number }) => [r.variantId, r.stock])).toEqual([
      ['v-default-p1', 0],
      ['v-talla-m', 0],
      ['v-default-p2', 0],
    ]);
    for (const row of rows) {
      expect(row.branchId).toBe('b-nueva');
    }
  });

  it('hereda los valores comerciales del producto, para que sea vendible desde el día uno', async () => {
    const { service, createMany } = build([{ id: 'v-default-p1', productId: 'p1' }]);

    await service.create(dto);

    expect(createMany.mock.calls[0][0].data[0]).toMatchObject({
      productId: 'p1',
      price: 100,
      cost: 60,
      comparePrice: 120,
      lowStockAlert: 3,
    });
  });

  it('solo mira las variantes de ESTE tenant', async () => {
    const { service, prisma } = build([{ id: 'v-default-p1', productId: 'p1' }]);

    await service.create(dto);

    expect(prisma.productVariant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { product: { tenantId: TENANT } } }),
    );
  });

  it('un tenant sin productos no siembra nada y el alta no revienta', async () => {
    const { service, createMany } = build([]);

    await expect(service.create(dto as never)).resolves.toMatchObject({ id: 'b-nueva' });
    expect(createMany).not.toHaveBeenCalled();
  });
});
