import { Injectable } from '@nestjs/common';
import { Prisma, InventoryMovementType, SupplyMovementType } from '@prisma/client';
import { VariantInventoryResolver } from './variant-inventory.resolver';

/**
 * InventoryEngine — Fase 1 (preparación de infraestructura).
 *
 * Objetivo: ser, en fases posteriores, la ÚNICA puerta de entrada para modificar
 * existencias (productos e insumos). En esta fase solo ENCAPSULA los primitivos
 * de inventario que hoy están duplicados en varios servicios; todavía NO
 * reemplaza a ningún llamador (la adopción es Fase 2).
 *
 * Principios de diseño:
 *  - Ignorancia de dominio: el engine NO conoce Ventas, Compras, POS, Comanda,
 *    Órdenes, Servicios, CxP ni CxC. Solo habla de productos, insumos, sucursales
 *    y movimientos. La semántica ("por qué" se mueve el stock) la aporta el
 *    llamador vía `type`/`referenceType`/`notes`.
 *  - Transacción del llamador: igual que InventoryConsumptionEngine, cada método
 *    recibe un `Prisma.TransactionClient` y NUNCA abre su propia `$transaction`,
 *    de modo que la escritura de inventario queda en la misma unidad atómica que
 *    el resto de la operación de negocio.
 *  - Sin efectos observables nuevos: los primitivos reproducen exactamente el
 *    comportamiento existente (mismos campos de movimiento, mismo guard de stock,
 *    misma siembra de branchInventory), para que la migración de Fase 2 sea una
 *    sustitución 1:1.
 *
 * Mapa de operaciones futuras (Fase 2+) sobre estos primitivos — NO implementadas
 * aquí a propósito (evitar sobreingeniería / código muerto):
 *   ventas            → applyProductStockDelta(guard) + recordProductMovement(VENTA)
 *   compras           → applyProductStockDelta(+) + recordProductMovement(COMPRA)
 *   devoluciones      → applyProductStockDelta(+) + recordProductMovement(DEVOLUCION)
 *   ajustes           → applyProductStockDelta + recordProductMovement(AJUSTE)
 *   consumo de receta → applySupplyStockDelta(guard) + recordSupplyMovement(RECIPE_CONSUMPTION)
 *   producción        → // TODO Phase 2
 *   transferencias    → // TODO Phase 2 (par de deltas + movimiento TRANSFERENCIA)
 *   mermas            → // TODO Phase 2
 *   inventario inicial→ // TODO Phase 2
 *   conteos físicos   → // TODO Phase 2
 */

/** Entrada de un movimiento de producto (espeja el modelo InventoryMovement). */
export interface ProductMovementInput {
  tenantId: string;
  type: InventoryMovementType;
  productId: string;
  quantity: number;
  branchId?: string | null;
  referenceId?: string | null;
  referenceType?: string | null;
  notes?: string | null;
  createdById?: string | null;
}

/** Entrada de un movimiento de insumo (espeja el modelo SupplyMovement). */
export interface SupplyMovementInput {
  tenantId: string;
  supplyId: string;
  type: SupplyMovementType;
  quantity: number;
  branchId?: string | null;
  referenceId?: string | null;
  notes?: string | null;
  createdById?: string | null;
}

/** Delta a aplicar sobre existencia de producto. */
export interface ProductStockDelta {
  productId: string;
  /**
   * Tenant dueño de la operación. Obligatorio: acota la resolución de
   * variante/sucursal y TODA escritura de existencias, de modo que un
   * `productId` de otra organización no pueda mover su stock.
   */
  tenantId: string;
  /** Positivo suma, negativo resta. */
  delta: number;
  /**
   * Cuando es true y el delta es negativo, la resta solo se aplica si hay
   * existencia suficiente (guard contra stock negativo). Devuelve false si no
   * alcanzó. Cuando es false, la resta se aplica sin guard.
   */
  guardInsufficient?: boolean;
  /**
   * Variante a la que se carga el movimiento. Si se omite se usa la variante
   * default del producto — así los llamadores que aún hablan de productos
   * (POS, comanda, caja, compras) no necesitan cambiar.
   */
  variantId?: string | null;
  /**
   * Sucursal contra la que se mueve la existencia. Si se omite se usa la
   * sucursal `isMain` del tenant.
   */
  branchId?: string | null;
}

