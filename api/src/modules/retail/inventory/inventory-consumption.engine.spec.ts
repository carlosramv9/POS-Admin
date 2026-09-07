import { BadRequestException } from '@nestjs/common';
import { InventoryConsumptionEngine, InventoryContext } from './inventory-consumption.engine';
import { InventoryEngine } from './inventory.engine';
import { VariantInventoryResolver } from './variant-inventory.resolver';

/**
 * Unit tests for the universal inventory engine. A hand-rolled fake transaction
 * client records every write so we can assert WHAT moved and prove symmetry
 * (consume vs restore) across SIMPLE / RECIPE / COMBO trees.
 *
 * Stock now lives on `branch_inventory` keyed by (branchId, variantId), so the
 * fake models those rows too: the default variant of a product `p` is `v-p`, and
 * `Product.stock` is only the mirror the engine keeps in sync.
 */

interface FakeProduct {
  id: string;
  name: string;
  type: 'SIMPLE' | 'RECIPE' | 'COMBO' | 'SERVICE';
  trackInventory: boolean;
  stock: number;
  recipe: { items: FakeRecipeItem[] } | null;
  comboItems: { childProductId: string; quantity: number }[];
}

interface FakeRecipeItem {
  supplyId: string;
  quantity: number;
  unit: string;
  normalizedQuantity: number | null;
  supply: {
    id: string;
    name: string;
    unit: string;
    stock: number;
    baseUnit: { symbol: string } | null;
  };
}

const CTX: InventoryContext = {
  tenantId: 'tenant-1',
  branchId: 'branch-1',
  userId: 'user-1',
  referenceId: 'order-1',
  referenceType: 'ORDER',
};

/** Variante default de un producto: la línea implícita "el producto en sí". */
const variantOf = (productId: string) => `v-${productId}`;

