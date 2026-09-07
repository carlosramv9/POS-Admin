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
    options: { branchId?: string | null; branches?: string[]; stockActual?: number } = {},
  ) {
    const { branchId = null, branches = [], stockActual } = options;
    const deleted: string[][] = [];
    const updated: { id: string; name: string | null; isDefault?: boolean }[] = [];
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
        update: jest.fn(
          ({ where, data }: { where: { id: string }; data: { name: string | null; isDefault?: boolean } }) => {
            updated.push({ id: where.id, name: data.name, isDefault: data.isDefault });
            return Promise.resolve({ id: where.id });
          },
        ),
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
        // Existencia actual de la fila (sucursal, variante) que lee la promocion.
        findUnique: jest.fn(() =>
          Promise.resolve(stockActual === undefined ? null : { stock: stockActual }),
        ),
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

    const engine = {
      applyProductStockDelta: jest.fn().mockResolvedValue({ applied: true, variantId: 'v', branchId: 'b' }),
      recordProductMovement: jest.fn().mockResolvedValue(undefined),
      getProductStock: jest.fn().mockResolvedValue(null),
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
      engine as never,
      // Sin sucursal en contexto no hay `isMain` que resolver en estos casos:
      // el resolver devuelve la que traiga el token, o null.
      { resolveBranchId: jest.fn().mockResolvedValue(branchId ?? null) } as never,
      { recordOutcome: jest.fn() } as never,
    );

    return { service, tx, engine, deleted, updated, created, seeded, repriced };
  }

  /**
   * Forma HEREDADA: default + presentacion conviviendo. Desde la promocion
   * (ADR-0030, regla 4) un producto con presentaciones ya no tiene default, pero
   * los productos configurados antes de ese cambio la conservan y su existencia
   * es real. Guardar no puede borrarla: se llevaria el stock por cascada.
   */
  it('un producto heredado con default y presentacion no pierde ninguna al guardar', async () => {
    const { service, deleted } = build([DEFAULT_VARIANT, TALLA_M]);

    await service.update('p1', { variants: [{ id: TALLA_M.id, name: 'Talla M' }] } as never);

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

  /**
   * ADR-0030, regla 4 - la default SE PROMUEVE, no se elimina ni se duplica.
   *
   * Antes, la primera presentacion se creaba al lado de la default y el producto
   * acababa con una linea fantasma que seguia cargando el stock y contra la que
   * descontaban todas las ventas.
   */
  describe('promocion de la variante default', () => {
    it('la primera presentacion renombra la default conservando su id', async () => {
      const { service, updated, created, deleted } = build([DEFAULT_VARIANT]);

      await service.update('p1', { variants: [{ name: 'Talla XL', price: 250, stock: 7 }] } as never);

      expect(updated).toEqual([{ id: DEFAULT_VARIANT.id, name: 'Talla XL', isDefault: false }]);
      // Ni se crea una variante nueva ni se borra la default: es la misma fila,
      // asi que conserva existencias en todas las sucursales e historial.
      expect(created).toEqual([]);
      expect(deleted).toEqual([]);
    });

    it('no siembra filas nuevas: la promovida reusa las de la default', async () => {
      const { service, seeded } = build([DEFAULT_VARIANT], {
        branchId: 'b-centro',
        branches: ['b-centro'],
      });

      await service.update('p1', { variants: [{ name: 'Talla XL' }] } as never);

      // La fila de existencias ya existe y se conserva con su historial: por eso
      // la promocion no pierde inventario.
      expect(seeded).toEqual([]);
    });

    it('la existencia capturada para la presentacion SI se aplica, con su AJUSTE', async () => {
      // Antes se ignoraba y la promovida se quedaba con la de la default: dar de
      // alta con 15 sueltos y dividir en 7 y 8 dejaba 15 y 8 —total 23— y el 7
      // escrito desaparecia sin decir nada.
      const { service, engine } = build([DEFAULT_VARIANT], {
        branchId: 'b-centro',
        branches: ['b-centro'],
        stockActual: 15,
      });

      await service.update('p1', { variants: [{ name: 'Glaseada', stock: 7 }] } as never);

      expect(engine.applyProductStockDelta).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ delta: -8, variantId: DEFAULT_VARIANT.id, branchId: 'b-centro' }),
      );
      // El ledger explica a donde fueron las otras 8.
      expect(engine.recordProductMovement).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          type: 'AJUSTE',
          referenceType: 'VARIANT_PROMOTION',
          quantity: -8,
          variantId: DEFAULT_VARIANT.id,
        }),
      );
    });

    it('sin existencia capturada no se toca el inventario', async () => {
      const { service, engine } = build([DEFAULT_VARIANT], {
        branchId: 'b-centro',
        branches: ['b-centro'],
        stockActual: 15,
      });

      await service.update('p1', { variants: [{ name: 'Glaseada' }] } as never);

      expect(engine.applyProductStockDelta).not.toHaveBeenCalled();
    });

    it('la segunda presentacion se agrega normal, sin promover nada', async () => {
      const { service, updated, created } = build([TALLA_M]);

      await service.update(
        'p1',
        { variants: [{ id: TALLA_M.id, name: 'Talla M' }, { name: 'Talla L' }] } as never,
      );

      expect(created).toEqual([{ name: 'Talla L' }]);
      expect(updated).toEqual([{ id: TALLA_M.id, name: 'Talla M', isDefault: undefined }]);
    });

    it('con varias presentaciones ya configuradas no se promueve ninguna', async () => {
      const { service, created } = build([TALLA_M, TALLA_L]);

      await service.update('p1', {
        variants: [
          { id: TALLA_M.id, name: 'Talla M' },
          { id: TALLA_L.id, name: 'Talla L' },
          { name: 'Talla XL' },
        ],
      } as never);

      expect(created).toEqual([{ name: 'Talla XL' }]);
    });

    it('una variante nueva sobre un producto con presentaciones siembra sus existencias', async () => {
      const { service, tx, created } = build([TALLA_M]);

      await service.update(
        'p1',
        { variants: [{ id: TALLA_M.id, name: 'Talla M' }, { name: 'Talla XL', stock: 7 }] } as never,
      );

      expect(created).toEqual([{ name: 'Talla XL' }]);
      expect(tx.branch.findMany).toHaveBeenCalled();
    });
  });

  /**
   * Precio y costo de una variante son SIEMPRE de una sucursal: viven en
   * `branch_inventory` por (sucursal, variante). Lo que se captura al guardar
   * pertenece a la sucursal en contexto —la del token— y no debe alcanzar a
   * ninguna otra sucursal ni, por supuesto, a otro tenant.
   */
  describe('los valores capturados solo alcanzan a la sucursal en contexto', () => {
    it('una variante nueva estrena su precio solo en la sucursal en contexto', async () => {
      // Con una presentacion ya configurada, la nueva se CREA (no promueve la
      // default, que en este producto ya fue promovida).
      const { service, seeded } = build([TALLA_M], {
        branchId: 'b-centro',
        branches: ['b-centro', 'b-norte'],
      });

      await service.update('p1', {
        variants: [
          { id: TALLA_M.id, name: 'Talla M' },
          { name: 'Talla XL', stock: 7, price: 250, cost: 100 },
        ],
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

  it('quitar todas las variantes con nombre nunca borra la default heredada', async () => {
    const { service, deleted } = build([DEFAULT_VARIANT, TALLA_M]);

    await service.update('p1', { variants: [] } as never);

    expect(deleted).toEqual([[TALLA_M.id]]);
    expect(deleted.flat()).not.toContain(DEFAULT_VARIANT.id);
  });

  /**
   * Camino inverso de la promocion. Todo producto tiene SIEMPRE exactamente una
   * variante: sin ella no es direccionable en el inventario y deja de ser
   * vendible, y borrarla arrastraria en cascada sus filas de existencias.
   */
  describe('degradacion de la ultima presentacion', () => {
    it('quitar la ultima la devuelve a default en vez de borrarla', async () => {
      const { service, updated, deleted } = build([TALLA_M]);

      await service.update('p1', { variants: [] } as never);

      expect(updated).toEqual([{ id: TALLA_M.id, name: null, isDefault: true }]);
      expect(deleted).toEqual([]);
    });

    it('quitar varias conserva una como default y borra el resto', async () => {
      const { service, updated, deleted } = build([TALLA_M, TALLA_L]);

      await service.update('p1', { variants: [] } as never);

      expect(updated).toEqual([{ id: TALLA_M.id, name: null, isDefault: true }]);
      expect(deleted).toEqual([[TALLA_L.id]]);
    });

    it('quitar una de dos no degrada nada: la otra sobrevive como presentacion', async () => {
      const { service, updated, deleted } = build([TALLA_M, TALLA_L]);

      await service.update('p1', { variants: [{ id: TALLA_M.id, name: 'Talla M' }] } as never);

      expect(deleted).toEqual([[TALLA_L.id]]);
      expect(updated).toEqual([{ id: TALLA_M.id, name: 'Talla M', isDefault: undefined }]);
    });
  });
});
