import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma, ProductType } from '@prisma/client';
import { safeConvertUnits } from '../../../common/helpers/unit-conversion';
import { InventoryEngine } from './inventory.engine';

/**
 * InventoryConsumptionEngine — single source of truth for stock movement caused
 * by sales and their reversals (cancel / return / refund). Operates on SIMPLE,
 * RECIPE and COMBO products and guarantees symmetry: whatever `consume` removes,
 * `restore` puts back, walking the exact same expansion tree.
 *
 * Design:
 *  - Always runs inside a caller-provided transaction (`Prisma.TransactionClient`).
 *    It never opens its own `$transaction`, so payment / cash / order writes stay
 *    in the same atomic unit owned by the caller.
 *  - Pure resolution (`resolveEffects`) is shared by consume, restore and
 *    validate, which is what makes consumption and reversal provably symmetric.
 *  - COMBO products expand recursively into their children; each leaf is either a
 *    SIMPLE product (decrements product stock) or a RECIPE product (decrements
 *    supplies). A COMBO that is itself a child is expanded again.
 */

/** One line of a sale/return. SERVICE lines and null products are ignored. */
export interface InventoryLineItem {
  productId: string | null;
  quantity: number;
  itemType?: 'PRODUCT' | 'SERVICE' | null;
  /**
   * Variante vendida. Omitirla significa "la default" — es lo que hacen los
   * llamadores que todavía hablan solo de productos, y lo que resuelve
   * `VariantInventoryResolver`. Con ella, el descuento cae sobre ESA variante.
   */
  variantId?: string | null;
}

export interface InventoryContext {
  tenantId: string;
  branchId: string | null;
  userId: string | null;
  /** The order id (or other origin) these movements reference. */
  referenceId: string;
  /** Defaults to 'ORDER'. */
  referenceType?: string;
  /** Free-text suffix appended to movement notes (e.g. reason). */
  note?: string;
}

interface ProductStockEffect {
  productId: string;
  productName: string;
  quantity: number;
  /** null = la variante default del producto (la resuelve el engine). */
  variantId: string | null;
}

interface SupplyStockEffect {
  supplyId: string;
  supplyName: string;
  /** Amount in the supply's stock unit (baseUnit when configured). */
  quantity: number;
}

interface ResolvedEffects {
  products: Map<string, ProductStockEffect>;
  supplies: Map<string, SupplyStockEffect>;
}

interface LoadedRecipeItem {
  supplyId: string;
  quantity: Prisma.Decimal;
  unit: string;
  normalizedQuantity: Prisma.Decimal | null;
  supply: {
    id: string;
    name: string;
    unit: string;
    stock: Prisma.Decimal;
    baseUnit: { symbol: string } | null;
  };
}

interface LoadedProduct {
  id: string;
  name: string;
  type: ProductType;
  trackInventory: boolean;
  // `stock` NO se carga: la existencia del producto vive en `branch_inventory`
  // por (sucursal, variante) y la resuelve el InventoryEngine. La columna
  // `products.stock` se seguia trayendo aqui sin que nadie la leyera.
  recipe: { items: LoadedRecipeItem[] } | null;
  comboItems: { childProductId: string; quantity: number }[];
}

const PRODUCT_LOAD_SELECT = {
  id: true,
  name: true,
  type: true,
  trackInventory: true,
  recipe: {
    select: {
      items: {
        select: {
          supplyId: true,
          quantity: true,
          unit: true,
          normalizedQuantity: true,
          supply: {
            select: {
              id: true,
              name: true,
              unit: true,
              stock: true,
              baseUnit: { select: { symbol: true } },
            },
          },
        },
      },
    },
  },
  comboItems: { select: { childProductId: true, quantity: true } },
} as const;

const MAX_COMBO_DEPTH = 8;

