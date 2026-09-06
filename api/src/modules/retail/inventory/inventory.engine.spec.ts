import { InventoryEngine } from './inventory.engine';
import { VariantInventoryResolver } from './variant-inventory.resolver';

/**
 * InventoryEngine encapsula los primitivos de inventario. La fuente de verdad de
 * la existencia es la fila de `branch_inventory` de (sucursal, variante) y
 * `Product.stock` se mantiene como espejo durante la fase expand.
 *
 * Estos tests fijan el comportamiento completo del primitivo: resolución de la
 * llave (variante default / sucursal isMain), siembra de la fila, guard contra
 * sobreventa, espejo en `Product.stock` y el fallback legacy cuando el producto
 * todavía no es direccionable por variante/sucursal.
 */

/**
 * Fila comercial del producto tal como la leen `ensureBranchInventoryRow`
 * (campos comerciales) y el resolver (`tenantId`).
 */
const PRODUCT_ROW = {
  tenantId: 't1',
  stock: 7,
  price: 100,
  costPrice: 60,
  comparePrice: 120,
  lastCost: 58,
  avgCost: 59,
  lowStockAlert: 3,
};

/** Llave que el resolver deduce para 'p1' cuando el llamador no especifica nada. */
const TARGET = { variantId: 'v-p1', branchId: 'b-main' };

function makeTx() {
  return {
    inventoryMovement: { create: jest.fn().mockResolvedValue({}) },
    supplyMovement: { create: jest.fn().mockResolvedValue({}) },
    product: {
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      // `findFirst` es la lectura acotada al tenant que usa el engine; se
      // conserva `findUnique` porque algún test antiguo todavía lo anula.
      findFirst: jest.fn().mockResolvedValue({ ...PRODUCT_ROW }),
      findUnique: jest.fn().mockResolvedValue({ ...PRODUCT_ROW }),
    },
    // Variante default del producto: la línea implícita "el producto en sí".
    productVariant: {
      // Devuelve la variante default; los tests que ejercitan el fallback legacy
      // la anulan con `mockResolvedValue(null)`, de ahí el tipo nullable.
      findFirst: jest.fn(({ where }: { where: { productId: string } }): Promise<{ id: string } | null> =>
        Promise.resolve({ id: `v-${where.productId}` }),
      ),
      create: jest.fn().mockResolvedValue({ id: 'v-nueva' }),
    },
    // Sucursal isMain del tenant, usada cuando el llamador no trae branchId.
    branch: { findFirst: jest.fn().mockResolvedValue({ id: 'b-main' }) },
    supply: {
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue({ stock: 12 }),
      findUnique: jest.fn().mockResolvedValue({ stock: 12 }),
    },
    branchInventory: {
      // Por defecto la fila NO existe todavía → el engine la siembra.
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn().mockResolvedValue({}),
    },
  };
}

