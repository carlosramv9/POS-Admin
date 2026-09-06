import { BadRequestException } from '@nestjs/common';
import { InventoryConsumptionEngine, InventoryContext } from './inventory-consumption.engine';
import { InventoryEngine } from './inventory.engine';
import { VariantInventoryResolver } from './variant-inventory.resolver';

/**
 * P1-04 — BranchInventory nunca queda negativo.
 *
 * Fake de transacción que SÍ modela el nivel de stock por (sucursal, variante) y
 * el guard `stock: { gte }`, para probar el decremento acotado y el clamp a 0.
 * Tras la migración a inventario por variante, la fila de la sucursal es la
 * fuente de verdad: ahí vive el guard contra sobreventa y `Product.stock` queda
 * como espejo.
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
  supply: { id: string; name: string; unit: string; stock: number; baseUnit: { symbol: string } | null };
}

const simple = (id: string, stock = 100): FakeProduct => ({
  id, name: id, type: 'SIMPLE', trackInventory: true, stock, recipe: null, comboItems: [],
});
const recipe = (id: string, items: FakeRecipeItem[]): FakeProduct => ({
  id, name: id, type: 'RECIPE', trackInventory: false, stock: 0, recipe: { items }, comboItems: [],
});
const supplyItem = (supplyId: string, qty: number): FakeRecipeItem => ({
  supplyId, quantity: qty, unit: 'g', normalizedQuantity: qty,
  supply: { id: supplyId, name: supplyId, unit: 'g', stock: 0, baseUnit: null },
});

/** Variante default del producto: la línea implícita "el producto en sí". */
const variantOf = (productId: string) => `v-${productId}`;

/**
 * `branchStocks`: nivel inicial por "branchId:variantId" (filas existentes).
 * Filas no listadas no existen → se siembran desde el stock global del producto.
 */