/**
 * Clave de agregación de un efecto de producto: (producto, variante).
 *
 * Agrupar solo por `productId` fusionaba dos líneas de variantes distintas del
 * mismo producto en una sola resta —vender una M y una L descontaba dos de la
 * misma variante—, y al restaurar deshacía la fusión igual de mal. La variante
 * forma parte de la identidad de lo que se mueve.
 */
const effectKey = (productId: string, variantId: string | null) => `${productId}::${variantId ?? ''}`;

@Injectable()
export class InventoryConsumptionEngine {
  constructor(private readonly inventory: InventoryEngine) {}

  /**
   * Apply stock consumption for a set of sale lines. Decrements product stock
   * (SIMPLE), supply stock (RECIPE) and branch inventory, guarded against going
   * negative, and writes the corresponding VENTA / RECIPE_CONSUMPTION movements.
   * Throws BadRequestException on insufficient stock.
   */
  async consume(
    tx: Prisma.TransactionClient,
    items: InventoryLineItem[],
    ctx: InventoryContext,
  ): Promise<void> {
    const effects = await this.resolveEffects(tx, items, ctx.tenantId);

    for (const effect of effects.products.values()) {
      // El engine aplica el guard sobre la fila de (sucursal, variante) —
      // la fuente de verdad — y espeja el movimiento en `Product.stock`.
      const movida = await this.inventory.applyProductStockDelta(tx, {
        productId: effect.productId,
        tenantId: ctx.tenantId,
        delta: -effect.quantity,
        guardInsufficient: true,
        branchId: ctx.branchId,
        variantId: effect.variantId,
      });
      if (!movida.applied) {
        throw new BadRequestException(
          `Stock insuficiente para "${effect.productName}" al procesar la venta`,
        );
      }
      await tx.inventoryMovement.create({
        data: {
          tenantId: ctx.tenantId,
          type: 'VENTA',
          productId: effect.productId,
          // La variante RESUELTA, no la que pidio el llamador: un producto de
          // una sola presentacion se vende sin nombrarla y el asiento debe
          // apuntar igualmente a ella.
          variantId: movida.variantId,
          branchId: ctx.branchId,
          quantity: effect.quantity,
          referenceId: ctx.referenceId,
          referenceType: ctx.referenceType ?? 'ORDER',
          notes: this.note('Venta', ctx),
          createdById: ctx.userId,
        },
      });
    }

    for (const effect of effects.supplies.values()) {
      const res = await tx.supply.updateMany({
        where: { id: effect.supplyId, tenantId: ctx.tenantId, stock: { gte: effect.quantity } },
        data: { stock: { decrement: effect.quantity } },
      });
      if (res.count === 0) {
        throw new BadRequestException(
          `Stock insuficiente del insumo "${effect.supplyName}" al procesar la venta`,
        );
      }
      await tx.supplyMovement.create({
        data: {
          tenantId: ctx.tenantId,
          supplyId: effect.supplyId,
          type: 'RECIPE_CONSUMPTION',
          quantity: effect.quantity,
          branchId: ctx.branchId,
          referenceId: ctx.referenceId,
          notes: this.note('Consumo receta', ctx),
          createdById: ctx.userId,
        },
      });
    }
  }