function makeTx(
  products: Record<string, FakeProduct>,
  supplyStock: Record<string, number>,
  opts: {
    branchRows?: Set<string>;
    /** Sucursal `isMain` del tenant. `null` = tenant sin sucursales. */
    mainBranchId?: string | null;
    /** false = ningún producto tiene variante default (camino legacy). */
    defaultVariants?: boolean;
  } = {},
) {
  const productStock: Record<string, number> = {};
  for (const p of Object.values(products)) productStock[p.id] = p.stock;
  // Productos que YA tienen fila en branch_inventory (al nivel del stock global).
  // Por defecto todos, salvo que el caso pruebe el sembrado (create) de una fila
  // inexistente.
  const preexisting = opts.branchRows ?? new Set(Object.keys(products));
  const mainBranchId = opts.mainBranchId === undefined ? 'branch-main' : opts.mainBranchId;
  const hasDefaultVariant = opts.defaultVariants !== false;

  const productOfVariant = (variantId: string) => variantId.slice('v-'.length);
  const rowKey = (branchId: string, variantId: string) => `${branchId}:${variantId}`;

  /** Filas de branch_inventory: "branchId:variantId" → stock. */
  const rows = new Map<string, number>();
  /** Nivel de la fila, materializándola si el caso la declaró preexistente. */
  const rowStock = (branchId: string, variantId: string): number | null => {
    const k = rowKey(branchId, variantId);
    if (rows.has(k)) return rows.get(k) as number;
    const productId = productOfVariant(variantId);
    if (preexisting.has(productId)) {
      rows.set(k, productStock[productId]);
      return rows.get(k) as number;
    }
    return null;
  };

  const calls = {
    productUpdateMany: [] as { id: string; increment: number }[],
    productUpdate: [] as { id: string; increment: number }[],
    supplyUpdateMany: [] as { id: string; decrement: number }[],
    supplyUpdate: [] as { id: string; increment: number }[],
    inventoryMovements: [] as { type: string; productId: string; quantity: number; referenceId: string; referenceType: string }[],
    supplyMovements: [] as { type: string; supplyId: string; quantity: number; referenceId: string }[],
    branchInventory: [] as { branchId: string; variantId: string; increment: number }[],
    branchInventoryCreate: [] as { productId: string; variantId: string; branchId: string; stock: number }[],
  };

  const tx = {
    product: {
      findUnique: jest.fn(({ where, select }: { where: { id: string }; select: Record<string, unknown> }) => {
        const p = products[where.id];
        if (!p) return Promise.resolve(null);
        const keys = select ? Object.keys(select) : [];
        // El resolver pide solo el tenant dueño para ubicar la sucursal isMain.
        if (keys.length === 1 && keys[0] === 'tenantId') {
          return Promise.resolve({ tenantId: CTX.tenantId });
        }
        if (keys.length === 1 && keys[0] === 'stock') {
          return Promise.resolve({ stock: productStock[p.id] });
        }
        // Valores comerciales con los que se siembra la fila de sucursal.
        if (keys.includes('lowStockAlert')) {
          return Promise.resolve({
            stock: productStock[p.id], price: 0, costPrice: 0,
            comparePrice: null, lastCost: null, avgCost: null, lowStockAlert: 5,
          });
        }
        return Promise.resolve(p);
      }),
      // Igual que en `supply`: el espejo sobre `Product.stock` pasó de `update` a
      // `updateMany` al incorporar `tenantId` al filtro. Sin guard (`stock.gte`)
      // se comporta como el `update` de antes y se registra como tal, para que
      // las aserciones de simetría sigan hablando del mismo concepto.
      updateMany: jest.fn(({ where, data }: { where: { id: string; stock?: { gte: number } }; data: { stock: number | { increment: number } } }) => {
        if (typeof data.stock === 'number') {
          productStock[where.id] = data.stock;
          calls.productUpdateMany.push({ id: where.id, increment: 0 });
          return Promise.resolve({ count: 1 });
        }
        const inc = data.stock.increment;
        if (!where.stock) {
          productStock[where.id] = (productStock[where.id] ?? 0) + inc;
          calls.productUpdate.push({ id: where.id, increment: inc });
          return Promise.resolve({ count: 1 });
        }
        if (productStock[where.id] >= where.stock.gte) {
          productStock[where.id] += inc;
          calls.productUpdateMany.push({ id: where.id, increment: inc });
          return Promise.resolve({ count: 1 });
        }
        return Promise.resolve({ count: 0 });
      }),
      update: jest.fn(({ where, data }: { where: { id: string }; data: { stock: { increment: number } } }) => {
        productStock[where.id] += data.stock.increment;
        calls.productUpdate.push({ id: where.id, increment: data.stock.increment });
        return Promise.resolve({});
      }),
    },
    productVariant: {
      findFirst: jest.fn(({ where }: { where: { productId: string } }) =>
        Promise.resolve(hasDefaultVariant ? { id: variantOf(where.productId) } : null),
      ),
      // Resolucion por omision: la UNICA variante del producto.
      findMany: jest.fn(({ where }: { where: { productId: string } }) =>
        Promise.resolve(hasDefaultVariant ? [{ id: variantOf(where.productId) }] : []),
      ),
    },
    branch: {
      findFirst: jest.fn(() => Promise.resolve(mainBranchId ? { id: mainBranchId } : null)),
    },
    supply: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve({ stock: supplyStock[where.id] ?? 0 }),
      ),
      // Sirve a los dos usos: el consumo (guard `stock.gte` + `decrement`) y la
      // reversa, que pasó de `update` a `updateMany` porque su filtro ahora
      // lleva `tenantId` y deja de ser la clave única.
      updateMany: jest.fn(({ where, data }: { where: { id: string; stock?: { gte: number } }; data: { stock: { decrement?: number; increment?: number } } }) => {
        if (data.stock.increment != null) {
          supplyStock[where.id] = (supplyStock[where.id] ?? 0) + data.stock.increment;
          calls.supplyUpdate.push({ id: where.id, increment: data.stock.increment });
          return Promise.resolve({ count: 1 });
        }
        const dec = data.stock.decrement ?? 0;
        if (!where.stock || (supplyStock[where.id] ?? 0) >= where.stock.gte) {
          supplyStock[where.id] -= dec;
          calls.supplyUpdateMany.push({ id: where.id, decrement: dec });
          return Promise.resolve({ count: 1 });
        }
        return Promise.resolve({ count: 0 });
      }),
      update: jest.fn(({ where, data }: { where: { id: string }; data: { stock: { increment: number } } }) => {
        supplyStock[where.id] = (supplyStock[where.id] ?? 0) + data.stock.increment;
        calls.supplyUpdate.push({ id: where.id, increment: data.stock.increment });
        return Promise.resolve({});
      }),
    },
    branchInventory: {
      findUnique: jest.fn(({ where }: { where: { branchId_variantId: { branchId: string; variantId: string } } }) => {
        const { branchId, variantId } = where.branchId_variantId;
        const stock = rowStock(branchId, variantId);
        return Promise.resolve(stock === null ? null : { branchId, stock });
      }),
      updateMany: jest.fn(({ where, data }: { where: { branchId: string; variantId: string; stock?: { gte: number } }; data: { stock: number | { increment: number } } }) => {
        const stock = rowStock(where.branchId, where.variantId);
        if (stock === null) return Promise.resolve({ count: 0 });
        // Guard contra sobreventa: la fila de la sucursal manda.
        if (where.stock && stock < where.stock.gte) return Promise.resolve({ count: 0 });
        if (typeof data.stock === 'number') {
          rows.set(rowKey(where.branchId, where.variantId), data.stock);
          return Promise.resolve({ count: 1 });
        }
        rows.set(rowKey(where.branchId, where.variantId), stock + data.stock.increment);
        calls.branchInventory.push({
          branchId: where.branchId, variantId: where.variantId, increment: data.stock.increment,
        });
        return Promise.resolve({ count: 1 });
      }),
      create: jest.fn(({ data }: { data: { branchId: string; productId: string; variantId: string; stock: number } }) => {
        rows.set(rowKey(data.branchId, data.variantId), data.stock);
        calls.branchInventoryCreate.push({
          productId: data.productId, variantId: data.variantId, branchId: data.branchId, stock: data.stock,
        });
        return Promise.resolve({});
      }),
    },
    inventoryMovement: {
      create: jest.fn(({ data }: { data: { type: string; productId: string; quantity: number; referenceId: string; referenceType: string } }) => {
        calls.inventoryMovements.push({
          type: data.type, productId: data.productId, quantity: data.quantity,
          referenceId: data.referenceId, referenceType: data.referenceType,
        });
        return Promise.resolve({});
      }),
    },
    supplyMovement: {
      create: jest.fn(({ data }: { data: { type: string; supplyId: string; quantity: number; referenceId: string } }) => {
        calls.supplyMovements.push({
          type: data.type, supplyId: data.supplyId, quantity: data.quantity, referenceId: data.referenceId,
        });
        return Promise.resolve({});
      }),
    },
  };

  // El motor lee los productos e insumos ACOTADOS AL TENANT (`findFirst`),
  // no por id suelto. El doble delega en la misma implementación: lo que estos
  // tests fijan es el movimiento de stock, y el aislamiento tiene su propio
  // spec (`inventory-consumption.tenant-isolation.spec.ts`).
  (tx.product as any).findFirst = tx.product.findUnique;
  if ((tx as any).supply?.findUnique) (tx as any).supply.findFirst = (tx as any).supply.findUnique;


  return { tx, calls, productStock, supplyStock, rows, rowKey };
}

