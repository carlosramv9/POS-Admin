import { ProductsService } from './products.service';

/**
 * Regresión: la existencia inicial de un producto NO se replica por sucursal.
 *
 * `seedBranchInventory` crea una fila por cada sucursal activa para que la
 * variante sea vendible en todas. Los valores comerciales (precio, costo,
 * comparePrice, mínimo) se copian a todas a propósito: son los del producto.
 * La EXISTENCIA no: es una cantidad física que está en un sitio.
 *
 * Antes, sembrar la variante default sin valores capturados copiaba
 * `product.stock` en todas las sucursales activas, así que un alta con 10
 * unidades en un tenant de tres sucursales nacía con 30 — y `attachVariantStock`
 * las sumaba y las mostraba.
 */
describe('ProductsService.create — la existencia inicial no se replica por sucursal', () => {
  const TENANT = 't1';

  function build(options: { branches: string[]; contextBranchId?: string | null; mainBranchId?: string | null }) {
    const { branches, contextBranchId = null, mainBranchId = null } = options;
    const seeded: { branchId: string; variantId: string; stock: number; price: unknown; cost: unknown }[] = [];
    const createdVariants: { name: string | null; isDefault?: boolean }[] = [];

    const tx = {
      product: {
        create: jest.fn().mockResolvedValue({
          id: 'p1',
          tenantId: TENANT,
          stock: 10,
          price: 100,
          costPrice: 60,
          comparePrice: 120,
          lastCost: null,
          avgCost: null,
          lowStockAlert: 5,
          trackInventory: true,
        }),
        findUnique: jest.fn().mockResolvedValue({ id: 'p1', variants: [], branchInventory: [] }),
      },
      productVariant: {
        create: jest.fn(({ data }: { data: { name: string | null; isDefault?: boolean } }) => {
          createdVariants.push({ name: data.name, isDefault: data.isDefault });
          return Promise.resolve({ id: `v-${createdVariants.length}` });
        }),
      },
      productFeature: { createMany: jest.fn() },
      recipe: { create: jest.fn() },
      comboItem: { createMany: jest.fn() },
      branch: { findMany: jest.fn().mockResolvedValue(branches.map((id) => ({ id }))) },
      branchInventory: {
        createMany: jest.fn(({ data }: { data: typeof seeded }) => {
          seeded.push(...data);
          return Promise.resolve({ count: data.length });
        }),
      },
    };

    const prisma = {
      product: {
        findUnique: jest.fn().mockResolvedValue(null), // SKU libre
        findMany: jest.fn().mockResolvedValue([]), // sin slugs previos
      },
      $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
    };

    const service = new ProductsService(
      prisma as never,
      { requireTenantId: () => TENANT, getBranchId: () => contextBranchId ?? undefined } as never,
      { log: jest.fn() } as never,
      {} as never,
      { hasFeature: jest.fn().mockResolvedValue(false) } as never,
      {} as never,
      {
        resolveBranchId: jest
          .fn()
          .mockResolvedValue(contextBranchId ?? mainBranchId ?? null),
      } as never,
      { recordOutcome: jest.fn() } as never,
    );

    return { service, seeded, createdVariants };
  }

  const dto = { sku: 'SKU-1', name: 'Camisa', price: 100, stock: 10 };

  it('la existencia inicial aterriza en UNA sucursal; las demás arrancan en cero', async () => {
    const { service, seeded } = build({ branches: ['b1', 'b2', 'b3'], contextBranchId: 'b2' });

    await service.create(dto);

    expect(seeded).toHaveLength(3);
    expect(seeded.map((row) => ({ branchId: row.branchId, stock: row.stock }))).toEqual([
      { branchId: 'b1', stock: 0 },
      { branchId: 'b2', stock: 10 },
      { branchId: 'b3', stock: 0 },
    ]);
    // El total del producto es el capturado, no un múltiplo del nº de sucursales.
    expect(seeded.reduce((total, row) => total + row.stock, 0)).toBe(10);
  });

  it('sin sucursal en el token, la existencia va a la principal — no se pierde ni se replica', async () => {
    const { service, seeded } = build({
      branches: ['b1', 'b2'],
      contextBranchId: null,
      mainBranchId: 'b1',
    });

    await service.create(dto);

    expect(seeded.map((row) => ({ branchId: row.branchId, stock: row.stock }))).toEqual([
      { branchId: 'b1', stock: 10 },
      { branchId: 'b2', stock: 0 },
    ]);
  });

  it('los valores comerciales sí se copian a todas las sucursales: la variante es vendible en todas', async () => {
    const { service, seeded } = build({ branches: ['b1', 'b2'], contextBranchId: 'b1' });

    await service.create(dto);

    for (const row of seeded) {
      expect(row.price).toBe(100);
      expect(row.cost).toBe(60);
    }
  });

  /**
   * ADR-0030, regla 4, aplicada YA EN EL ALTA. El formulario movil captura las
   * presentaciones en el mismo paso que el producto, asi que el alta llega con
   * ellas: la primera nace SIENDO la variante, no al lado de una default vacia.
   * Crear las dos dejaba una linea fantasma sin nombre cargando existencia y
   * siendo la que el resolver elige por omision.
   */
  it('el alta con presentaciones no crea una default fantasma', async () => {
    const { service, seeded, createdVariants } = build({
      branches: ['b1', 'b2'],
      contextBranchId: 'b1',
    });

    await service.create({
      ...dto,
      stock: 10,
      variants: [
        { name: 'Talla M', price: 150, cost: 70, stock: 4 },
        { name: 'Talla L', price: 160, cost: 75, stock: 3 },
      ],
    });

    // Dos variantes, ambas con nombre, ninguna marcada como default.
    expect(createdVariants).toEqual([
      { name: 'Talla M', isDefault: false },
      { name: 'Talla L', isDefault: undefined },
    ]);

    // Cada una con SU existencia, y solo en la sucursal destino. El `stock: 10`
    // del producto se ignora: con presentaciones, lo inventariable son ellas.
    expect(
      seeded.map((row) => ({ branchId: row.branchId, variantId: row.variantId, stock: row.stock })),
    ).toEqual([
      { branchId: 'b1', variantId: 'v-1', stock: 4 },
      { branchId: 'b2', variantId: 'v-1', stock: 0 },
      { branchId: 'b1', variantId: 'v-2', stock: 3 },
      { branchId: 'b2', variantId: 'v-2', stock: 0 },
    ]);
    expect(seeded.reduce((total, row) => total + row.stock, 0)).toBe(7);
  });

  it('el alta SIN presentaciones si crea la default, con el stock del producto', async () => {
    const { service, createdVariants, seeded } = build({
      branches: ['b1'],
      contextBranchId: 'b1',
    });

    await service.create(dto);

    expect(createdVariants).toEqual([{ name: null, isDefault: true }]);
    expect(seeded).toEqual([expect.objectContaining({ branchId: 'b1', stock: 10 })]);
  });

  it('sin filas de inventario el stock es 0, no el espejo legacy del producto', async () => {
    // `branch_inventory` es la unica verdad. El respaldo sobre `products.stock`
    // existia para los tenants sin sucursal, que no tenian donde guardar la
    // existencia; la migracion 20260908120000 les creo la suya y sembro sus
    // filas, y las dos rutas de alta de tenant crean la suya desde el principio.
    const { service } = build({ branches: [] });

    const creado = (await service.create(dto)) as unknown as { stock: number };

    expect(creado.stock).toBe(0);
  });

  it('un tenant sin sucursales no siembra nada y el alta no revienta', async () => {
    const { service, seeded } = build({ branches: [] });

    await expect(service.create(dto as never)).resolves.toBeDefined();
    expect(seeded).toHaveLength(0);
  });
});