describe('InventoryEngine', () => {
  let engine: InventoryEngine;

  beforeEach(() => {
    // Resolver real: la resolución variante/sucursal es parte del contrato que
    // estos tests fijan, no una dependencia que convenga simular.
    engine = new InventoryEngine(new VariantInventoryResolver());
  });

  describe('recordProductMovement', () => {
    it('escribe el movimiento con los campos provistos y defaults nulos', async () => {
      const tx = makeTx();
      await engine.recordProductMovement(tx as never, {
        tenantId: 't1',
        type: 'VENTA',
        productId: 'p1',
        quantity: 3,
      });
      expect(tx.inventoryMovement.create).toHaveBeenCalledWith({
        data: {
          tenantId: 't1',
          type: 'VENTA',
          productId: 'p1',
          branchId: null,
          quantity: 3,
          referenceId: null,
          referenceType: null,
          notes: null,
          createdById: null,
        },
      });
    });
  });

  describe('recordSupplyMovement', () => {
    it('escribe el movimiento de insumo con defaults nulos', async () => {
      const tx = makeTx();
      await engine.recordSupplyMovement(tx as never, {
        tenantId: 't1',
        supplyId: 's1',
        type: 'ADJUSTMENT',
        quantity: 2,
      });
      expect(tx.supplyMovement.create).toHaveBeenCalledWith({
        data: {
          tenantId: 't1',
          supplyId: 's1',
          type: 'ADJUSTMENT',
          quantity: 2,
          branchId: null,
          referenceId: null,
          notes: null,
          createdById: null,
        },
      });
    });
  });

  describe('applyProductStockDelta — resolución de la llave (sucursal, variante)', () => {
    it('sin variante ni sucursal explícitas → usa la variante default y la sucursal isMain', async () => {
      const tx = makeTx();
      await engine.applyProductStockDelta(tx as never, { productId: 'p1', tenantId: 't1', delta: -2 });

      expect(tx.productVariant.findFirst).toHaveBeenCalledWith({
        where: { productId: 'p1', isDefault: true, product: { tenantId: 't1' } },
        select: { id: true },
      });
      expect(tx.branch.findFirst).toHaveBeenCalledWith({
        where: { tenantId: 't1', isMain: true },
        select: { id: true },
      });
      // El delta cae sobre la fila de la variante default, no sobre el producto.
      expect(tx.branchInventory.updateMany).toHaveBeenCalledWith({
        where: TARGET,
        data: { stock: { increment: -2 } },
      });
    });

    it('con branchId explícito → no busca la sucursal isMain', async () => {
      const tx = makeTx();
      await engine.applyProductStockDelta(tx as never, {
        productId: 'p1', tenantId: 't1', delta: -2, branchId: 'b9',
      });

      expect(tx.branch.findFirst).not.toHaveBeenCalled();
      expect(tx.branchInventory.updateMany).toHaveBeenCalledWith({
        where: { variantId: 'v-p1', branchId: 'b9' },
        data: { stock: { increment: -2 } },
      });
    });

    it('con variante y sucursal explícitas → no consulta al resolver', async () => {
      const tx = makeTx();
      await engine.applyProductStockDelta(tx as never, {
        productId: 'p1', tenantId: 't1', delta: 3, variantId: 'v-talla-m', branchId: 'b9',
      });

      expect(tx.productVariant.findFirst).not.toHaveBeenCalled();
      expect(tx.branch.findFirst).not.toHaveBeenCalled();
      expect(tx.branchInventory.updateMany).toHaveBeenCalledWith({
        where: { variantId: 'v-talla-m', branchId: 'b9' },
        data: { stock: { increment: 3 } },
      });
    });
  });

  describe('applyProductStockDelta — siembra de la fila', () => {
    it('fila inexistente → la siembra en CERO con los valores comerciales del producto', async () => {
      const tx = makeTx();
      await engine.applyProductStockDelta(tx as never, { productId: 'p1', tenantId: 't1', delta: -2 });

      // Sin siembra, el updateMany afectaría 0 filas y el movimiento se perdería
      // en silencio: el modo de falla más peligroso del motor.
      expect(tx.branchInventory.findUnique).toHaveBeenCalledWith({
        where: { branchId_variantId: { branchId: 'b-main', variantId: 'v-p1' } },
        select: { branchId: true },
      });
      // La existencia arranca en 0, NO en `product.stock` (7). Que la fila no
      // exista significa que en esa sucursal nunca hubo existencia de esa
      // variante; copiar el espejo legacy —la suma de todas las variantes de
      // todas las sucursales— multiplicaba el inventario cada vez que aparecía
      // una combinación nueva. Los valores comerciales sí se heredan.
      expect(tx.branchInventory.create).toHaveBeenCalledWith({
        data: {
          branchId: 'b-main',
          productId: 'p1',
          variantId: 'v-p1',
          stock: 0,
          price: 100,
          cost: 60,
          comparePrice: 120,
          lastCost: 58,
          avgCost: 59,
          lowStockAlert: 3,
        },
      });
    });

    it('fila existente → no se vuelve a sembrar', async () => {
      const tx = makeTx();
      tx.branchInventory.findUnique.mockResolvedValue({ branchId: 'b-main' });
      await engine.applyProductStockDelta(tx as never, { productId: 'p1', tenantId: 't1', delta: -2 });

      expect(tx.branchInventory.create).not.toHaveBeenCalled();
      expect(tx.branchInventory.updateMany).toHaveBeenCalled();
    });
  });

  describe('applyProductStockDelta — delta y espejo', () => {
    it('delta 0 → escribe increment 0 (preserva bump de updatedAt) y devuelve true', async () => {
      const tx = makeTx();
      const ok = await engine.applyProductStockDelta(tx as never, { productId: 'p1', tenantId: 't1', delta: 0 });
      expect(ok).toBe(true);
      // Sin corto-circuito: siempre se emite el UPDATE (increment 0) para conservar
      // el comportamiento observable de una escritura de stock (updatedAt).
      expect(tx.branchInventory.updateMany).toHaveBeenCalledWith({
        where: TARGET,
        data: { stock: { increment: 0 } },
      });
      // El espejo sobre `Product.stock` pasó de `update` a `updateMany`: el
      // filtro ya no es la clave única, lleva `tenantId`.
      expect(tx.product.updateMany).toHaveBeenCalledWith({
        where: { id: 'p1', tenantId: 't1' },
        data: { stock: { increment: 0 } },
      });
      expect(tx.product.update).not.toHaveBeenCalled();
    });

    it('resta con guard y stock suficiente → updateMany guardado sobre la fila, devuelve true', async () => {
      const tx = makeTx();
      tx.branchInventory.updateMany.mockResolvedValue({ count: 1 });
      const ok = await engine.applyProductStockDelta(tx as never, {
        productId: 'p1', tenantId: 't1', delta: -5, guardInsufficient: true,
      });
      expect(ok).toBe(true);
      // El guard contra sobreventa vive en la fila de (sucursal, variante).
      expect(tx.branchInventory.updateMany).toHaveBeenCalledWith({
        where: { ...TARGET, stock: { gte: 5 } },
        data: { stock: { increment: -5 } },
      });
      // Y `Product.stock` se sigue espejando mientras dure la fase expand. La
      // baja va guardada para que el espejo nunca quede negativo cuando el dato
      // global esté desfasado respecto de la fila de sucursal.
      expect(tx.product.updateMany).toHaveBeenCalledWith({
        where: { id: 'p1', tenantId: 't1', stock: { gte: 5 } },
        data: { stock: { increment: -5 } },
      });
    });

    it('espejo desfasado: si el global no alcanza, se recorta a 0 en vez de quedar negativo', async () => {
      const tx = makeTx();
      tx.branchInventory.updateMany.mockResolvedValue({ count: 1 });
      // La fila de sucursal sí alcanza (la venta procede), pero el global no.
      tx.product.updateMany.mockResolvedValue({ count: 0 });

      const ok = await engine.applyProductStockDelta(tx as never, {
        productId: 'p1', tenantId: 't1', delta: -5, guardInsufficient: true,
      });

      expect(ok).toBe(true);
      expect(tx.product.updateMany).toHaveBeenLastCalledWith({
        where: { id: 'p1', tenantId: 't1' },
        data: { stock: 0 },
      });
    });

    it('resta con guard y stock insuficiente → devuelve false sin mutar ni espejar', async () => {
      const tx = makeTx();
      tx.branchInventory.updateMany.mockResolvedValue({ count: 0 });
      const ok = await engine.applyProductStockDelta(tx as never, {
        productId: 'p1', tenantId: 't1', delta: -5, guardInsufficient: true,
      });
      expect(ok).toBe(false);
      // El rechazo corta antes del espejo: `Product.stock` no se mueve.
      expect(tx.product.update).not.toHaveBeenCalled();
      expect(tx.product.updateMany).not.toHaveBeenCalled();
    });

    it('suma sin guard → increment directo en la fila y en el espejo', async () => {
      const tx = makeTx();
      const ok = await engine.applyProductStockDelta(tx as never, { productId: 'p1', tenantId: 't1', delta: 4 });
      expect(ok).toBe(true);
      expect(tx.branchInventory.updateMany).toHaveBeenCalledWith({
        where: TARGET,
        data: { stock: { increment: 4 } },
      });
      expect(tx.product.updateMany).toHaveBeenCalledWith({
        where: { id: 'p1', tenantId: 't1' },
        data: { stock: { increment: 4 } },
      });
    });
  });

  describe('applyProductStockDelta — fallback legacy sobre Product.stock', () => {
    it('producto sin variante default → resta guardada sobre Product.stock', async () => {
      const tx = makeTx();
      tx.productVariant.findFirst.mockResolvedValue(null);
      tx.product.updateMany.mockResolvedValue({ count: 1 });

      const ok = await engine.applyProductStockDelta(tx as never, {
        productId: 'p1', tenantId: 't1', delta: -5, guardInsufficient: true,
      });
      expect(ok).toBe(true);
      expect(tx.product.updateMany).toHaveBeenCalledWith({
        where: { id: 'p1', tenantId: 't1', stock: { gte: 5 } },
        data: { stock: { increment: -5 } },
      });
      // No es direccionable por variante: nada toca branch_inventory.
      expect(tx.branchInventory.updateMany).not.toHaveBeenCalled();
      expect(tx.branchInventory.create).not.toHaveBeenCalled();
    });

    it('tenant sin sucursales → suma directa sobre Product.stock', async () => {
      const tx = makeTx();
      tx.branch.findFirst.mockResolvedValue(null);

      const ok = await engine.applyProductStockDelta(tx as never, { productId: 'p1', tenantId: 't1', delta: 4 });
      expect(ok).toBe(true);
      expect(tx.product.updateMany).toHaveBeenCalledWith({
        where: { id: 'p1', tenantId: 't1' },
        data: { stock: { increment: 4 } },
      });
      expect(tx.branchInventory.updateMany).not.toHaveBeenCalled();
      expect(tx.branchInventory.create).not.toHaveBeenCalled();
    });

    it('legacy con guard y stock insuficiente → devuelve false sin mutar', async () => {
      const tx = makeTx();
      tx.productVariant.findFirst.mockResolvedValue(null);
      tx.product.updateMany.mockResolvedValue({ count: 0 });

      const ok = await engine.applyProductStockDelta(tx as never, {
        productId: 'p1', tenantId: 't1', delta: -5, guardInsufficient: true,
      });
      expect(ok).toBe(false);
      expect(tx.product.update).not.toHaveBeenCalled();
    });
  });

  describe('applySupplyStockDelta', () => {
    it('resta con guard insuficiente → false', async () => {
      const tx = makeTx();
      tx.supply.updateMany.mockResolvedValue({ count: 0 });
      const ok = await engine.applySupplyStockDelta(tx as never, {
        supplyId: 's1', tenantId: 't1', delta: -3, guardInsufficient: true,
      });
      expect(ok).toBe(false);
      expect(tx.supply.update).not.toHaveBeenCalled();
    });
  });

  describe('applyBranchInventoryDelta', () => {
    it('sin branchId → resuelve la sucursal isMain del tenant', async () => {
      const tx = makeTx();
      await engine.applyBranchInventoryDelta(tx as never, null, 'p1', 't1', -2);
      // Ya no es no-op: la ausencia de sucursal explícita se resuelve a la isMain.
      expect(tx.branchInventory.updateMany).toHaveBeenCalledWith({
        where: { ...TARGET, stock: { gte: 2 } },
        data: { stock: { increment: -2 } },
      });
    });

    it('sin sucursal resoluble → no-op', async () => {
      const tx = makeTx();
      tx.branch.findFirst.mockResolvedValue(null);
      await engine.applyBranchInventoryDelta(tx as never, null, 'p1', 't1', -2);
      expect(tx.branchInventory.updateMany).not.toHaveBeenCalled();
      expect(tx.branchInventory.create).not.toHaveBeenCalled();
    });

    it('sin variante default → no-op', async () => {
      const tx = makeTx();
      tx.productVariant.findFirst.mockResolvedValue(null);
      await engine.applyBranchInventoryDelta(tx as never, 'b1', 'p1', 't1', -2);
      expect(tx.branchInventory.updateMany).not.toHaveBeenCalled();
      expect(tx.branchInventory.create).not.toHaveBeenCalled();
    });

    it('resta con fila suficiente → updateMany guardado, sin siembra', async () => {
      const tx = makeTx();
      tx.branchInventory.findUnique.mockResolvedValue({ branchId: 'b1' });
      tx.branchInventory.updateMany.mockResolvedValue({ count: 1 });
      await engine.applyBranchInventoryDelta(tx as never, 'b1', 'p1', 't1', -2);
      expect(tx.branchInventory.updateMany).toHaveBeenCalledWith({
        where: { branchId: 'b1', variantId: 'v-p1', stock: { gte: 2 } },
        data: { stock: { increment: -2 } },
      });
      expect(tx.branchInventory.create).not.toHaveBeenCalled();
    });

    it('resta con fila insuficiente → clamp a 0, nunca negativa', async () => {
      const tx = makeTx();
      tx.branchInventory.findUnique.mockResolvedValue({ branchId: 'b1' });
      // El updateMany guardado no afecta filas → se fija en 0 (el guard global ya
      // evitó la sobreventa, la fila jamás queda negativa).
      tx.branchInventory.updateMany.mockResolvedValueOnce({ count: 0 });
      await engine.applyBranchInventoryDelta(tx as never, 'b1', 'p1', 't1', -2);
      expect(tx.branchInventory.updateMany).toHaveBeenLastCalledWith({
        where: { branchId: 'b1', variantId: 'v-p1' },
        data: { stock: 0 },
      });
    });

    it('resta sin fila → la siembra en CERO y luego aplica el delta (que no alcanza)', async () => {
      const tx = makeTx();
      tx.product.findFirst.mockResolvedValue({ ...PRODUCT_ROW, stock: 9 });
      await engine.applyBranchInventoryDelta(tx as never, 'b1', 'p1', 't1', -2);
      // La fila nace en 0, no con las 9 del espejo legacy: en esta sucursal
      // nunca hubo existencia de esta variante.
      expect(tx.branchInventory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ branchId: 'b1', productId: 'p1', variantId: 'v-p1', stock: 0 }),
      });
      expect(tx.branchInventory.updateMany).toHaveBeenCalledWith({
        where: { branchId: 'b1', variantId: 'v-p1', stock: { gte: 2 } },
        data: { stock: { increment: -2 } },
      });
    });

    it('suma sin fila → la siembra en CERO y suma', async () => {
      const tx = makeTx();
      tx.product.findFirst.mockResolvedValue({ ...PRODUCT_ROW, stock: 5 });
      await engine.applyBranchInventoryDelta(tx as never, 'b1', 'p1', 't1', 3);
      expect(tx.branchInventory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ branchId: 'b1', productId: 'p1', variantId: 'v-p1', stock: 0 }),
      });
      expect(tx.branchInventory.updateMany).toHaveBeenCalledWith({
        where: { branchId: 'b1', variantId: 'v-p1' },
        data: { stock: { increment: 3 } },
      });
    });
  });

  describe('getProductStock / getSupplyStock', () => {
    it('lee la fila de (sucursal, variante) cuando existe', async () => {
      const tx = makeTx();
      tx.branchInventory.findUnique.mockResolvedValue({ stock: 3 });
      expect(await engine.getProductStock(tx as never, 'p1', 't1')).toBe(3);
      expect(tx.branchInventory.findUnique).toHaveBeenCalledWith({
        where: { branchId_variantId: { branchId: 'b-main', variantId: 'v-p1' } },
        select: { stock: true },
      });
    });

    it('respeta la variante y sucursal explícitas', async () => {
      const tx = makeTx();
      tx.branchInventory.findUnique.mockResolvedValue({ stock: 11 });
      expect(await engine.getProductStock(tx as never, 'p1', 't1', 'b9', 'v-talla-m')).toBe(11);
      expect(tx.branchInventory.findUnique).toHaveBeenCalledWith({
        where: { branchId_variantId: { branchId: 'b9', variantId: 'v-talla-m' } },
        select: { stock: true },
      });
    });

    it('sin fila de sucursal → cae al Product.stock legacy', async () => {
      const tx = makeTx();
      tx.branchInventory.findUnique.mockResolvedValue(null);
      expect(await engine.getProductStock(tx as never, 'p1', 't1')).toBe(7);
    });

    it('producto inexistente → null', async () => {
      const tx = makeTx();
      tx.product.findFirst.mockResolvedValue(null);
      expect(await engine.getProductStock(tx as never, 'p1', 't1')).toBeNull();
    });

    it('convierte Decimal de insumo a número', async () => {
      const tx = makeTx();
      tx.supply.findUnique.mockResolvedValue({ stock: 12 });
      expect(await engine.getSupplyStock(tx as never, 's1', 't1')).toBe(12);
    });
  });
});