  /**
   * Reverse a previous consumption for the same lines. Increments the exact same
   * product/supply/branch quantities and writes DEVOLUCION / ADJUSTMENT
   * movements. No stock guard — restoration never fails on availability.
   */
  async restore(
    tx: Prisma.TransactionClient,
    items: InventoryLineItem[],
    ctx: InventoryContext,
  ): Promise<void> {
    const effects = await this.resolveEffects(tx, items, ctx.tenantId);

    for (const effect of effects.products.values()) {
      // Sin guard: una restauración nunca falla por disponibilidad.
      const devuelta = await this.inventory.applyProductStockDelta(tx, {
        productId: effect.productId,
        tenantId: ctx.tenantId,
        delta: effect.quantity,
        branchId: ctx.branchId,
        variantId: effect.variantId,
      });
      await tx.inventoryMovement.create({
        data: {
          tenantId: ctx.tenantId,
          type: 'DEVOLUCION',
          productId: effect.productId,
          variantId: devuelta.variantId,
          branchId: ctx.branchId,
          quantity: effect.quantity,
          referenceId: ctx.referenceId,
          referenceType: ctx.referenceType ?? 'ORDER',
          notes: this.note('Reversa', ctx),
          createdById: ctx.userId,
        },
      });
    }

    for (const effect of effects.supplies.values()) {
      await tx.supply.updateMany({
        where: { id: effect.supplyId, tenantId: ctx.tenantId },
        data: { stock: { increment: effect.quantity } },
      });
      await tx.supplyMovement.create({
        data: {
          tenantId: ctx.tenantId,
          supplyId: effect.supplyId,
          type: 'ADJUSTMENT',
          quantity: effect.quantity,
          branchId: ctx.branchId,
          referenceId: ctx.referenceId,
          notes: this.note('Reversa consumo receta', ctx),
          createdById: ctx.userId,
        },
      });
    }
  }

  /**
   * Pre-flight availability check without mutating anything. Resolves the full
   * tree and verifies each aggregated product/supply has enough stock. Useful
   * for surfacing clear errors before the financial part of a transaction runs.
   */
  async validate(
    tx: Prisma.TransactionClient,
    items: InventoryLineItem[],
    tenantId: string,
    branchId?: string | null,
  ): Promise<void> {
    const effects = await this.resolveEffects(tx, items, tenantId);

    for (const effect of effects.products.values()) {
      const available = await this.inventory.getProductStock(
        tx,
        effect.productId,
        tenantId,
        branchId,
        effect.variantId,
      );
      if (available != null && available < effect.quantity) {
        throw new BadRequestException(
          `Stock insuficiente para "${effect.productName}". ` +
            `Disponible: ${available}, necesario: ${effect.quantity}`,
        );
      }
    }

    for (const effect of effects.supplies.values()) {
      const supply = await tx.supply.findFirst({
        where: { id: effect.supplyId, tenantId },
        select: { stock: true },
      });
      if (supply != null && Number(supply.stock) < effect.quantity) {
        throw new BadRequestException(
          `Stock insuficiente del insumo "${effect.supplyName}". ` +
            `Disponible: ${supply.stock}, necesario: ${effect.quantity.toFixed(3)}`,
        );
      }
    }
  }

  /**
   * Expand all lines into aggregated leaf effects. Aggregation by product/supply
   * id means a sale that uses the same supply through several lines or combos
   * produces a single, consistent movement — and the same aggregation is reused
   * on restore, which is what guarantees symmetry.
   */
  private async resolveEffects(
    tx: Prisma.TransactionClient,
    items: InventoryLineItem[],
    tenantId: string,
  ): Promise<ResolvedEffects> {
    const cache = new Map<string, LoadedProduct>();
    const effects: ResolvedEffects = { products: new Map(), supplies: new Map() };

    for (const item of items) {
      if (item.itemType === 'SERVICE' || !item.productId) continue;
      if (!Number.isFinite(item.quantity) || item.quantity <= 0) continue;
      await this.expand(
        tx,
        item.productId,
        tenantId,
        item.quantity,
        effects,
        cache,
        0,
        item.variantId ?? null,
      );
    }

    return effects;
  }

