import { InventoryConsumptionEngine } from './inventory-consumption.engine';
import { InventoryEngine } from './inventory.engine';
import { VariantInventoryResolver } from './variant-inventory.resolver';

/**
 * Aislamiento de tenant en el motor de consumo de inventario.
 *
 * `resolveEffects` expande cada línea de venta resolviendo productos por id
 * (`loadProduct`) y luego descuenta stock (`consume`). Ninguno de los dos pasos
 * acotaba la consulta al tenant del contexto, que sí viaja en `InventoryContext`
 * y se usa para escribir los movimientos.
 *
 * Era el segundo eslabón del problema descrito en
 * `products.tenant-isolation.spec.ts`: si un `childProductId` ajeno llegaba a
 * persistirse en un combo, al vender ese combo se descontaba stock de otro
 * tenant.
 *
 * El engine se construye con sus colaboradores REALES (`InventoryEngine` +
 * `VariantInventoryResolver`) y solo se simula el cliente Prisma: el fallo vivía
 * repartido entre los tres, así que un doble del engine de bajo nivel no habría
 * podido demostrarlo.
 */
describe('InventoryConsumptionEngine — aislamiento de tenant', () => {
  const TENANT = 'tenant-1';
  const FOREIGN_PRODUCT_ID = 'producto-de-otro-tenant';
  const OWN_PRODUCT_ID = 'producto-propio';

  let engine: InventoryConsumptionEngine;

  const ctx = {
    tenantId: TENANT,
    branchId: null,
    userId: 'user-1',
    referenceId: 'order-1',
  };

  /**
   * Cliente Prisma simulado.
   *
   * `owned` decide si el producto pertenece a `TENANT`: `findFirst` es la
   * consulta acotada (devuelve null cuando es ajeno) y `findUnique` la que el
   * motor usaba antes, que lo devolvía siempre. Sin variante default ni sucursal
   * principal, el stock cae a la ruta legacy sobre `Product.stock`, que es donde
   * se observa el `updateMany`.
   */
  function buildTx(opts: { owned: boolean }) {
    const product = {
      id: opts.owned ? OWN_PRODUCT_ID : FOREIGN_PRODUCT_ID,
      name: opts.owned ? 'Producto propio' : 'Producto ajeno',
      type: 'SIMPLE',
      trackInventory: true,
      stock: 100,
      recipe: null,
      comboItems: [],
    };

    return {
      product: {
        findFirst: jest.fn().mockResolvedValue(opts.owned ? product : null),
        findUnique: jest.fn().mockResolvedValue(product),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue(product),
      },
      productVariant: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      branch: { findFirst: jest.fn().mockResolvedValue(null) },
      branchInventory: {
        findUnique: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn(),
      },
      supply: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      supplyMovement: { create: jest.fn().mockResolvedValue({}) },
      inventoryMovement: { create: jest.fn().mockResolvedValue({}) },
    } as any;
  }

  const lineFor = (productId: string) => [
    { productId, quantity: 2, itemType: 'PRODUCT' as const },
  ];

  beforeEach(() => {
    engine = new InventoryConsumptionEngine(new InventoryEngine(new VariantInventoryResolver()));
  });

  it('la resolución del producto está acotada al tenant del contexto', async () => {
    const tx = buildTx({ owned: false });

    await engine.consume(tx, lineFor(FOREIGN_PRODUCT_ID), ctx).catch(() => undefined);

    const calls = [
      ...tx.product.findUnique.mock.calls,
      ...tx.product.findFirst.mock.calls,
    ];
    const scoped = calls.some(([args]: [any]) => args?.where?.tenantId === TENANT);

    expect(scoped).toBe(true);
  });

  it('el descuento de stock está acotado al tenant del contexto', async () => {
    const tx = buildTx({ owned: true });

    await engine.consume(tx, lineFor(OWN_PRODUCT_ID), ctx).catch(() => undefined);

    expect(tx.product.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT }),
      }),
    );
  });

  it('no descuenta stock de un producto que no pertenece al tenant', async () => {
    const tx = buildTx({ owned: false });

    await expect(engine.consume(tx, lineFor(FOREIGN_PRODUCT_ID), ctx)).rejects.toThrow();
    expect(tx.product.updateMany).not.toHaveBeenCalled();
  });

  it('un childProductId ajeno dentro de un combo propio también se rechaza', async () => {
    const tx = buildTx({ owned: true });
    // El combo es propio; su hijo no. `findFirst` devuelve el combo la primera
    // vez y null al resolver el hijo, que es justo el caso explotable.
    tx.product.findFirst
      .mockResolvedValueOnce({
        id: OWN_PRODUCT_ID,
        name: 'Combo propio',
        type: 'COMBO',
        trackInventory: false,
        stock: 0,
        recipe: null,
        comboItems: [{ childProductId: FOREIGN_PRODUCT_ID, quantity: 1 }],
      })
      .mockResolvedValueOnce(null);

    await expect(engine.consume(tx, lineFor(OWN_PRODUCT_ID), ctx)).rejects.toThrow();
    expect(tx.product.updateMany).not.toHaveBeenCalled();
  });

  it('el consumo de insumos de una receta está acotado al tenant', async () => {
    const tx = buildTx({ owned: true });
    tx.product.findFirst.mockResolvedValue({
      id: OWN_PRODUCT_ID,
      name: 'Platillo',
      type: 'RECIPE',
      trackInventory: false,
      stock: 0,
      recipe: {
        items: [
          {
            supplyId: 'insumo-1',
            quantity: 1,
            unit: 'kg',
            normalizedQuantity: 1,
            supply: { id: 'insumo-1', name: 'Insumo', unit: 'kg', stock: 10, baseUnit: null },
          },
        ],
      },
      comboItems: [],
    });

    await engine.consume(tx, lineFor(OWN_PRODUCT_ID), ctx).catch(() => undefined);

    expect(tx.supply.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT }),
      }),
    );
  });
});