function makeTx(
  products: Record<string, FakeProduct>,
  supplyStock: Record<string, number>,
  branchStocks: Record<string, number>,
  opts: { defaultVariants?: boolean; mainBranchId?: string | null } = {},
) {
  const productStock: Record<string, number> = {};
  for (const p of Object.values(products)) productStock[p.id] = p.stock;
  const rows = new Map<string, number>(Object.entries(branchStocks));
  const key = (b: string, v: string) => `${b}:${v}`;
  const calls = { branchCreate: [] as { key: string; stock: number }[] };
  const hasDefaultVariant = opts.defaultVariants !== false;
  const mainBranchId = opts.mainBranchId === undefined ? 'b-main' : opts.mainBranchId;

  const tx = {
    product: {
      findUnique: jest.fn(({ where, select }: { where: { id: string }; select?: Record<string, unknown> }) => {
        const p = products[where.id];
        if (!p) return Promise.resolve(null);
        const keys = select ? Object.keys(select) : [];
        // El resolver solo necesita el tenant dueño para ubicar la sucursal isMain.
        if (keys.length === 1 && keys[0] === 'tenantId') return Promise.resolve({ tenantId: 'tenant-1' });
        if (keys.length === 1 && keys[0] === 'stock') return Promise.resolve({ stock: productStock[p.id] });
        // Valores comerciales con los que se siembra la fila de sucursal.
        if (keys.includes('lowStockAlert')) {
          return Promise.resolve({
            stock: productStock[p.id], price: 0, costPrice: 0,
            comparePrice: null, lastCost: null, avgCost: null, lowStockAlert: 5,
          });
        }
        return Promise.resolve(p);
      }),
      // Acepta las dos formas que usa el engine: la baja guardada
      // (`stock: { gte }` + `increment`) y el recorte a 0 (`stock: 0`, sin guard).
      updateMany: jest.fn(({ where, data }: { where: { id: string; stock?: { gte: number } }; data: { stock: number | { increment: number } } }) => {
        if (where.stock && productStock[where.id] < where.stock.gte) {
          return Promise.resolve({ count: 0 });
        }
        productStock[where.id] =
          typeof data.stock === 'number' ? data.stock : productStock[where.id] + data.stock.increment;
        return Promise.resolve({ count: 1 });
      }),
      update: jest.fn(({ where, data }: { where: { id: string }; data: { stock: { increment: number } } }) => {
        productStock[where.id] += data.stock.increment;
        return Promise.resolve({});
      }),
    },
    productVariant: {
      findFirst: jest.fn(({ where }: { where: { productId: string } }) =>
        Promise.resolve(hasDefaultVariant ? { id: variantOf(where.productId) } : null),
      ),
    },
    branch: {
      findFirst: jest.fn(() => Promise.resolve(mainBranchId ? { id: mainBranchId } : null)),
    },
    supply: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) => Promise.resolve({ stock: supplyStock[where.id] ?? 0 })),
      updateMany: jest.fn(({ where, data }: { where: { id: string; stock: { gte: number } }; data: { stock: { decrement: number } } }) => {
        if ((supplyStock[where.id] ?? 0) >= where.stock.gte) {
          supplyStock[where.id] -= data.stock.decrement;
          return Promise.resolve({ count: 1 });
        }
        return Promise.resolve({ count: 0 });
      }),
      update: jest.fn(({ where, data }: { where: { id: string }; data: { stock: { increment: number } } }) => {
        supplyStock[where.id] = (supplyStock[where.id] ?? 0) + data.stock.increment;
        return Promise.resolve({});
      }),
    },
    branchInventory: {
      findUnique: jest.fn(({ where }: { where: { branchId_variantId: { branchId: string; variantId: string } } }) => {
        const { branchId, variantId } = where.branchId_variantId;
        const k = key(branchId, variantId);
        return Promise.resolve(rows.has(k) ? { branchId, stock: rows.get(k) } : null);
      }),
      updateMany: jest.fn(
        ({ where, data }: { where: { branchId: string; variantId: string; stock?: { gte: number } }; data: { stock: number | { increment: number } } }) => {
          const k = key(where.branchId, where.variantId);
          if (!rows.has(k)) return Promise.resolve({ count: 0 });
          // Guarded decrement: solo si la fila tiene suficiente.
          if (where.stock && typeof where.stock.gte === 'number') {
            if ((rows.get(k) ?? 0) >= where.stock.gte) {
              rows.set(k, (rows.get(k) ?? 0) + (data.stock as { increment: number }).increment);
              return Promise.resolve({ count: 1 });
            }
            return Promise.resolve({ count: 0 });
          }
          // Clamp: data.stock es número (0).
          if (typeof data.stock === 'number') {
            rows.set(k, data.stock);
            return Promise.resolve({ count: 1 });
          }
          // Incremento (restore).
          rows.set(k, (rows.get(k) ?? 0) + data.stock.increment);
          return Promise.resolve({ count: 1 });
        },
      ),
      create: jest.fn(({ data }: { data: { branchId: string; productId: string; variantId: string; stock: number } }) => {
        rows.set(key(data.branchId, data.variantId), data.stock);
        calls.branchCreate.push({ key: key(data.branchId, data.variantId), stock: data.stock });
        return Promise.resolve({});
      }),
    },
    inventoryMovement: { create: jest.fn(() => Promise.resolve({})) },
    supplyMovement: { create: jest.fn(() => Promise.resolve({})) },
  };

  // El motor lee los productos e insumos ACOTADOS AL TENANT (`findFirst`),
  // no por id suelto. El doble delega en la misma implementación: lo que estos
  // tests fijan es el movimiento de stock, y el aislamiento tiene su propio
  // spec (`inventory-consumption.tenant-isolation.spec.ts`).
  (tx.product as any).findFirst = tx.product.findUnique;
  if ((tx as any).supply?.findUnique) (tx as any).supply.findFirst = (tx as any).supply.findUnique;


  return { tx, rows, productStock, supplyStock, calls, key };
}

const ctx = (branchId: string | null): InventoryContext => ({
  tenantId: 'tenant-1', branchId, userId: 'user-1', referenceId: 'order-1', referenceType: 'ORDER',
});