/** Delta a aplicar sobre existencia de insumo. */
export interface SupplyStockDelta {
  supplyId: string;
  /** Tenant dueño de la operación. Acota la escritura — ver `ProductStockDelta`. */
  tenantId: string;
  delta: number;
  guardInsufficient?: boolean;
}

@Injectable()
export class InventoryEngine {
  constructor(private readonly resolver: VariantInventoryResolver) {}

  // ── Movimientos (append-only) ─────────────────────────────────────────────

  /**
   * Registra un InventoryMovement de producto. No toca existencias: solo escribe
   * el asiento en el ledger. `referenceType` por defecto 'ORDER' se deja a cargo
   * del llamador para no imponer semántica de dominio aquí.
   */
  async recordProductMovement(
    tx: Prisma.TransactionClient,
    input: ProductMovementInput,
  ): Promise<void> {
    await tx.inventoryMovement.create({
      data: {
        tenantId: input.tenantId,
        type: input.type,
        productId: input.productId,
        branchId: input.branchId ?? null,
        quantity: input.quantity,
        referenceId: input.referenceId ?? null,
        referenceType: input.referenceType ?? null,
        notes: input.notes ?? null,
        createdById: input.createdById ?? null,
      },
    });
  }

  /** Registra un SupplyMovement de insumo. No toca existencias. */
  async recordSupplyMovement(
    tx: Prisma.TransactionClient,
    input: SupplyMovementInput,
  ): Promise<void> {
    await tx.supplyMovement.create({
      data: {
        tenantId: input.tenantId,
        supplyId: input.supplyId,
        type: input.type,
        quantity: input.quantity,
        branchId: input.branchId ?? null,
        referenceId: input.referenceId ?? null,
        notes: input.notes ?? null,
        createdById: input.createdById ?? null,
      },
    });
  }

  // ── Existencias globales ──────────────────────────────────────────────────

  /**
   * Aplica un delta sobre la existencia de un producto.
   *
   * La fuente de verdad es la fila de `branch_inventory` de (sucursal, variante):
   * ahí vive el guard contra sobreventa. `Product.stock` se sigue actualizando en
   * espejo mientras dure la fase expand, para que el código que todavía lo lee
   * siga viendo un número correcto y para que el cambio sea revertible.
   *
   * Si el producto no es direccionable por variante/sucursal (tenant sin
   * sucursales, o producto sin variante default), cae al comportamiento legacy
   * sobre `Product.stock`, que sigue siendo autoritativo en ese caso.
   *
   * Devuelve true si el delta se aplicó; false si el guard lo rechazó.
   */
  async applyProductStockDelta(
    tx: Prisma.TransactionClient,
    { productId, tenantId, delta, guardInsufficient, variantId, branchId }: ProductStockDelta,
  ): Promise<boolean> {
    const target =
      variantId && branchId
        ? { variantId, branchId }
        : await this.resolver.resolve(tx, productId, tenantId, branchId);

    if (!target) {
      // Legacy: sin inventario por variante, `Product.stock` manda. `updateMany`
      // (no `update`) porque el filtro deja de ser la clave única: lleva tenant.
      if (delta < 0 && guardInsufficient) {
        const res = await tx.product.updateMany({
          where: { id: productId, tenantId, stock: { gte: -delta } },
          data: { stock: { increment: delta } },
        });
        return res.count > 0;
      }

      const res = await tx.product.updateMany({
        where: { id: productId, tenantId },
        data: { stock: { increment: delta } },
      });
      // 0 filas = el producto no es de este tenant (o no existe): no hay nada
      // que mover y el llamador debe tratarlo como fallo, no como éxito silencioso.
      return res.count > 0;
    }

    await this.ensureBranchInventoryRow(tx, productId, tenantId, target.variantId, target.branchId);

    if (delta < 0 && guardInsufficient) {
      const res = await tx.branchInventory.updateMany({
        where: { ...target, stock: { gte: -delta } },
        data: { stock: { increment: delta } },
      });
      if (res.count === 0) return false;
    } else {
      await tx.branchInventory.updateMany({
        where: target,
        data: { stock: { increment: delta } },
      });
    }

    await this.mirrorLegacyProductStock(tx, productId, tenantId, delta);
    return true;
  }