  private async expand(
    tx: Prisma.TransactionClient,
    productId: string,
    tenantId: string,
    multiplier: number,
    effects: ResolvedEffects,
    cache: Map<string, LoadedProduct>,
    depth: number,
    /**
     * Variante de la línea. Solo la tiene el nivel superior: los hijos de un
     * combo se consumen por su variante default, porque el combo referencia
     * productos, no variantes (ADR-0030 deja la receta/variante por hijo fuera
     * de v1).
     */
    variantId: string | null,
  ): Promise<void> {
    if (depth > MAX_COMBO_DEPTH) {
      throw new BadRequestException(
        'Combo demasiado anidado o con referencia circular; no se puede calcular el inventario',
      );
    }

    // El tenant se propaga a cada nivel del árbol: un `childProductId` ajeno
    // dentro de un combo propio se rechaza aquí, no al escribir el stock.
    const product = await this.loadProduct(tx, productId, tenantId, cache);

    switch (product.type) {
      case ProductType.SIMPLE: {
        if (!product.trackInventory) return;
        const key = effectKey(product.id, variantId);
        const current = effects.products.get(key);
        if (current) {
          current.quantity += multiplier;
        } else {
          effects.products.set(key, {
            productId: product.id,
            productName: product.name,
            quantity: multiplier,
            variantId,
          });
        }
        return;
      }

      case ProductType.RECIPE: {
        const recipeItems = product.recipe?.items ?? [];
        if (recipeItems.length === 0) {
          throw new BadRequestException(
            `El producto "${product.name}" es de tipo receta pero no tiene ingredientes configurados`,
          );
        }
        for (const ri of recipeItems) {
          const stockUnit = ri.supply.baseUnit?.symbol ?? ri.supply.unit;
          const needed =
            ri.normalizedQuantity != null
              ? Number(ri.normalizedQuantity) * multiplier
              : safeConvertUnits(Number(ri.quantity) * multiplier, ri.unit, stockUnit);
          const current = effects.supplies.get(ri.supply.id);
          if (current) {
            current.quantity += needed;
          } else {
            effects.supplies.set(ri.supply.id, {
              supplyId: ri.supply.id,
              supplyName: ri.supply.name,
              quantity: needed,
            });
          }
        }
        return;
      }

      case ProductType.COMBO: {
        for (const child of product.comboItems) {
          await this.expand(
            tx,
            child.childProductId,
            tenantId,
            multiplier * child.quantity,
            effects,
            cache,
            depth + 1,
            // Los hijos de un combo no llevan variante: se consumen por la suya
            // default. La variante del combo (si la tiene) es una presentación
            // del combo, no una selección de sus componentes.
            null,
          );
        }
        return;
      }

      // SERVICE products carry no inventory.
      default:
        return;
    }
  }

  /**
   * Carga un producto del árbol de expansión, ACOTADO AL TENANT del contexto.
   *
   * Antes era un `findUnique` por id: cualquier `productId` de otra organización
   * —llegado en el body de una comanda, o persistido como `childProductId` de un
   * combo— se resolvía sin más y su stock terminaba descontado. Ahora un id que
   * no pertenece al tenant simplemente no existe para el motor.
   *
   * Falla cerrado en vez de ignorar la línea en silencio: una venta que
   * referencia un producto inalcanzable es un error del llamador, y saltárselo
   * dejaría la orden creada sin su descuento de inventario. Es seguro para las
   * reversas porque `products.remove` prohíbe borrar un producto con
   * `orderItems`, así que toda orden histórica conserva sus productos.
   */
  private async loadProduct(
    tx: Prisma.TransactionClient,
    productId: string,
    tenantId: string,
    cache: Map<string, LoadedProduct | null>,
  ): Promise<LoadedProduct> {
    const cached = cache.get(productId);
    if (cached) return cached;

    const product = await tx.product.findFirst({
      where: { id: productId, tenantId },
      select: PRODUCT_LOAD_SELECT,
    });

    if (!product) {
      // Mensaje deliberadamente igual para "no existe" y "es de otro tenant":
      // distinguirlos confirmaría la existencia de un producto ajeno.
      throw new NotFoundException(
        `Producto ${productId} no encontrado en esta organización`,
      );
    }

    cache.set(productId, product);
    return product;
  }

  private note(prefix: string, ctx: InventoryContext): string {
    return ctx.note ? `${prefix}: ${ctx.note}` : prefix;
  }
}