describe('InventoryConsumptionEngine — BranchInventory no negativo (P1-04)', () => {
  it('venta normal: branch con suficiente → decrementa sin negativo', async () => {
    const { tx, rows } = makeTx({ p1: simple('p1', 100) }, {}, { 'b1:v-p1': 10 });
    await engine().consume(tx as never, [{ productId: 'p1', quantity: 4, itemType: 'PRODUCT' }], ctx('b1'));
    expect(rows.get('b1:v-p1')).toBe(6);
  });

  it('branch exacto (= cantidad): queda en 0, nunca negativo', async () => {
    const { tx, rows } = makeTx({ p1: simple('p1', 100) }, {}, { 'b1:v-p1': 5 });
    await engine().consume(tx as never, [{ productId: 'p1', quantity: 5, itemType: 'PRODUCT' }], ctx('b1'));
    expect(rows.get('b1:v-p1')).toBe(0);
  });

  it('branch insuficiente: la venta se rechaza y la fila no queda negativa', async () => {
    // El guard ahora vive en la fila de (sucursal, variante): sobrevender la
    // sucursal ya no se "arregla" con clamp, se rechaza de raíz.
    const { tx, rows, productStock } = makeTx({ p1: simple('p1', 25) }, {}, { 'b1:v-p1': 2 });
    await expect(
      engine().consume(tx as never, [{ productId: 'p1', quantity: 5, itemType: 'PRODUCT' }], ctx('b1')),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(rows.get('b1:v-p1')).toBe(2);   // intacta, jamás negativa
    expect(rows.get('b1:v-p1')).toBeGreaterThanOrEqual(0);
    expect(productStock.p1).toBe(25);      // el espejo tampoco se movió
  });

  it('fila de sucursal suficiente: la venta procede y el espejo global se recorta a 0', async () => {
    // Fuente de verdad = fila de sucursal, así que la venta procede aunque el
    // global legacy esté desfasado por debajo. El espejo se recorta a 0 en vez
    // de quedar negativo: `Product.stock` todavía se muestra en varias pantallas
    // durante la fase expand y un negativo ahí sería visiblemente incorrecto.
    const { tx, rows, productStock } = makeTx({ p1: simple('p1', 2) }, {}, { 'b1:v-p1': 10 });
    await engine().consume(tx as never, [{ productId: 'p1', quantity: 5, itemType: 'PRODUCT' }], ctx('b1'));
    expect(rows.get('b1:v-p1')).toBe(5);
    expect(rows.get('b1:v-p1')).toBeGreaterThanOrEqual(0);
    expect(productStock.p1).toBe(0);
  });

  it('sin fila previa: la siembra en CERO, así que la venta no procede', async () => {
    // Que no exista fila significa que en esta sucursal nunca hubo existencia de
    // esta variante — no que tenga las 25 del espejo legacy, que es la suma de
    // todas las variantes de todas las sucursales. Sembrar desde el global
    // multiplicaba el inventario en cada combinación nueva (sucursal recién
    // creada, variante recién añadida) y dejaba vender mercancía inexistente.
    const { tx, rows, calls } = makeTx({ p1: simple('p1', 25) }, {}, {});
    await expect(
      engine().consume(tx as never, [{ productId: 'p1', quantity: 2, itemType: 'PRODUCT' }], ctx('b1')),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(calls.branchCreate).toEqual([{ key: 'b1:v-p1', stock: 0 }]);
    expect(rows.get('b1:v-p1')).toBe(0);
  });

  it('sin fila previa: una entrada (restore) la siembra en cero y suma encima', async () => {
    const { tx, rows, calls } = makeTx({ p1: simple('p1', 25) }, {}, {});
    await engine().restore(tx as never, [{ productId: 'p1', quantity: 4, itemType: 'PRODUCT' }], ctx('b1'));
    expect(calls.branchCreate).toEqual([{ key: 'b1:v-p1', stock: 0 }]);
    expect(rows.get('b1:v-p1')).toBe(4);
  });

  it('restore completo: reingresa al branch (venta normal round-trip simétrico)', async () => {
    const { tx, rows } = makeTx({ p1: simple('p1', 100) }, {}, { 'b1:v-p1': 10 });
    const line = [{ productId: 'p1', quantity: 4, itemType: 'PRODUCT' as const }];
    await engine().consume(tx as never, line, ctx('b1'));
    await engine().restore(tx as never, line, ctx('b1'));
    expect(rows.get('b1:v-p1')).toBe(10); // 10 → 6 → 10
  });

  it('refund parcial: reingresa solo lo devuelto', async () => {
    const { tx, rows } = makeTx({ p1: simple('p1', 100) }, {}, { 'b1:v-p1': 10 });
    await engine().consume(tx as never, [{ productId: 'p1', quantity: 5, itemType: 'PRODUCT' }], ctx('b1'));
    await engine().restore(tx as never, [{ productId: 'p1', quantity: 2, itemType: 'PRODUCT' }], ctx('b1'));
    expect(rows.get('b1:v-p1')).toBe(7); // 10 → 5 → 7
  });

  it('cancelación (restore total) tras venta normal vuelve al inicio', async () => {
    const { tx, rows } = makeTx({ p1: simple('p1', 100), p2: simple('p2', 100) }, {}, { 'b1:v-p1': 8, 'b1:v-p2': 3 });
    const lines = [
      { productId: 'p1', quantity: 3, itemType: 'PRODUCT' as const },
      { productId: 'p2', quantity: 1, itemType: 'PRODUCT' as const },
    ];
    await engine().consume(tx as never, lines, ctx('b1'));
    await engine().restore(tx as never, lines, ctx('b1'));
    expect(rows.get('b1:v-p1')).toBe(8);
    expect(rows.get('b1:v-p2')).toBe(3);
  });

  it('COMBO: solo las hojas SIMPLE mueven branch; nunca negativo', async () => {
    const products = {
      combo: { id: 'combo', name: 'combo', type: 'COMBO' as const, trackInventory: false, stock: 0, recipe: null,
        comboItems: [{ childProductId: 'p1', quantity: 2 }, { childProductId: 'r1', quantity: 1 }] },
      p1: simple('p1', 100),
      r1: recipe('r1', [supplyItem('s1', 4)]),
    };
    const { tx, rows } = makeTx(products, { s1: 100 }, { 'b1:v-p1': 10 });
    await engine().consume(tx as never, [{ productId: 'combo', quantity: 3, itemType: 'PRODUCT' }], ctx('b1'));
    expect(rows.get('b1:v-p1')).toBe(4); // 10 - 2*3
    expect(rows.has('b1:v-combo')).toBe(false);
    expect(rows.has('b1:v-r1')).toBe(false);
  });

  it('RECIPE: no toca branchInventory (consume insumos)', async () => {
    const { tx, rows, supplyStock } = makeTx({ r1: recipe('r1', [supplyItem('s1', 5)]) }, { s1: 100 }, {});
    await engine().consume(tx as never, [{ productId: 'r1', quantity: 2, itemType: 'PRODUCT' }], ctx('b1'));
    expect(rows.size).toBe(0);
    expect(supplyStock.s1).toBe(90);
  });

  it('múltiples sucursales: el consumo en B1 no afecta a B2', async () => {
    const { tx, rows } = makeTx({ p1: simple('p1', 100) }, {}, { 'b1:v-p1': 10, 'b2:v-p1': 7 });
    await engine().consume(tx as never, [{ productId: 'p1', quantity: 4, itemType: 'PRODUCT' }], ctx('b1'));
    expect(rows.get('b1:v-p1')).toBe(6);
    expect(rows.get('b2:v-p1')).toBe(7); // intacta
  });

  it('producto sin variante default: no se crea fila y manda Product.stock (legacy)', async () => {
    const { tx, rows, calls, productStock } = makeTx(
      { p1: simple('p1', 25) }, {}, {}, { defaultVariants: false },
    );
    await engine().consume(tx as never, [{ productId: 'p1', quantity: 4, itemType: 'PRODUCT' }], ctx('b1'));
    expect(rows.size).toBe(0);
    expect(calls.branchCreate).toHaveLength(0);
    expect(productStock.p1).toBe(21); // guard y descuento sobre el stock global
  });
});

describe('InventoryEngine.applyBranchInventoryDelta — clamp a 0 (P1-04)', () => {
  it('fila insuficiente → se fija en 0, nunca negativa', async () => {
    // Este primitivo (usado por ajustes/transferencias, no por la venta) sí acota:
    // la venta ya trae su propio guard, así que aquí el peor caso es dejar la fila
    // en 0 en vez de escribir un número negativo.
    const { tx, rows } = makeTx({ p1: simple('p1', 100) }, {}, { 'b1:v-p1': 2 });
    await new InventoryEngine(new VariantInventoryResolver())
      .applyBranchInventoryDelta(tx as never, 'b1', 'p1', 't1', -5);
    expect(rows.get('b1:v-p1')).toBe(0);
  });

  it('sin sucursal resoluble → no-op', async () => {
    const { tx, rows, calls } = makeTx({ p1: simple('p1', 100) }, {}, {}, { mainBranchId: null });
    await new InventoryEngine(new VariantInventoryResolver())
      .applyBranchInventoryDelta(tx as never, null, 'p1', 't1', -5);
    expect(rows.size).toBe(0);
    expect(calls.branchCreate).toHaveLength(0);
  });
});

function engine() {
  return new InventoryConsumptionEngine(new InventoryEngine(new VariantInventoryResolver()));
}