  /**
   * Espejo del delta sobre `Product.stock` (columna legacy de la fase expand).
   *
   * Se protege contra quedar negativo: el guard autoritativo corre sobre la fila
   * de sucursal, así que cuando el global está desfasado respecto de ella —dato
   * heredado, no todos los productos tenían sus existencias por sucursal
   * cuadradas— una venta perfectamente válida podría dejar el global por debajo
   * de cero. Se recorta a 0, igual que se hace con las filas de sucursal.
   */
  private async mirrorLegacyProductStock(
    tx: Prisma.TransactionClient,
    productId: string,
    tenantId: string,
    delta: number,
  ): Promise<void> {
    if (delta >= 0) {
      await tx.product.updateMany({
        where: { id: productId, tenantId },
        data: { stock: { increment: delta } },
      });
      return;
    }

    const mirrored = await tx.product.updateMany({
      where: { id: productId, tenantId, stock: { gte: -delta } },
      data: { stock: { increment: delta } },
    });
    if (mirrored.count > 0) return;

    await tx.product.updateMany({
      where: { id: productId, tenantId },
      data: { stock: 0 },
    });
  }

  /**
   * Garantiza que exista la fila (sucursal, variante), sembrándola desde los
   * valores comerciales actuales del producto. Sin esto, un `updateMany` sobre
   * una fila inexistente afectaría 0 filas y el movimiento se perdería en
   * silencio — el modo de falla más peligroso de este motor.
   *
   * La fila nace con existencia CERO. Que no exista significa exactamente que en
   * esa sucursal nunca hubo existencia de esa variante; sembrarla con
   * `product.stock` —el espejo legacy, que es la suma de todas las variantes de
   * todas las sucursales— multiplicaba el inventario cada vez que aparecía una
   * combinación nueva (una sucursal recién creada, una variante recién añadida).
   * El delta del llamador se aplica encima, que es lo único que este método debe
   * dejar pasar.
   */
  private async ensureBranchInventoryRow(
    tx: Prisma.TransactionClient,
    productId: string,
    tenantId: string,
    variantId: string,
    branchId: string,
  ): Promise<void> {
    const existing = await tx.branchInventory.findUnique({
      where: { branchId_variantId: { branchId, variantId } },
      select: { branchId: true },
    });
    if (existing) return;

    // Acotado al tenant: sin este filtro se sembraba una fila de inventario que
    // enlazaba el producto de otra organización con una sucursal propia, y de ahí
    // se leían su nombre, SKU y precios.
    const product = await tx.product.findFirst({
      where: { id: productId, tenantId },
      select: {
        price: true,
        costPrice: true,
        comparePrice: true,
        lastCost: true,
        avgCost: true,
        lowStockAlert: true,
      },
    });

    // El producto no es de este tenant (o no existe): no se siembra nada. El
    // llamador verá 0 filas afectadas y fallará, que es el comportamiento
    // correcto — antes se creaba la fila con ceros y la operación seguía.
    if (!product) return;

    await tx.branchInventory.create({
      data: {
        branchId,
        productId,
        variantId,
        stock: 0,
        price: product.price,
        cost: product.costPrice,
        comparePrice: product.comparePrice,
        lastCost: product.lastCost,
        avgCost: product.avgCost,
        lowStockAlert: product.lowStockAlert ?? 5,
      },
    });
  }

