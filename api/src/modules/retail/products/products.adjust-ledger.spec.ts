import { ProductsService } from './products.service';

/**
 * A0-02 / Fase 2A — products.updateStock (ajuste manual) delega stock y
 * movimiento al InventoryEngine.
 *
 * El comportamiento observable es idéntico al previo: mismo stock final, mismo
 * movimiento AJUSTE (mismos campos), y ningún movimiento cuando el delta es 0.
 * Estos tests fijan que el servicio invoque al engine con los argumentos exactos.
 */

const TENANT = 'tenant-1';

function build(prev: number) {
  const applyProductStockDelta = jest.fn().mockResolvedValue(true);
  const recordProductMovement = jest.fn().mockResolvedValue(undefined);
  const engine = { applyProductStockDelta, recordProductMovement };

  // El readback dentro de la transacción devuelve el producto ya actualizado.
  const findFirstOrThrow = jest.fn().mockResolvedValue({ id: 'p1', stock: prev });

  const prisma = {
    product: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'p1', type: 'SIMPLE', trackInventory: true, stock: prev,
      }),
    },
    $transaction: jest.fn((cb: (tx: unknown) => unknown) =>
      cb({ product: { findFirstOrThrow } }),
    ),
  };

  const service = new ProductsService(
    prisma as never,
    { requireTenantId: () => TENANT, getBranchId: () => null } as never,
    { log: jest.fn() } as never,
    { upload: jest.fn(), delete: jest.fn(), buildKey: () => 'k' } as never,
    { hasFeature: jest.fn().mockResolvedValue(false) } as never,
    engine as never,
    { resolveBranchId: jest.fn().mockResolvedValue(null) } as never,
    { recordOutcome: jest.fn().mockResolvedValue(undefined) } as never,
  );

  return { service, applyProductStockDelta, recordProductMovement, findFirstOrThrow };
}

describe('ProductsService.updateStock — delegación al InventoryEngine (Fase 2A)', () => {
  it('alta (+5): aplica delta +5, emite AJUSTE +5 y devuelve el stock final', async () => {
    const { service, applyProductStockDelta, recordProductMovement, findFirstOrThrow } = build(10);
    findFirstOrThrow.mockResolvedValue({ id: 'p1', stock: 15 });

    const result = await service.updateStock('p1', 5);

    // Un alta no necesita guard: solo las bajas pueden dejar el stock negativo.
    expect(applyProductStockDelta).toHaveBeenCalledWith(expect.anything(), {
      productId: 'p1', tenantId: TENANT, delta: 5, guardInsufficient: false, branchId: null,
    });
    expect(recordProductMovement).toHaveBeenCalledTimes(1);
    expect(recordProductMovement.mock.calls[0][1]).toMatchObject({
      tenantId: TENANT,
      type: 'AJUSTE',
      productId: 'p1',
      quantity: 5,
      referenceId: 'p1',
      referenceType: 'PRODUCT_ADJUST',
      notes: 'Ajuste manual (+5)',
    });
    expect(result.stock).toBe(15);
  });

  it('baja (-3): aplica delta -3 y emite AJUSTE -3', async () => {
    const { service, applyProductStockDelta, recordProductMovement } = build(10);

    await service.updateStock('p1', -3);

    // La baja sí lo pide: el guard contra stock negativo lo aplica la base
    // dentro de la transacción, no una comprobación previa en JS.
    expect(applyProductStockDelta).toHaveBeenCalledWith(expect.anything(), {
      productId: 'p1', tenantId: TENANT, delta: -3, guardInsufficient: true, branchId: null,
    });
    expect(recordProductMovement.mock.calls[0][1]).toMatchObject({
      type: 'AJUSTE', quantity: -3, notes: 'Ajuste manual (-3)',
    });
  });

  it('delta 0: aplica delta 0 pero NO emite movimiento', async () => {
    const { service, applyProductStockDelta, recordProductMovement } = build(10);

    await service.updateStock('p1', 0);

    expect(applyProductStockDelta).toHaveBeenCalledWith(expect.anything(), {
      productId: 'p1', tenantId: TENANT, delta: 0, guardInsufficient: false, branchId: null,
    });
    expect(recordProductMovement).not.toHaveBeenCalled();
  });
});