const simple = (id: string, stock = 100, trackInventory = true): FakeProduct => ({
  id, name: id, type: 'SIMPLE', trackInventory, stock, recipe: null, comboItems: [],
});

const recipe = (id: string, items: FakeRecipeItem[]): FakeProduct => ({
  id, name: id, type: 'RECIPE', trackInventory: false, stock: 0, recipe: { items }, comboItems: [],
});

const supplyItem = (supplyId: string, qty: number): FakeRecipeItem => ({
  supplyId, quantity: qty, unit: 'g', normalizedQuantity: qty,
  supply: { id: supplyId, name: supplyId, unit: 'g', stock: 0, baseUnit: null },
});

describe('InventoryConsumptionEngine', () => {
  let engine: InventoryConsumptionEngine;

  beforeEach(() => {
    // Real collaborators: the branch/variant resolution and the mirror write are
    // part of the behaviour under test, not incidental dependencies.
    engine = new InventoryConsumptionEngine(new InventoryEngine(new VariantInventoryResolver()));
  });

  describe('SIMPLE', () => {
    it('consume decrements the default variant branch row and logs a VENTA movement', async () => {
      const { tx, calls, productStock, rows } = makeTx({ p1: simple('p1', 10) }, {});
      await engine.consume(tx as never, [{ productId: 'p1', quantity: 3, itemType: 'PRODUCT' }], CTX);

      // Source of truth: the (branch, default variant) row.
      expect(rows.get('branch-1:v-p1')).toBe(7);
      // Mirror: Product.stock is kept in sync during the expand phase. The
      // decrement is guarded so the mirror can never end up negative.
      expect(productStock.p1).toBe(7);
      expect(calls.productUpdateMany).toEqual([{ id: 'p1', increment: -3 }]);
      expect(calls.inventoryMovements).toHaveLength(1);
      expect(calls.inventoryMovements[0]).toMatchObject({
        type: 'VENTA', productId: 'p1', quantity: 3, referenceType: 'ORDER', referenceId: 'order-1',
      });
    });

    it('skips products with trackInventory = false', async () => {
      const { tx, calls } = makeTx({ p1: simple('p1', 10, false) }, {});
      await engine.consume(tx as never, [{ productId: 'p1', quantity: 3, itemType: 'PRODUCT' }], CTX);

      expect(calls.productUpdateMany).toHaveLength(0);
      expect(calls.productUpdate).toHaveLength(0);
      expect(calls.branchInventory).toHaveLength(0);
      expect(calls.inventoryMovements).toHaveLength(0);
    });

    it('throws on insufficient stock', async () => {
      const { tx, calls, productStock } = makeTx({ p1: simple('p1', 2) }, {});
      await expect(
        engine.consume(tx as never, [{ productId: 'p1', quantity: 5, itemType: 'PRODUCT' }], CTX),
      ).rejects.toBeInstanceOf(BadRequestException);
      // The guard rejects before the mirror write: nothing moved.
      expect(calls.productUpdate).toHaveLength(0);
      expect(productStock.p1).toBe(2);
    });

    it('ignores SERVICE lines and null products', async () => {
      const { tx, calls } = makeTx({ p1: simple('p1', 10) }, {});
      await engine.consume(
        tx as never,
        [
          { productId: null, quantity: 1, itemType: 'SERVICE' },
          { productId: 'svc', quantity: 1, itemType: 'SERVICE' },
        ],
        CTX,
      );
      expect(calls.productUpdateMany).toHaveLength(0);
      expect(calls.productUpdate).toHaveLength(0);
      expect(calls.branchInventory).toHaveLength(0);
    });
  });

  describe('RECIPE', () => {
    it('consume decrements supplies, not product stock', async () => {
      const products = { r1: recipe('r1', [supplyItem('s1', 5), supplyItem('s2', 2)]) };
      const { tx, calls, supplyStock } = makeTx(products, { s1: 100, s2: 100 });
      await engine.consume(tx as never, [{ productId: 'r1', quantity: 3, itemType: 'PRODUCT' }], CTX);

      expect(supplyStock.s1).toBe(85); // 100 - 5*3
      expect(supplyStock.s2).toBe(94); // 100 - 2*3
      expect(calls.supplyMovements.map((m) => m.type)).toEqual(['RECIPE_CONSUMPTION', 'RECIPE_CONSUMPTION']);
      expect(calls.productUpdateMany).toHaveLength(0);
      expect(calls.productUpdate).toHaveLength(0);
      expect(calls.branchInventory).toHaveLength(0);
    });
  });

  describe('COMBO', () => {
    it('expands children: SIMPLE child decrements stock, RECIPE child consumes supplies', async () => {
      const products = {
        combo: { id: 'combo', name: 'combo', type: 'COMBO' as const, trackInventory: false, stock: 0, recipe: null,
          comboItems: [ { childProductId: 'p1', quantity: 2 }, { childProductId: 'r1', quantity: 1 } ] },
        p1: simple('p1', 50),
        r1: recipe('r1', [supplyItem('s1', 4)]),
      };
      const { tx, productStock, supplyStock, rows } = makeTx(products, { s1: 100 });
      await engine.consume(tx as never, [{ productId: 'combo', quantity: 3, itemType: 'PRODUCT' }], CTX);

      expect(rows.get('branch-1:v-p1')).toBe(50 - 2 * 3); // child qty 2 × order qty 3
      expect(productStock.p1).toBe(50 - 2 * 3);           // espejo
      expect(supplyStock.s1).toBe(100 - 4 * 1 * 3); // recipe needs 4 × comboQty 1 × order 3
    });
  });

  describe('BranchInventory', () => {
    it('decrements the row of the default variant, not one keyed by product', async () => {
      const { tx, calls } = makeTx({ p1: simple('p1', 10) }, {});
      await engine.consume(tx as never, [{ productId: 'p1', quantity: 4, itemType: 'PRODUCT' }], CTX);
      // Delta negativo = salida de stock de la sucursal por la venta.
      expect(calls.branchInventory).toEqual([
        { branchId: 'branch-1', variantId: 'v-p1', increment: -4 },
      ]);
      expect(calls.branchInventoryCreate).toHaveLength(0); // ya existía la fila
    });

    it('seeds the branch row at zero before applying the delta', async () => {
      // Sin fila previa: el engine la siembra ANTES de aplicar el delta (si no,
      // el updateMany afectaría 0 filas y la venta se perdería en silencio),
      // pero en CERO — no con el stock global, que es la suma de todas las
      // variantes de todas las sucursales. Con la fila en cero la venta no tiene
      // de dónde descontar y se rechaza, que es el resultado correcto.
      const { tx, calls, rows } = makeTx({ p1: simple('p1', 25) }, {}, { branchRows: new Set() });
      await expect(
        engine.consume(tx as never, [{ productId: 'p1', quantity: 2, itemType: 'PRODUCT' }], CTX),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(calls.branchInventoryCreate).toEqual([
        { productId: 'p1', variantId: 'v-p1', branchId: 'branch-1', stock: 0 },
      ]);
      expect(rows.get('branch-1:v-p1')).toBe(0);
    });

    it('falls back to the tenant main branch when the context has no branch', async () => {
      const { tx, calls } = makeTx({ p1: simple('p1', 10) }, {});
      await engine.consume(
        tx as never,
        [{ productId: 'p1', quantity: 3, itemType: 'PRODUCT' }],
        { ...CTX, branchId: null },
      );
      expect(tx.branch.findFirst).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-1', isMain: true },
        select: { id: true },
      });
      expect(calls.branchInventory).toEqual([
        { branchId: 'branch-main', variantId: 'v-p1', increment: -3 },
      ]);
    });

    it('COMBO applies branch deltas only to SIMPLE leaves (not virtual parents)', async () => {
      const products = {
        combo: { id: 'combo', name: 'combo', type: 'COMBO' as const, trackInventory: false, stock: 0, recipe: null,
          comboItems: [{ childProductId: 'p1', quantity: 2 }, { childProductId: 'r1', quantity: 1 }] },
        p1: simple('p1', 50),
        r1: recipe('r1', [supplyItem('s1', 4)]),
      };
      const { tx, calls } = makeTx(products, { s1: 100 });
      await engine.consume(tx as never, [{ productId: 'combo', quantity: 3, itemType: 'PRODUCT' }], CTX);
      // Solo la hoja SIMPLE p1 mueve branch inventory; combo/r1 (virtuales) no.
      expect(calls.branchInventory).toEqual([
        { branchId: 'branch-1', variantId: 'v-p1', increment: -6 },
      ]);
    });
  });

  describe('legacy fallback (producto no direccionable por variante/sucursal)', () => {
    it('producto sin variante default → guard y descuento sobre Product.stock', async () => {
      const { tx, calls, productStock } = makeTx(
        { p1: simple('p1', 10) }, {}, { defaultVariants: false },
      );
      await engine.consume(tx as never, [{ productId: 'p1', quantity: 3, itemType: 'PRODUCT' }], CTX);

      expect(calls.productUpdateMany).toEqual([{ id: 'p1', increment: -3 }]);
      expect(productStock.p1).toBe(7);
      // Nada se escribe en branch_inventory: no hay fila a la que apuntar.
      expect(calls.branchInventory).toHaveLength(0);
      expect(calls.branchInventoryCreate).toHaveLength(0);
    });

    it('tenant sin sucursales y contexto sin sucursal → Product.stock sigue siendo autoritativo', async () => {
      const { tx, calls, productStock } = makeTx(
        { p1: simple('p1', 2) }, {}, { mainBranchId: null },
      );
      // El guard legacy sigue rechazando la sobreventa.
      await expect(
        engine.consume(
          tx as never,
          [{ productId: 'p1', quantity: 5, itemType: 'PRODUCT' }],
          { ...CTX, branchId: null },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(productStock.p1).toBe(2);
      expect(calls.branchInventory).toHaveLength(0);
    });
  });

  describe('restore() — devoluciones', () => {
    it('SIMPLE: incrementa stock y registra movimiento DEVOLUCION (mismo referenceId)', async () => {
      const { tx, calls, productStock, rows } = makeTx({ p1: simple('p1', 10) }, {});
      await engine.restore(tx as never, [{ productId: 'p1', quantity: 3, itemType: 'PRODUCT' }], CTX);

      expect(rows.get('branch-1:v-p1')).toBe(13); // 10 + 3 reingresado en la sucursal
      expect(productStock.p1).toBe(13);           // espejo
      expect(calls.inventoryMovements).toHaveLength(1);
      expect(calls.inventoryMovements[0]).toMatchObject({
        type: 'DEVOLUCION', productId: 'p1', quantity: 3, referenceType: 'ORDER', referenceId: 'order-1',
      });
      // La devolución también revierte el stock de la sucursal (delta positivo).
      expect(calls.branchInventory).toEqual([
        { branchId: 'branch-1', variantId: 'v-p1', increment: 3 },
      ]);
    });

    it('RECIPE: reingresa insumos y registra SupplyMovement ADJUSTMENT', async () => {
      const products = { r1: recipe('r1', [supplyItem('s1', 5)]) };
      const { tx, calls, supplyStock } = makeTx(products, { s1: 100 });
      await engine.restore(tx as never, [{ productId: 'r1', quantity: 2, itemType: 'PRODUCT' }], CTX);

      expect(supplyStock.s1).toBe(110); // 100 + 5*2
      expect(calls.supplyMovements).toHaveLength(1);
      expect(calls.supplyMovements[0]).toMatchObject({ type: 'ADJUSTMENT', supplyId: 's1', quantity: 10, referenceId: 'order-1' });
    });

    it('COMBO con RECIPE: la reversa expande hijos y reingresa los insumos de la receta', async () => {
      const products = {
        combo: { id: 'combo', name: 'combo', type: 'COMBO' as const, trackInventory: false, stock: 0, recipe: null,
          comboItems: [{ childProductId: 'p1', quantity: 2 }, { childProductId: 'r1', quantity: 1 }] },
        p1: simple('p1', 50),
        r1: recipe('r1', [supplyItem('s1', 4)]),
      };
      const { tx, calls, productStock, supplyStock, rows } = makeTx(products, { s1: 100 });
      await engine.restore(tx as never, [{ productId: 'combo', quantity: 3, itemType: 'PRODUCT' }], CTX);

      expect(rows.get('branch-1:v-p1')).toBe(50 + 2 * 3); // hoja SIMPLE reingresada
      expect(productStock.p1).toBe(50 + 2 * 3);     // espejo
      expect(supplyStock.s1).toBe(100 + 4 * 1 * 3); // insumo de la receta reingresado
      expect(calls.inventoryMovements.every((m) => m.type === 'DEVOLUCION')).toBe(true);
      expect(calls.supplyMovements.every((m) => m.type === 'ADJUSTMENT')).toBe(true);
    });
  });

  describe('symmetry: consume then restore returns to the original state', () => {
    it('SIMPLE + RECIPE + COMBO net to zero', async () => {
      const products = {
        combo: { id: 'combo', name: 'combo', type: 'COMBO' as const, trackInventory: false, stock: 0, recipe: null,
          comboItems: [ { childProductId: 'p1', quantity: 2 }, { childProductId: 'r1', quantity: 1 } ] },
        p1: simple('p1', 50),
        p2: simple('p2', 30),
        r1: recipe('r1', [supplyItem('s1', 4), supplyItem('s2', 1)]),
      };
      const { tx, productStock, supplyStock, rows } = makeTx(products, { s1: 100, s2: 80 });
      const lines = [
        { productId: 'combo', quantity: 3, itemType: 'PRODUCT' as const },
        { productId: 'p2', quantity: 5, itemType: 'PRODUCT' as const },
      ];

      const p1Before = productStock.p1, p2Before = productStock.p2;
      const s1Before = supplyStock.s1, s2Before = supplyStock.s2;

      await engine.consume(tx as never, lines, CTX);
      await engine.restore(tx as never, lines, CTX);

      expect(productStock.p1).toBe(p1Before);
      expect(productStock.p2).toBe(p2Before);
      expect(supplyStock.s1).toBe(s1Before);
      expect(supplyStock.s2).toBe(s2Before);
      // Las filas de sucursal — la fuente de verdad — también vuelven al inicio.
      expect(rows.get('branch-1:v-p1')).toBe(p1Before);
      expect(rows.get('branch-1:v-p2')).toBe(p2Before);
    });

    it('simetría TOTAL: producto + insumo + branchInventory + movimientos balancean tras venta + reversa', async () => {
      const products = {
        combo: { id: 'combo', name: 'combo', type: 'COMBO' as const, trackInventory: false, stock: 0, recipe: null,
          comboItems: [{ childProductId: 'p1', quantity: 2 }, { childProductId: 'r1', quantity: 1 }] },
        p1: simple('p1', 50),  // SIMPLE (también hoja del combo)
        p2: simple('p2', 30),  // SIMPLE suelto
        r1: recipe('r1', [supplyItem('s1', 4), supplyItem('s2', 1)]), // RECIPE (suelta y dentro del combo)
      };
      const { tx, calls, productStock, supplyStock, rows } = makeTx(products, { s1: 100, s2: 80 });
      const lines = [
        { productId: 'combo', quantity: 3, itemType: 'PRODUCT' as const }, // COMBO con RECIPE
        { productId: 'p2', quantity: 5, itemType: 'PRODUCT' as const },     // SIMPLE
        { productId: 'r1', quantity: 2, itemType: 'PRODUCT' as const },     // RECIPE
      ];

      const snapshot = () => ({ ...productStock });
      const supplySnap = () => ({ ...supplyStock });
      const rowSnap = () => Object.fromEntries(rows);
      const before = snapshot();
      const beforeSupply = supplySnap();

      await engine.consume(tx as never, lines, CTX);
      const afterConsume = rowSnap();
      await engine.restore(tx as never, lines, CTX);

      // 1) Stock de productos (espejo) vuelve al inicial.
      expect(snapshot()).toEqual(before);
      // 2) Stock de insumos vuelve al inicial.
      expect(supplySnap()).toEqual(beforeSupply);

      // 3) branchInventory: la suma de deltas por variante es 0 (salida + reingreso)
      //    y las filas quedan por encima del nivel post-venta.
      const branchNet = new Map<string, number>();
      for (const b of calls.branchInventory) branchNet.set(b.variantId, (branchNet.get(b.variantId) ?? 0) + b.increment);
      for (const [, net] of branchNet) expect(net).toBe(0);
      expect(rows.get('branch-1:v-p1')).toBe(afterConsume['branch-1:v-p1'] + 6);

      // 4) InventoryMovement: por producto, total VENTA == total DEVOLUCION.
      const sumBy = (type: string, key: 'productId') =>
        calls.inventoryMovements.filter((m) => m.type === type)
          .reduce((acc, m) => { acc[m[key]] = (acc[m[key]] ?? 0) + m.quantity; return acc; }, {} as Record<string, number>);
      expect(sumBy('VENTA', 'productId')).toEqual(sumBy('DEVOLUCION', 'productId'));

      // 5) SupplyMovement: por insumo, total RECIPE_CONSUMPTION == total ADJUSTMENT.
      const sumSupply = (type: string) =>
        calls.supplyMovements.filter((m) => m.type === type)
          .reduce((acc, m) => { acc[m.supplyId] = (acc[m.supplyId] ?? 0) + m.quantity; return acc; }, {} as Record<string, number>);
      expect(sumSupply('RECIPE_CONSUMPTION')).toEqual(sumSupply('ADJUSTMENT'));
    });

    it('never increments the stock of virtual RECIPE / COMBO parents (no ghost stock)', async () => {
      const products = {
        combo: { id: 'combo', name: 'combo', type: 'COMBO' as const, trackInventory: false, stock: 0, recipe: null,
          comboItems: [{ childProductId: 'r1', quantity: 1 }] },
        r1: recipe('r1', [supplyItem('s1', 4)]),
      };
      const { tx, calls, productStock, rows } = makeTx(products, { s1: 100 });
      const lines = [{ productId: 'combo', quantity: 2, itemType: 'PRODUCT' as const }];

      await engine.consume(tx as never, lines, CTX);
      await engine.restore(tx as never, lines, CTX);

      // Virtual parents keep stock 0 and are never written to.
      expect(productStock.combo).toBe(0);
      expect(productStock.r1).toBe(0);
      expect(calls.productUpdate.find((c) => c.id === 'combo' || c.id === 'r1')).toBeUndefined();
      // Ni siquiera se les siembra o mueve una fila de sucursal.
      expect(calls.branchInventory).toHaveLength(0);
      expect(calls.branchInventoryCreate).toHaveLength(0);
      expect(rows.size).toBe(0);
      // Only the supply round-trips back to its original level. Se afirma sobre
      // el reingreso registrado, no sobre el método de Prisma: la reversa pasó a
      // `updateMany` al llevar `tenantId` en el filtro.
      expect(calls.supplyUpdate).toContainEqual({ id: 's1', increment: 8 });
    });
  });
});
