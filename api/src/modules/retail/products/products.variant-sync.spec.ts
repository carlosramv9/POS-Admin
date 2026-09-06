import { ProductsService } from './products.service';

/**
 * Regresión: guardar un producto NO debe borrar sus existencias.
 *
 * `branch_inventory` cuelga de `variantId` con borrado en cascada. La versión
 * anterior de `update` sincronizaba las variantes con un reemplazo completo
 * (`deleteMany` + `createMany`), así que cada vez que alguien guardaba un
 * producto desde el formulario se llevaba por delante el inventario de TODAS
 * sus sucursales — y las variantes reaparecían con ids nuevos.
 *
 * La sincronización ahora es por id: se conserva la variante default (que nunca
 * viaja en el DTO por ser interna) y las que traen id, y solo se eliminan las
 * que el usuario realmente quitó.
 */
describe('ProductsService.update — sincronización de variantes sin pérdida de inventario', () => {
  const DEFAULT_VARIANT = { id: 'v-default', isDefault: true };
  const TALLA_M = { id: 'v-talla-m', isDefault: false };
  const TALLA_L = { id: 'v-talla-l', isDefault: false };

  function build(
    existing: { id: string; isDefault: boolean }[],
    options: { branchId?: string | null; branches?: string[] } = {},
  ) {
    const { branchId = null, branches = [] } = options;
    const deleted: string[][] = [];
    const updated: { id: string; name: string }[] = [];
    const created: { name: string }[] = [];
    const seeded: { branchId: string; variantId: string; stock: number; price: unknown; cost: unknown }[] = [];
    const repriced: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];

    const tx = {
      product: {
        findUnique: jest.fn().mockResolvedValue({ id: 'p1', variants: [] }),
        update: jest.fn().mockResolvedValue({ id: 'p1' }),
      },
      productVariant: {
        findMany: jest.fn().mockResolvedValue(existing),
        update: jest.fn(({ where, data }: { where: { id: string }; data: { name: string } }) => {
          updated.push({ id: where.id, name: data.name });
          return Promise.resolve({ id: where.id });
        }),
        create: jest.fn(({ data }: { data: { name: string } }) => {
          created.push({ name: data.name });
          return Promise.resolve({ id: `v-nueva-${created.length}` });
        }),
        deleteMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) => {
          deleted.push(where.id.in);
          return Promise.resolve({ count: where.id.in.length });
        }),
      },
      productFeature: { deleteMany: jest.fn(), createMany: jest.fn() },
      branch: { findMany: jest.fn().mockResolvedValue(branches.map((id) => ({ id }))) },
      branchInventory: {
        createMany: jest.fn(({ data }: { data: typeof seeded }) => {
          seeded.push(...data);
          return Promise.resolve({ count: data.length });
        }),
        updateMany: jest.fn((args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          repriced.push(args);
          return Promise.resolve({ count: 1 });
        }),
      },
      recipe: { deleteMany: jest.fn(), create: jest.fn() },
      comboItem: { deleteMany: jest.fn(), createMany: jest.fn() },
    };

    const prisma = {
      product: { findFirst: jest.fn().mockResolvedValue({ id: 'p1', type: 'SIMPLE', tenantId: 't1' }) },
      $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
    };

    const service = new ProductsService(
      prisma as never,
      { requireTenantId: () => 't1', getBranchId: () => branchId ?? undefined } as never,
      { log: jest.fn() } as never,
      {} as never,
      { assertRecipesEnabled: jest.fn() } as never,
      {} as never,
      // Sin sucursal en contexto no hay `isMain` que resolver en estos casos:
      // el resolver devuelve la que traiga el token, o null.
      { resolveBranchId: jest.fn().mockResolvedValue(branchId ?? null) } as never,
      { recordOutcome: jest.fn() } as never,
    );

    return { service, tx, deleted, updated, created, seeded, repriced };
  }

  it('conserva la variante default aunque el DTO no la mencione', async () => {
    const { service, deleted } = build([DEFAULT_VARIANT, TALLA_M]);

    await service.update('p1', { variants: [{ id: TALLA_M.id, name: 'Talla M' }] } as never);

    // Nada se borra: la default se preserva por ser interna, Talla M por venir con id.
    expect(deleted).toEqual([]);
  });

  it('actualiza en sitio la variante existente en vez de recrearla', async () => {
    const { service, updated, created } = build([DEFAULT_VARIANT, TALLA_M]);

    await service.update('p1', { variants: [{ id: TALLA_M.id, name: 'Talla M (renombrada)' }] } as never);

    expect(updated).toEqual([{ id: 'v-talla-m', name: 'Talla M (renombrada)' }]);
    expect(created).toEqual([]);
  });

  it('elimina únicamente las variantes que el usuario quitó', async () => {
    const { service, deleted } = build([DEFAULT_VARIANT, TALLA_M, TALLA_L]);

    // El usuario dejó solo Talla M: se va Talla L, la default se queda.
    await service.update('p1', { variants: [{ id: TALLA_M.id, name: 'Talla M' }] } as never);

    expect(deleted).toEqual([[TALLA_L.id]]);
  });

  it('una variante nueva (sin id) se crea y siembra sus existencias', async () => {
    const { service, tx, created, deleted } = build([DEFAULT_VARIANT]);

    await service.update('p1', { variants: [{ name: 'Talla XL', stock: 7 }] } as never);

    expect(created).toEqual([{ name: 'Talla XL' }]);
    expect(deleted).toEqual([]);
    // El sembrado consulta las sucursales activas del tenant.
    expect(tx.branch.findMany).toHaveBeenCalled();
  });

  /**
   * Precio y costo de una variante son SIEMPRE de una sucursal: viven en
   * `branch_inventory` por (sucursal, variante). Lo que se captura al guardar
   * pertenece a la sucursal en contexto —la del token— y no debe alcanzar a
   * ninguna otra sucursal ni, por supuesto, a otro tenant.
   */
  describe('los valores capturados solo alcanzan a la sucursal en contexto', () => {
    it('una variante nueva estrena su precio solo en la sucursal en contexto', async () => {
      const { service, seeded } = build([DEFAULT_VARIANT], {
        branchId: 'b-centro',
        branches: ['b-centro', 'b-norte'],
      });

      await service.update('p1', {
        variants: [{ name: 'Talla XL', stock: 7, price: 250, cost: 100 }],
      } as never);

      // La sucursal en contexto recibe lo capturado…
      expect(seeded).toContainEqual(
        expect.objectContaining({ branchId: 'b-centro', stock: 7, price: 250, cost: 100 }),
      );
      // …y la otra nace vendible, pero con los valores del producto y en 0.
      const otra = seeded.find((row) => row.branchId === 'b-norte');
      expect(otra).toMatchObject({ stock: 0 });
      expect(otra?.price).not.toBe(250);
    });

    it('editar el precio de una variante existente escribe una sola sucursal', async () => {
      const { service, repriced } = build([DEFAULT_VARIANT, TALLA_M], {
        branchId: 'b-centro',
        branches: ['b-centro', 'b-norte'],
      });

      await service.update('p1', {
        variants: [{ id: TALLA_M.id, name: 'Talla M', price: 199, cost: 80 }],
      } as never);

      expect(repriced).toHaveLength(1);
      expect(repriced[0].where).toEqual({ variantId: TALLA_M.id, branchId: 'b-centro', productId: 'p1' });
      expect(repriced[0].data).toEqual({ price: 199, cost: 80 });
    });

    it('sin sucursal en contexto no se escribe ningún precio', async () => {
      const { service, repriced, updated } = build([DEFAULT_VARIANT, TALLA_M], {
        branches: ['b-centro', 'b-norte'],
      });

      await service.update('p1', {
        variants: [{ id: TALLA_M.id, name: 'Talla M', price: 199 }],
      } as never);

      // Renombrar sigue funcionando; el precio no se propaga a ciegas.
      expect(updated).toEqual([{ id: TALLA_M.id, name: 'Talla M' }]);
      expect(repriced).toEqual([]);
    });

    it('la existencia de una variante existente nunca se pisa al guardar', async () => {
      const { service, repriced, seeded } = build([DEFAULT_VARIANT, TALLA_M], {
        branchId: 'b-centro',
        branches: ['b-centro'],
      });

      // El formulario manda un stock para una variante que ya existe: se ignora
      // — la existencia se mueve por movimientos de inventario.
      await service.update('p1', {
        variants: [{ id: TALLA_M.id, name: 'Talla M', stock: 999, price: 199 }],
      } as never);

      expect(seeded).toEqual([]);
      expect(repriced[0].data).not.toHaveProperty('stock');
    });
  });

  it('quitar todas las variantes con nombre nunca borra la default', async () => {
    const { service, deleted } = build([DEFAULT_VARIANT, TALLA_M]);

    await service.update('p1', { variants: [] } as never);

    expect(deleted).toEqual([[TALLA_M.id]]);
    expect(deleted.flat()).not.toContain(DEFAULT_VARIANT.id);
  });
});