  /** Aplica un delta sobre `Supply.stock` (Decimal). Mismos patrones que producto. */
  async applySupplyStockDelta(
    tx: Prisma.TransactionClient,
    { supplyId, tenantId, delta, guardInsufficient }: SupplyStockDelta,
  ): Promise<boolean> {
    if (delta < 0 && guardInsufficient) {
      const res = await tx.supply.updateMany({
        where: { id: supplyId, tenantId, stock: { gte: -delta } },
        data: { stock: { increment: delta } },
      });
      return res.count > 0;
    }

    const res = await tx.supply.updateMany({
      where: { id: supplyId, tenantId },
      data: { stock: { increment: delta } },
    });
    return res.count > 0;
  }

  // ── Existencias por sucursal ──────────────────────────────────────────────

  /**
   * Aplica un delta sobre `BranchInventory.stock`. Extraído verbatim del
   * comportamiento actual de InventoryConsumptionEngine para que la Fase 2 pueda
   * eliminar la copia privada de ese motor con una sustitución exacta:
   *  - Sin `branchId`: no-op.
   *  - Resta: `updateMany` guardado; si la fila existe pero no alcanza, se fija a
   *    0 (nunca negativa, el guard global ya evitó la sobreventa); si no hay fila,
   *    se siembra desde el stock global del producto.
   *  - Suma: `increment`; si no hay fila, se siembra desde el stock global.
   */
  async applyBranchInventoryDelta(
    tx: Prisma.TransactionClient,
    branchId: string | null | undefined,
    productId: string,
    tenantId: string,
    delta: number,
    variantId?: string | null,
  ): Promise<void> {
    const target =
      variantId && branchId
        ? { variantId, branchId }
        : await this.resolver.resolve(tx, productId, tenantId, branchId);
    if (!target) return;

    await this.ensureBranchInventoryRow(tx, productId, tenantId, target.variantId, target.branchId);

    if (delta < 0) {
      const decremented = await tx.branchInventory.updateMany({
        where: { ...target, stock: { gte: -delta } },
        data: { stock: { increment: delta } },
      });
      if (decremented.count > 0) return;

      // La fila existe pero no alcanza: se fija en 0, nunca negativa (el guard
      // global ya evitó la sobreventa).
      await tx.branchInventory.updateMany({
        where: target,
        data: { stock: 0 },
      });
      return;
    }

    await tx.branchInventory.updateMany({
      where: target,
      data: { stock: { increment: delta } },
    });
  }

  // ── Consultas de existencia ───────────────────────────────────────────────

  /**
   * Existencia actual de un producto (o null si no existe). Lee de la fila de
   * (sucursal, variante) cuando el producto es direccionable ahí; si no, del
   * `Product.stock` legacy.
   */
  async getProductStock(
    tx: Prisma.TransactionClient,
    productId: string,
    tenantId: string,
    branchId?: string | null,
    variantId?: string | null,
  ): Promise<number | null> {
    const target =
      variantId && branchId
        ? { variantId, branchId }
        : await this.resolver.resolve(tx, productId, tenantId, branchId);

    if (target) {
      const row = await tx.branchInventory.findUnique({
        where: { branchId_variantId: { branchId: target.branchId, variantId: target.variantId } },
        select: { stock: true },
      });
      if (row) return row.stock;
    }

    const product = await tx.product.findFirst({
      where: { id: productId, tenantId },
      select: { stock: true },
    });
    return product ? product.stock : null;
  }

  /** Existencia global actual de un insumo, como número (o null si no existe). */
  async getSupplyStock(
    tx: Prisma.TransactionClient,
    supplyId: string,
    tenantId: string,
  ): Promise<number | null> {
    const supply = await tx.supply.findFirst({
      where: { id: supplyId, tenantId },
      select: { stock: true },
    });
    return supply ? Number(supply.stock) : null;
  }
}
