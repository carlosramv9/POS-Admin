import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * VariantInventoryResolver — traduce las llaves "viejas" (productId, branchId
 * opcional) a la llave nueva del inventario: (branchId, variantId).
 *
 * Existe para que la migración a inventario por variante NO obligue a reescribir
 * a los llamadores. POS, comanda, caja, compras y la tienda siguen hablando de
 * productos; este resolver es el único punto que sabe que, por debajo, el stock
 * vive en `branch_inventory` apuntando a una variante.
 *
 * Dos reglas de resolución:
 *
 *  - Variante: si el llamador no especifica una, se usa la variante `isDefault`
 *    del producto — la línea implícita "el producto en sí". Un índice único
 *    parcial en la base garantiza que hay exactamente una por producto.
 *
 *  - Sucursal: la explícita del contexto; si no hay (hoy el 82% de las órdenes
 *    no trae `branchId`), la sucursal `isMain` DEL TENANT DEL CONTEXTO. Si el
 *    tenant no tiene ninguna sucursal, devuelve null y el llamador cae al
 *    comportamiento legacy sobre `Product.stock`, que sigue vigente durante la
 *    fase expand.
 *
 * Aislamiento multi-tenant: `tenantId` es obligatorio en todos los métodos y
 * acota TODA resolución. Antes no lo era, y eso abría dos agujeros:
 *
 *   1. `ensureDefaultVariantId` creaba una `ProductVariant` sobre el producto de
 *      otro tenant (escritura cross-tenant).
 *   2. `resolveBranchId` derivaba la sucursal del tenant DUEÑO DEL PRODUCTO, así
 *      que un productId ajeno apuntaba el movimiento de stock directamente al
 *      inventario de la víctima.
 *
 * El tenant nunca se deduce del producto: siempre lo impone el llamador desde el
 * contexto de la petición (`TenantContextService` / `InventoryContext`).
 *
 * Todos los métodos reciben el `Prisma.TransactionClient` del llamador y nunca
 * abren su propia transacción, igual que los engines.
 */
@Injectable()
export class VariantInventoryResolver {
  /**
   * Variante contra la que se mueve el inventario de un producto. Devuelve null
   * si el producto no tiene variante default, lo que en la práctica solo puede
   * pasar con un producto creado por una ruta que no la sembró — el llamador
   * debe tratarlo como "sin inventario por variante" y no reventar.
   */
  async resolveVariantId(
    tx: Prisma.TransactionClient,
    productId: string,
    tenantId: string,
  ): Promise<string | null> {
    const variant = await tx.productVariant.findFirst({
      // El filtro viaja por la relación: `ProductVariant` no tiene `tenantId`
      // propio, su dueño es el producto.
      where: { productId, isDefault: true, product: { tenantId } },
      select: { id: true },
    });
    return variant?.id ?? null;
  }

  /**
   * Igual que `resolveVariantId`, pero crea la variante default si no existe.
   * Hace auto-reparable cualquier producto creado por una ruta que no la sembró
   * (importación, seeds antiguos), en vez de dejarlo silenciosamente sin
   * inventario. Devuelve null solo si el producto no existe.
   */
  async ensureDefaultVariantId(
    tx: Prisma.TransactionClient,
    productId: string,
    tenantId: string,
  ): Promise<string | null> {
    const existing = await this.resolveVariantId(tx, productId, tenantId);
    if (existing) return existing;

    // Acotado al tenant: un producto ajeno devuelve null en vez de recibir una
    // variante nueva. Sin este filtro, sembrar la variante era una escritura en
    // los datos de otra organización.
    const product = await tx.product.findFirst({
      where: { id: productId, tenantId },
      select: { price: true, costPrice: true, trackInventory: true },
    });
    if (!product) return null;

    const created = await tx.productVariant.create({
      data: {
        productId,
        name: null,
        isDefault: true,
        trackInventory: product.trackInventory,
        cost: product.costPrice ?? 0,
        price: product.price,
      },
      select: { id: true },
    });
    return created.id;
  }

  /**
   * Sucursal contra la que se carga el inventario: la explícita, o la `isMain`
   * DEL TENANT DEL CONTEXTO. Null cuando ese tenant no tiene sucursales.
   *
   * Antes la sucursal se derivaba de `product.tenantId`, de modo que un
   * `productId` ajeno resolvía la sucursal principal de la víctima y el delta de
   * stock caía sobre su inventario. El tenant lo impone ahora el llamador.
   */
  async resolveBranchId(
    tx: Prisma.TransactionClient,
    tenantId: string,
    branchId?: string | null,
  ): Promise<string | null> {
    if (branchId) return branchId;

    const main = await tx.branch.findFirst({
      where: { tenantId, isMain: true },
      select: { id: true },
    });
    return main?.id ?? null;
  }

  /**
   * Comprueba que una variante indicada por el llamador sea DE ESE producto y
   * DE ESE tenant, y devuelve su id.
   *
   * El `variantId` viaja en el body (línea del POS, de una compra, de un
   * ajuste), así que es entrada no confiable exactamente igual que `productId`.
   * Sin esta comprobación, un id ajeno acababa creando una fila de
   * `branch_inventory` que enlazaba una sucursal propia con la variante de otra
   * organización, y el movimiento se aplicaba sobre ella.
   *
   * Falla cerrado: una variante que no corresponde es un error del llamador, no
   * un motivo para caer en silencio sobre la default y descontar de otra línea.
   */
  async assertVariantOfProduct(
    tx: Prisma.TransactionClient,
    productId: string,
    tenantId: string,
    variantId: string,
  ): Promise<string> {
    const variant = await tx.productVariant.findFirst({
      where: { id: variantId, productId, product: { tenantId } },
      select: { id: true },
    });
    if (!variant) {
      throw new BadRequestException('La variante no pertenece a este producto');
    }
    return variant.id;
  }

  /**
   * Resuelve ambas llaves de una vez. `null` en cualquiera de las dos significa
   * que este producto no es direccionable en el inventario por variante todavía.
   *
   * `variantId` explícito manda: se verifica que sea del producto y se usa tal
   * cual. Antes, la sucursal y la variante se resolvían juntas y una variante
   * explícita SIN sucursal explícita se descartaba entera, cayendo en la
   * default — y como hoy la mayoría de las órdenes no trae `branchId`, vender
   * una talla concreta seguía descontando de "el producto en sí". Las dos
   * llaves se resuelven ahora por separado.
   */
  async resolve(
    tx: Prisma.TransactionClient,
    productId: string,
    tenantId: string,
    branchId?: string | null,
    variantId?: string | null,
  ): Promise<{ variantId: string; branchId: string } | null> {
    const [resolvedVariantId, resolvedBranchId] = await Promise.all([
      variantId
        ? this.assertVariantOfProduct(tx, productId, tenantId, variantId)
        : this.resolveVariantId(tx, productId, tenantId),
      this.resolveBranchId(tx, tenantId, branchId),
    ]);

    if (!resolvedVariantId || !resolvedBranchId) return null;
    return { variantId: resolvedVariantId, branchId: resolvedBranchId };
  }
}
