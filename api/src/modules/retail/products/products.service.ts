import { randomUUID } from 'crypto';
import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import sharp from 'sharp';
import { PrismaService } from '../../../database/prisma.service';
import { TenantContextService } from '../../../common/context/tenant-context.service';
import { AuditService } from '../../../common/services/audit.service';
import { BusinessConfigurationService } from '../../../common/business-config/business-configuration.service';
import { InventoryEngine } from '../inventory/inventory.engine';
import { VariantInventoryResolver } from '../inventory/variant-inventory.resolver';
import { R2Service } from '../../../storage/r2.service';
import { SlugUtil } from '../../../common/utils/slug.util';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { QueryProductDto } from './dto/query-product.dto';
import { PaginatedResponse } from '../../../common/dto/pagination.dto';
import { Product, Prisma } from '@prisma/client';
import { AiUsageRecorder } from '../../../ai/usage/ai-usage.recorder';

const MAX_IMAGE_WIDTH = 1200;

const PRODUCT_INCLUDE = {
  category: true,
  images: { orderBy: { sortOrder: 'asc' as const } },
  recipe: {
    include: {
      items: {
        include: {
          supply: { include: { inventoryUnit: true, baseUnit: true } },
        },
      },
    },
  },
  comboItems: { include: { child: true } },
  // La default primero: es la línea "el producto en sí" y encabeza la lista.
  variants: { orderBy: [{ isDefault: 'desc' as const }, { name: 'asc' as const }] },
  // Existencias por sucursal y variante — la fuente de verdad del stock.
  branchInventory: {
    select: { branchId: true, variantId: true, stock: true, price: true, cost: true, lowStockAlert: true },
  },
  features: true,
  _count: { select: { orderItems: true } },
} satisfies Prisma.ProductInclude;

type ProductWithRelations = Prisma.ProductGetPayload<{ include: typeof PRODUCT_INCLUDE }>;

/**
 * Valores comerciales de una variante para UNA sucursal — la del contexto.
 *
 * Precio, costo y existencia de una variante viven en `branch_inventory` por
 * (sucursal, variante), así que no existe "el precio de la variante": existe el
 * de cada sucursal. Editar uno jamás toca el de otra sucursal, y menos el de
 * otro tenant. `branchId` null (token sin sucursal asignada) significa que no
 * hay ninguna a la que aplicar los valores capturados.
 */
interface VariantBranchValues {
  branchId: string | null;
  stock?: number;
  price?: number;
  cost?: number;
}

@Injectable()
export class ProductsService {
  constructor(
    private prisma: PrismaService,
    private tenantContext: TenantContextService,
    private audit: AuditService,
    private r2: R2Service,
    // BR-02: recipes are a Restaurant-only capability. Availability is decided
    // exclusively through the business configuration facade — the service never
    // reads BusinessProfile. Combos and SIMPLE/SERVICE products are unaffected.
    private businessConfig: BusinessConfigurationService,
    // Fase 2A: la escritura de stock y el asiento de movimiento se delegan al
    // motor de inventario de bajo nivel. Las validaciones de negocio (tipo
    // SIMPLE, trackInventory, guard de stock) permanecen en este servicio.
    private inventoryEngine: InventoryEngine,
    // Resuelve la sucursal contra la que se carga una existencia cuando el token
    // no trae una (la `isMain` del tenant). La existencia inicial de una variante
    // pertenece a UNA sucursal, nunca a todas — ver `seedBranchInventory`.
    private variantResolver: VariantInventoryResolver,
    // Fase 3 (AI Product Assistant): registra el desenlace de un draft de IA
    // cuando el producto que se crea vino de uno — ver `aiRequestId` en el DTO.
    // Nunca decide qué se crea, y su fallo nunca debe tumbar la creación.
    private aiUsageRecorder: AiUsageRecorder,
  ) {}

  private readonly logger = new Logger(ProductsService.name);

  /**
   * BR-02: gate recipe capabilities behind the `enableRecipes` feature. Throws
   * when the tenant's business configuration does not support recipes (e.g.
   * RETAIL). Restaurant (feature on) is unaffected. Only recipe entry points
   * call this — no sale/inventory/combo flow goes through here.
   */
  private async assertRecipesEnabled(): Promise<void> {
    if (!(await this.businessConfig.hasFeature('enableRecipes'))) {
      throw new ForbiddenException(
        'Las recetas no están disponibles para este tipo de negocio',
      );
    }
  }

  /**
   * Comprueba que los insumos referenciados por una receta sean de este tenant.
   *
   * El producto padre siempre se resuelve con `findFirst({ id, tenantId })`, pero
   * los `supplyId` viajaban en el body y se insertaban tal cual. Un id ajeno
   * persistido se volvía explotable al vender: `InventoryConsumptionEngine`
   * expandía la receta y descontaba el insumo de la otra organización.
   */
  private async assertSuppliesInTenant(
    db: { supply: { findMany: (args: any) => Promise<{ id: string }[]> } },
    tenantId: string,
    supplyIds: string[],
  ): Promise<void> {
    const unique = [...new Set(supplyIds)];
    if (unique.length === 0) return;

    const owned = await db.supply.findMany({
      where: { id: { in: unique }, tenantId },
      select: { id: true },
    });
    if (owned.length !== unique.length) {
      throw new NotFoundException('Alguno de los insumos no existe en esta empresa');
    }
  }

  /**
   * Comprueba que los hijos de un combo sean de este tenant. Mismo razonamiento
   * que `assertSuppliesInTenant`: un `childProductId` ajeno persistido hacía que
   * vender el combo descontara el stock del producto de otra organización, y que
   * `GET /products/:id` devolviera su fila completa (costo incluido) a través de
   * `comboItems.include.child`.
   */
  private async assertChildProductsInTenant(
    db: { product: { findMany: (args: any) => Promise<{ id: string }[]> } },
    tenantId: string,
    childProductIds: string[],
  ): Promise<void> {
    const unique = [...new Set(childProductIds)];
    if (unique.length === 0) return;

    const owned = await db.product.findMany({
      where: { id: { in: unique }, tenantId },
      select: { id: true },
    });
    if (owned.length !== unique.length) {
      throw new NotFoundException('Alguno de los productos del combo no existe en esta empresa');
    }
  }

  private async resolveNormalizedQty(
    db: any,
    tenantId: string,
    item: { supplyId: string; quantity: number; unitId?: string | null },
  ): Promise<number | null> {
    if (!item.unitId) return null;

    const supply = await db.supply.findFirst({
      where: { id: item.supplyId, tenantId },
      select: { inventoryUnitId: true, baseUnitId: true, conversionFactor: true },
    });

    if (!supply) return null;

    const convFactor = Number(supply.conversionFactor ?? 1) || 1;

    if (item.unitId === supply.inventoryUnitId) {
      return item.quantity * convFactor;
    }
    if (item.unitId === supply.baseUnitId) {
      return item.quantity;
    }

    // Legacy: supplyAllowedUnit lookup
    const [allowed, unit] = await Promise.all([
      db.supplyAllowedUnit.findUnique({
        where: { supplyId_unitId: { supplyId: item.supplyId, unitId: item.unitId } },
      }),
      db.measurementUnit.findUnique({ where: { id: item.unitId } }),
    ]);
    const factor = allowed ? Number(allowed.conversionFactor) : (unit ? Number(unit.baseFactor) : 1);
    return item.quantity * factor;
  }

  async create(createProductDto: CreateProductDto): Promise<Product> {
    const tenantId = this.tenantContext.requireTenantId();
    const { recipeItems, comboItems, variants, features, aiRequestId, aiOutcome, ...productData } = createProductDto;

    const existingProduct = await this.prisma.product.findUnique({
      where: { tenantId_sku: { tenantId, sku: productData.sku } },
    });

    if (existingProduct) {
      throw new ConflictException('SKU already exists');
    }

    if (productData.categoryId) {
      const category = await this.prisma.category.findFirst({
        where: { id: productData.categoryId, tenantId },
      });

      if (!category) {
        throw new NotFoundException('Category not found');
      }
    }

    const existingSlugs = await this.prisma.product.findMany({
      where: { tenantId },
      select: { slug: true },
    });

    const slug = SlugUtil.generateUnique(
      productData.name,
      existingSlugs.map((p) => p.slug),
    );

    // RECIPE/COMBO/SERVICE don't track product stock
    const type = productData.type ?? 'SIMPLE';
    // BR-02: only RECIPE products require the recipes capability. COMBO and
    // SERVICE remain available on every vertical (combos stay independent).
    if (type === 'RECIPE') await this.assertRecipesEnabled();
    if (type !== 'SIMPLE') {
      productData.trackInventory = false;
      productData.stock = 0;
    }

    // Precio, costo y existencia de una variante son SIEMPRE de una sucursal
    // concreta: la del contexto (derivada del token, nunca del body). Las demás
    // sucursales reciben su fila —o la variante sería invendible ahí— pero con
    // los valores del producto, nunca con los capturados aquí.
    const branchId = this.tenantContext.getBranchId() ?? null;

    const product = await this.prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: { ...productData, type, tenantId, slug },
        include: PRODUCT_INCLUDE,
      });

      // Sucursal a la que pertenecen las existencias capturadas en el alta: la
      // del contexto y, con un token sin sucursal, la `isMain` del tenant. Es
      // UNA, nunca todas: el stock inicial no se replica (ver seedBranchInventory).
      const stockBranchId = await this.variantResolver.resolveBranchId(tx, tenantId, branchId);

      // Toda alta necesita su variante default — la línea implícita "el producto
      // en sí", que es la que lleva el inventario — y una fila de existencias por
      // cada sucursal activa. Sin esas filas el producto nacería invendible.
      const defaultVariant = await tx.productVariant.create({
        data: {
          productId: created.id,
          name: null,
          isDefault: true,
          trackInventory: created.trackInventory,
          cost: created.costPrice ?? 0,
          price: created.price,
        },
        select: { id: true },
      });
      await this.seedBranchInventory(tx, tenantId, created, [defaultVariant.id], {
        branchId: stockBranchId,
        stock: created.stock,
      });

      if (type === 'RECIPE' && recipeItems?.length) {
        await this.assertSuppliesInTenant(tx, tenantId, recipeItems.map((i) => i.supplyId));
        const normalizedItems = await Promise.all(
          recipeItems.map(async (i) => ({
            supplyId: i.supplyId,
            quantity: i.quantity,
            unit: i.unit,
            unitId: i.unitId ?? null,
            normalizedQuantity: await this.resolveNormalizedQty(tx, tenantId, i),
          })),
        );
        await tx.recipe.create({
          data: {
            productId: created.id,
            items: { create: normalizedItems },
          },
        });
      }

      if (type === 'COMBO' && comboItems?.length) {
        await this.assertChildProductsInTenant(tx, tenantId, comboItems.map((ci) => ci.childProductId));
        await tx.comboItem.createMany({
          data: comboItems.map((ci) => ({
            comboProductId: created.id,
            childProductId: ci.childProductId,
            quantity: ci.quantity ?? 1,
          })),
        });
      }

      if (variants?.length) {
        // Una a una, no `createMany`: cada variante siembra sus existencias con
        // SUS valores, y `createMany` no devuelve ids — releerlas después
        // perdería la correspondencia con la fila del DTO de la que salieron.
        for (const variant of variants) {
          const createdVariant = await tx.productVariant.create({
            data: {
              productId: created.id,
              name: variant.name,
              // Misma política de inventario que la default: `trackInventory` es
              // del producto, no de la variante. Sin esto una variante de un
              // RECIPE/COMBO/SERVICE nacía rastreando stock que ese tipo no lleva.
              trackInventory: created.trackInventory,
              cost: variant.cost ?? 0,
              price: variant.price ?? 0,
            },
            select: { id: true },
          });
          // Las variantes con nombre también necesitan existencias propias por
          // sucursal, o quedarían sin precio ni stock donde se vendan.
          await this.seedBranchInventory(tx, tenantId, created, [createdVariant.id], {
            branchId: stockBranchId,
            stock: variant.stock ?? 0,
            price: variant.price,
            cost: variant.cost,
          });
        }
      }

      if (features?.length) {
        await tx.productFeature.createMany({
          data: features.map((f) => ({
            productId: created.id,
            feature: f.feature,
            value: f.value,
          })),
        });
      }

      // Siempre se relee: la variante default y sus filas de existencias se
      // crean después del `create`, así que `created` nunca las trae.
      return tx.product.findUnique({
        where: { id: created.id },
        include: PRODUCT_INCLUDE,
      }) as Promise<Product>;
    });

    if (aiRequestId) {
      // Efecto secundario, no crítico: si falla, el producto ya se creó y
      // eso es lo que importa. Nunca debe tumbar la respuesta al usuario.
      this.aiUsageRecorder.recordOutcome(aiRequestId, aiOutcome ?? 'ACCEPTED').catch((err: unknown) => {
        this.logger.warn(
          `No se pudo registrar el outcome del draft de IA ${aiRequestId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }

    return product;
  }

  /**
   * Adjunta a cada variante su existencia y sus valores comerciales efectivos.
   *
   * El stock vive en `branch_inventory` por (sucursal, variante), pero la UI
   * muestra un número por variante: se usa el de la sucursal del contexto y, si
   * no hay ninguna seleccionada, la suma de todas — que es lo que el usuario
   * entiende por "cuánto tengo".
   *
   * `stockByBranch` se incluye para que la UI pueda desglosar sin otra llamada.
   */
  private attachVariantStock(product: ProductWithRelations, branchId: string | null) {
    const { branchInventory, variants, ...rest } = product;
    // Defensivo: hay lecturas que proyectan el producto sin estas relaciones.
    const allRows = branchInventory ?? [];

    const enrichedVariants = (variants ?? []).map((variant) => {
      const rows = allRows.filter((row) => row.variantId === variant.id);
      const scoped = branchId ? rows.filter((row) => row.branchId === branchId) : rows;
      const source = scoped[0];

      return {
        ...variant,
        stock: scoped.reduce((total, row) => total + row.stock, 0),
        // Precio y costo efectivos: los de la sucursal en contexto, con respaldo
        // en los valores legacy de la variante mientras dure la fase expand.
        price: source?.price ?? variant.price,
        cost: source?.cost ?? variant.cost,
        lowStockAlert: source?.lowStockAlert ?? null,
        stockByBranch: rows.map((row) => ({ branchId: row.branchId, stock: row.stock })),
      };
    });

    return {
      ...rest,
      variants: enrichedVariants,
      // `stock` a nivel producto = suma de sus variantes, para no romper las
      // pantallas que todavía leen un escalar.
      //
      // Sin ninguna fila de inventario se conserva el valor legacy del producto:
      // los tenants que aún no tienen sucursales no tienen dónde guardar
      // existencias por variante, y devolver 0 ocultaría su stock real.
      stock: allRows.length
        ? enrichedVariants.reduce((total, variant) => total + variant.stock, 0)
        : rest.stock,
    };
  }

  /**
   * Crea la fila de existencias de cada variante en todas las sucursales activas
   * del tenant, copiando los valores comerciales del producto.
   *
   * Los valores capturados (`overrides`) pertenecen a UNA sola sucursal: la que
   * indica `overrides.branchId`. Esa fila recibe el precio, el costo y la
   * existencia capturados; las del resto de sucursales se crean —para que la
   * variante sea vendible ahí— con los valores del producto y existencia 0.
   *
   * La existencia NUNCA se replica. Antes, sembrar la variante default sin
   * `overrides` copiaba `product.stock` en todas las sucursales activas, de modo
   * que un alta con 10 unidades en un tenant de tres sucursales nacía con 30.
   * Unas existencias iniciales son de la sucursal donde se dieron de alta; el
   * resto arranca en cero y se surte con una transferencia o una compra.
   *
   * `skipDuplicates` la hace idempotente, de modo que volver a sembrar una
   * variante existente no rompe.
   */
  private async seedBranchInventory(
    tx: Prisma.TransactionClient,
    tenantId: string,
    product: Product,
    variantIds: string[],
    overrides: VariantBranchValues,
  ): Promise<void> {
    if (variantIds.length === 0) return;

    const branches = await tx.branch.findMany({
      where: { tenantId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (branches.length === 0) return;

    await tx.branchInventory.createMany({
      data: branches.flatMap((branch) => {
        // Solo la sucursal destino ve los valores capturados. Sin sucursal
        // destino (`branchId` null) ninguna lo es, y la variante nace con los
        // valores del producto y existencia 0 en todas — nunca con el precio ni
        // con las existencias de otra.
        const scoped = overrides.branchId === branch.id;
        return variantIds.map((variantId) => ({
          branchId: branch.id,
          productId: product.id,
          variantId,
          stock: scoped ? (overrides.stock ?? 0) : 0,
          cost: scoped && overrides.cost !== undefined ? overrides.cost : product.costPrice,
          price: scoped && overrides.price !== undefined ? overrides.price : product.price,
          comparePrice: product.comparePrice,
          lastCost: product.lastCost,
          avgCost: product.avgCost,
          lowStockAlert: product.lowStockAlert,
        }));
      }),
      skipDuplicates: true,
    });
  }

  async findAll(queryDto: QueryProductDto): Promise<PaginatedResponse<Product>> {
    const { skip, limit, page, search, categoryId, status, type } = queryDto;
    const tenantId = this.tenantContext.requireTenantId();
    const where: Prisma.ProductWhereInput = { tenantId };

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { sku: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (categoryId) where.categoryId = categoryId;
    if (status) where.status = status;
    if (type) where.type = type;

    const [products, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: PRODUCT_INCLUDE,
      }),
      this.prisma.product.count({ where }),
    ]);

    const branchId = this.tenantContext.getBranchId() ?? null;

    return {
      data: products.map((product) => this.attachVariantStock(product, branchId)) as Product[],
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findOne(id: string): Promise<Product> {
    const tenantId = this.tenantContext.requireTenantId();
    const product = await this.prisma.product.findFirst({
      where: { id, tenantId },
      include: PRODUCT_INCLUDE,
    });

    if (!product) throw new NotFoundException('Product not found');
    return this.attachVariantStock(product, this.tenantContext.getBranchId() ?? null) as Product;
  }

  async update(id: string, updateProductDto: UpdateProductDto): Promise<Product> {
    const tenantId = this.tenantContext.requireTenantId();
    const product = await this.prisma.product.findFirst({ where: { id, tenantId } });

    if (!product) throw new NotFoundException('Product not found');

    const { recipeItems, comboItems, variants, features, ...productData } = updateProductDto;

    if (productData.categoryId) {
      const category = await this.prisma.category.findUnique({
        where: { id: productData.categoryId },
      });

      if (!category) throw new NotFoundException('Category not found');
    }

    let slug = product.slug;
    if (productData.name && productData.name !== product.name) {
      const existingSlugs = await this.prisma.product.findMany({
        where: { tenantId, id: { not: id } },
        select: { slug: true },
      });

      slug = SlugUtil.generateUnique(
        productData.name,
        existingSlugs.map((p) => p.slug),
      );
    }

    const newType = productData.type ?? product.type;
    if (newType !== 'SIMPLE') {
      productData.trackInventory = false;
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const updatedProduct = await tx.product.update({
        where: { id },
        data: { ...productData, slug },
        include: PRODUCT_INCLUDE,
      });

      // Sync recipe items
      if (newType === 'RECIPE' && recipeItems !== undefined) {
        await this.assertSuppliesInTenant(tx, tenantId, recipeItems.map((i) => i.supplyId));
        const existingRecipe = await tx.recipe.findUnique({ where: { productId: id } });
        if (existingRecipe) {
          await tx.recipeItem.deleteMany({ where: { recipeId: existingRecipe.id } });
          if (recipeItems.length > 0) {
            const normalizedItems = await Promise.all(
              recipeItems.map(async (i) => ({
                recipeId: existingRecipe.id,
                supplyId: i.supplyId,
                quantity: i.quantity,
                unit: i.unit,
                unitId: i.unitId ?? null,
                normalizedQuantity: await this.resolveNormalizedQty(tx, tenantId, i),
              })),
            );
            await tx.recipeItem.createMany({ data: normalizedItems });
          }
        } else if (recipeItems.length > 0) {
          const normalizedItems = await Promise.all(
            recipeItems.map(async (i) => ({
              supplyId: i.supplyId,
              quantity: i.quantity,
              unit: i.unit,
              unitId: i.unitId ?? null,
              normalizedQuantity: await this.resolveNormalizedQty(tx, tenantId, i),
            })),
          );
          await tx.recipe.create({
            data: {
              productId: id,
              items: { create: normalizedItems },
            },
          });
        }
      }

      // Sync combo items
      if (newType === 'COMBO' && comboItems !== undefined) {
        await this.assertChildProductsInTenant(tx, tenantId, comboItems.map((ci) => ci.childProductId));
        await tx.comboItem.deleteMany({ where: { comboProductId: id } });
        if (comboItems.length > 0) {
          await tx.comboItem.createMany({
            data: comboItems.map((ci) => ({
              comboProductId: id,
              childProductId: ci.childProductId,
              quantity: ci.quantity ?? 1,
            })),
          });
        }
      }

      // Sincronización de variantes por id, NO reemplazo completo.
      //
      // `branch_inventory` cuelga de `variantId` con borrado en cascada: un
      // deleteMany aquí se llevaría por delante las existencias de todas las
      // sucursales cada vez que alguien guarda el producto. Se conserva la
      // variante default (nunca llega en el DTO — es interna) y las que traen id.
      if (variants !== undefined) {
        // Igual que en el alta: los valores capturados son de la sucursal en
        // contexto, que sale del token — nunca del body.
        const branchId = this.tenantContext.getBranchId() ?? null;
        // Sucursal que recibe la existencia inicial de una variante NUEVA. Con un
        // token sin sucursal se usa la `isMain`: la existencia capturada tiene que
        // aterrizar en algún sitio o se pierde en silencio. El precio de una
        // variante YA existente sigue exigiendo sucursal explícita (más abajo):
        // ahí no hay nada que perder y adivinar propagaría un precio a ciegas.
        const stockBranchId = await this.variantResolver.resolveBranchId(tx, tenantId, branchId);
        const existing = await tx.productVariant.findMany({
          where: { productId: id },
          select: { id: true, isDefault: true },
        });

        // ADR-0030, regla 4: la default SE PROMUEVE, no se elimina.
        //
        // Al configurar la primera presentación, la variante default —"el
        // producto en sí", sin nombre— se renombra conservando su id, su
        // existencia en todas las sucursales y su historial de ventas. Antes se
        // conservaba intacta junto a las nuevas, así que el producto acababa con
        // una línea fantasma que seguía cargando el stock y contra la que
        // descontaban todas las ventas.
        //
        // Solo aplica cuando el producto todavía no tiene presentaciones: con
        // una ya configurada, la default ya fue promovida y las siguientes se
        // agregan normal.
        const defaultVariant = existing.find((v) => v.isDefault);
        const soloTieneDefault = existing.length === 1 && defaultVariant !== undefined;
        const nuevasConNombre = variants.filter((v) => !v.id);
        const aPromover =
          soloTieneDefault && nuevasConNombre.length > 0 ? nuevasConNombre[0] : null;

        if (aPromover && defaultVariant) {
          await tx.productVariant.update({
            where: { id: defaultVariant.id },
            data: {
              name: aPromover.name,
              isDefault: false,
              cost: aPromover.cost ?? 0,
              price: aPromover.price ?? 0,
            },
          });
          // Sus filas de `branch_inventory` ya existen y conservan la existencia:
          // solo se actualizan los valores comerciales de la sucursal en
          // contexto, igual que al editar cualquier variante. La existencia NO se
          // toca — repartir el stock que había suelto entre las presentaciones es
          // un ajuste de inventario explícito, con su movimiento (ADR-0030).
          const promovida: Prisma.BranchInventoryUpdateManyMutationInput = {
            ...(aPromover.cost !== undefined ? { cost: aPromover.cost } : {}),
            ...(aPromover.price !== undefined ? { price: aPromover.price } : {}),
          };
          if (branchId && Object.keys(promovida).length > 0) {
            await tx.branchInventory.updateMany({
              where: { variantId: defaultVariant.id, branchId, productId: id },
              data: promovida,
            });
          }
        }

        // La default ya no se conserva por serlo: si fue promovida, sobrevive
        // como la presentación en la que se convirtió; si no, se conserva porque
        // el producto sigue sin presentaciones y ella ES el producto.
        const keepIds = new Set<string>();
        if (defaultVariant && !aPromover) keepIds.add(defaultVariant.id);
        if (aPromover && defaultVariant) keepIds.add(defaultVariant.id);

        for (const variant of variants) {
          // La que promovió a la default ya está aplicada: crearla otra vez
          // duplicaría la presentación.
          if (variant === aPromover) continue;

          if (variant.id && existing.some((v) => v.id === variant.id)) {
            keepIds.add(variant.id);
            await tx.productVariant.update({
              where: { id: variant.id },
              data: { name: variant.name, cost: variant.cost ?? 0, price: variant.price ?? 0 },
            });
            // Los valores efectivos son los de `branch_inventory`: sin esto,
            // cambiar el precio de una variante existente no se vería en
            // ninguna venta. El `where` acota a la sucursal en contexto — un
            // `updateMany` sin `branchId` pondría el precio de esta sucursal en
            // todas las demás. Sin sucursal en contexto no se escribe nada:
            // renombrar sigue funcionando, el precio no se propaga a ciegas.
            //
            // `stock` no se toca aquí a propósito: la existencia se mueve por
            // movimientos de inventario, no por guardar el formulario.
            const branchValues: Prisma.BranchInventoryUpdateManyMutationInput = {
              ...(variant.cost !== undefined ? { cost: variant.cost } : {}),
              ...(variant.price !== undefined ? { price: variant.price } : {}),
            };
            if (branchId && Object.keys(branchValues).length > 0) {
              await tx.branchInventory.updateMany({
                where: { variantId: variant.id, branchId, productId: id },
                data: branchValues,
              });
            }
          } else {
            const created = await tx.productVariant.create({
              data: {
                productId: id,
                name: variant.name,
                // Misma política de inventario que el producto — ver el alta.
                trackInventory: updatedProduct.trackInventory,
                cost: variant.cost ?? 0,
                price: variant.price ?? 0,
              },
              select: { id: true },
            });
            keepIds.add(created.id);
            // `updatedProduct`, no `product`: este último es el snapshot ANTERIOR
            // al update. Con el viejo, una variante añadida en el mismo guardado
            // que cambia el precio del producto heredaba el precio anterior en
            // todas las sucursales menos la del contexto.
            await this.seedBranchInventory(tx, tenantId, updatedProduct, [created.id], {
              branchId: stockBranchId,
              stock: variant.stock ?? 0,
              price: variant.price,
              cost: variant.cost,
            });
          }
        }

        // Solo se eliminan las que el usuario realmente quitó.
        const removed = existing.filter((v) => !keepIds.has(v.id)).map((v) => v.id);

        // Degradación: quitar la ÚLTIMA presentación no deja al producto sin
        // ninguna variante. La última se degrada de vuelta a default (sin
        // nombre) conservando su existencia y su historial, que es el camino
        // inverso exacto de la promoción.
        //
        // Todo producto tiene siempre exactamente una variante: sin ella no es
        // direccionable en el inventario y deja de ser vendible. Borrarla
        // además arrastraría en cascada sus filas de `branch_inventory`.
        const sobreviven = existing.filter((v) => keepIds.has(v.id)).length;
        if (sobreviven === 0 && removed.length > 0) {
          const [aDegradar, ...resto] = removed;
          await tx.productVariant.update({
            where: { id: aDegradar },
            data: { name: null, isDefault: true },
          });
          if (resto.length > 0) {
            await tx.productVariant.deleteMany({ where: { id: { in: resto } } });
          }
        } else if (removed.length > 0) {
          await tx.productVariant.deleteMany({ where: { id: { in: removed } } });
        }
      }

      // Sync features (full replace — optional spec sheet)
      if (features !== undefined) {
        await tx.productFeature.deleteMany({ where: { productId: id } });
        if (features.length > 0) {
          await tx.productFeature.createMany({
            data: features.map((f) => ({
              productId: id,
              feature: f.feature,
              value: f.value,
            })),
          });
        }
      }

      return tx.product.findUnique({ where: { id }, include: PRODUCT_INCLUDE }) as Promise<Product>;
    });

    if (
      productData.price != null &&
      Number(productData.price) !== Number(product.price)
    ) {
      await this.audit.log({
        action: 'PRICE_CHANGE',
        entityType: 'Product',
        entityId: id,
        before: { price: Number(product.price) },
        after: { price: Number(productData.price) },
      });
    }

    return updated;
  }

  async remove(id: string): Promise<void> {
    const tenantId = this.tenantContext.requireTenantId();
    const product = await this.prisma.product.findFirst({
      where: { id, tenantId },
      include: { orderItems: true, images: true },
    });

    if (!product) throw new NotFoundException('Product not found');

    if (product.orderItems.length > 0) {
      throw new BadRequestException('Cannot delete product with existing orders');
    }

    await Promise.all(
      product.images.flatMap((img) =>
        img.key ? [this.r2.delete(img.key)] : [],
      ),
    );

    await this.prisma.product.delete({ where: { id } });
  }

  async uploadImage(productId: string, file: Express.Multer.File) {
    const tenantId = this.tenantContext.requireTenantId();

    const product = await this.prisma.product.findFirst({
      where: { id: productId, tenantId },
      include: { images: { where: { isPrimary: true } } },
    });

    if (!product) throw new NotFoundException('Product not found');

    const webpBuffer = await sharp(file.buffer)
      .resize({ width: MAX_IMAGE_WIDTH, withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();

    const imageId = randomUUID();
    const key = this.r2.buildKey(tenantId, productId, imageId);
    const url = await this.r2.upload(key, webpBuffer, 'image/webp');

    const oldPrimary = product.images?.[0];

    return this.prisma.$transaction(async (tx) => {
      if (oldPrimary) {
        await tx.productImage.delete({ where: { id: oldPrimary.id } });
      }

      const image = await tx.productImage.create({
        data: {
          id: imageId,
          productId,
          url,
          key,
          mimeType: 'image/webp',
          size: webpBuffer.length,
          isPrimary: true,
          sortOrder: 0,
        },
      });

      if (oldPrimary?.key) {
        await this.r2.delete(oldPrimary.key);
      }

      return image;
    });
  }

  async removeImage(productId: string, imageId: string) {
    const tenantId = this.tenantContext.requireTenantId();

    const image = await this.prisma.productImage.findFirst({
      where: { id: imageId, productId, product: { tenantId } },
    });

    if (!image) throw new NotFoundException('Image not found');

    await this.prisma.productImage.delete({ where: { id: imageId } });

    if (image.key) {
      await this.r2.delete(image.key);
    }
  }

  async updateStock(id: string, quantity: number): Promise<Product> {
    const tenantId = this.tenantContext.requireTenantId();
    const product = await this.prisma.product.findFirst({ where: { id, tenantId } });

    if (!product) throw new NotFoundException('Product not found');

    if (product.type !== 'SIMPLE') {
      throw new BadRequestException('Solo productos SIMPLE manejan stock directo');
    }

    if (!product.trackInventory) {
      throw new BadRequestException('Product does not track inventory');
    }

    const branchId = this.tenantContext.getBranchId() ?? null;

    // Flujo de ajuste oficial: la baja/alta de stock y su movimiento AJUSTE van
    // juntos en una transacción, delegados al InventoryEngine.
    //
    // El guard de existencia lo aplica la base DENTRO de la transacción. Antes se
    // validaba en JS con un stock leído fuera de ella, lo que dejaba una ventana
    // TOCTOU: una venta concurrente entre la lectura y la escritura podía dejar
    // el stock en negativo.
    const updated = await this.prisma.$transaction(async (tx) => {
      const applied = await this.inventoryEngine.applyProductStockDelta(tx, {
        productId: id,
        tenantId,
        delta: quantity,
        guardInsufficient: quantity < 0,
        branchId,
      });
      if (!applied) throw new BadRequestException('Insufficient stock');

      if (quantity !== 0) {
        await this.inventoryEngine.recordProductMovement(tx, {
          tenantId,
          type: 'AJUSTE',
          productId: id,
          quantity,
          referenceId: id,
          referenceType: 'PRODUCT_ADJUST',
          notes: `Ajuste manual (${quantity >= 0 ? '+' : ''}${quantity})`,
        });
      }
      return tx.product.findFirstOrThrow({ where: { id, tenantId } });
    });

    await this.audit.log({
      action: 'INVENTORY_ADJUST',
      entityType: 'Product',
      entityId: id,
      before: { stock: product.stock },
      after: { stock: updated.stock },
      reason: `Ajuste manual (${quantity >= 0 ? '+' : ''}${quantity})`,
    });

    return updated;
  }

  /**
   * Ajusta la existencia de UNA variante concreta en la sucursal en contexto.
   *
   * Hasta ahora no existía ninguna forma de mover la existencia de una variante
   * con nombre después de crearla: `updateStock`, el ajuste por sucursal, el
   * conteo masivo y las transferencias apuntaban todos a la default. Una talla
   * nacía con su número y se quedaba congelada ahí para siempre.
   *
   * Mismas garantías que `updateStock`: delta + `InventoryMovement` en una sola
   * transacción, y el guard de existencia lo aplica la base DENTRO de ella para
   * que una venta concurrente no pueda dejar el stock en negativo.
   */
  async updateVariantStock(productId: string, variantId: string, quantity: number): Promise<Product> {
    const tenantId = this.tenantContext.requireTenantId();
    const product = await this.prisma.product.findFirst({ where: { id: productId, tenantId } });
    if (!product) throw new NotFoundException('Product not found');

    if (product.type !== 'SIMPLE') {
      throw new BadRequestException('Solo productos SIMPLE manejan stock directo');
    }

    const variant = await this.prisma.productVariant.findFirst({
      where: { id: variantId, productId, product: { tenantId } },
      select: { id: true, name: true, trackInventory: true },
    });
    if (!variant) throw new NotFoundException('Variante no encontrada en este producto');
    if (!variant.trackInventory) {
      throw new BadRequestException('Esta variante no rastrea inventario');
    }

    const branchId = this.tenantContext.getBranchId() ?? null;
    const before = await this.prisma.$transaction((tx) =>
      this.inventoryEngine.getProductStock(tx, productId, tenantId, branchId, variantId),
    );

    await this.prisma.$transaction(async (tx) => {
      const applied = await this.inventoryEngine.applyProductStockDelta(tx, {
        productId,
        tenantId,
        delta: quantity,
        guardInsufficient: quantity < 0,
        branchId,
        variantId,
      });
      if (!applied) throw new BadRequestException('Insufficient stock');

      if (quantity !== 0) {
        await this.inventoryEngine.recordProductMovement(tx, {
          tenantId,
          type: 'AJUSTE',
          productId,
          variantId,
          branchId,
          quantity,
          referenceId: variantId,
          referenceType: 'VARIANT_ADJUST',
          notes: `Ajuste manual de "${variant.name ?? 'sin variante'}" (${quantity >= 0 ? '+' : ''}${quantity})`,
        });
      }
    });

    const after = await this.prisma.$transaction((tx) =>
      this.inventoryEngine.getProductStock(tx, productId, tenantId, branchId, variantId),
    );

    await this.audit.log({
      action: 'INVENTORY_ADJUST',
      entityType: 'ProductVariant',
      entityId: variantId,
      before: { stock: before },
      after: { stock: after },
      reason: `Ajuste manual de variante (${quantity >= 0 ? '+' : ''}${quantity})`,
    });

    return this.findOne(productId);
  }

  /**
   * Productos bajo su punto de reorden. La comparación stock ≤ mínimo ahora vive
   * entera en `branch_inventory` (antes cruzaba dos columnas de `products` con un
   * field reference), y se acota a la sucursal del contexto cuando la hay.
   *
   * Devuelve forma de producto, con `stock`/`lowStockAlert` tomados de la fila de
   * la sucursal, para no romper el contrato del endpoint.
   */
  async getLowStock(limit = 10) {
    const tenantId = this.tenantContext.requireTenantId();
    const branchId = this.tenantContext.getBranchId() ?? null;

    const rows = await this.prisma.branchInventory.findMany({
      where: {
        ...(branchId ? { branchId } : { branch: { tenantId } }),
        stock: { lte: this.prisma.branchInventory.fields.lowStockAlert },
        variant: { trackInventory: true },
        product: { tenantId, type: 'SIMPLE', status: 'ACTIVE' },
      },
      take: limit,
      orderBy: { stock: 'asc' },
      include: {
        product: { include: { category: true } },
        variant: { select: { id: true, name: true, isDefault: true } },
      },
    });

    // Cada fila es una variante en una sucursal, así que un producto con varias
    // variantes bajas aparece varias veces. Se identifica cuál: sin `variantId`
    // ni `variantName` la lista repetía el mismo producto sin decir qué reponer.
    // `variantName` es null en la variante default — ahí la línea ES el producto.
    return rows.map((row) => ({
      ...row.product,
      stock: row.stock,
      lowStockAlert: row.lowStockAlert,
      branchId: row.branchId,
      variantId: row.variantId,
      variantName: row.variant.isDefault ? null : row.variant.name,
    }));
  }

  async getRecipe(productId: string) {
    await this.assertRecipesEnabled();
    const tenantId = this.tenantContext.requireTenantId();
    const product = await this.prisma.product.findFirst({
      where: { id: productId, tenantId, type: 'RECIPE' },
    });
    if (!product) throw new NotFoundException('Producto tipo RECIPE no encontrado');

    return this.prisma.recipe.findUnique({
      where: { productId },
      include: { items: { include: { supply: true } } },
    });
  }

  async upsertRecipe(
    productId: string,
    items: Array<{ supplyId: string; quantity: number; unit: string; unitId?: string }>,
    notes?: string,
  ) {
    await this.assertRecipesEnabled();
    const tenantId = this.tenantContext.requireTenantId();
    const product = await this.prisma.product.findFirst({
      where: { id: productId, tenantId, type: 'RECIPE' },
    });
    if (!product) throw new NotFoundException('Producto tipo RECIPE no encontrado');

    await this.assertSuppliesInTenant(this.prisma, tenantId, items.map((i) => i.supplyId));

    const normalizedItems = await Promise.all(
      items.map(async (i) => ({
        supplyId: i.supplyId,
        quantity: i.quantity,
        unit: i.unit,
        unitId: i.unitId ?? null,
        normalizedQuantity: await this.resolveNormalizedQty(this.prisma, tenantId, i),
      })),
    );

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.recipe.findUnique({ where: { productId } });
      if (existing) {
        await tx.recipeItem.deleteMany({ where: { recipeId: existing.id } });
        await tx.recipe.update({
          where: { id: existing.id },
          data: {
            notes: notes ?? existing.notes,
            items: { create: normalizedItems },
          },
        });
      } else {
        await tx.recipe.create({
          data: { productId, notes, items: { create: normalizedItems } },
        });
      }

      return tx.recipe.findUnique({
        where: { productId },
        include: { items: { include: { supply: true, measurementUnit: true } } },
      });
    });
  }

  async getComboItems(productId: string) {
    const tenantId = this.tenantContext.requireTenantId();
    const product = await this.prisma.product.findFirst({
      where: { id: productId, tenantId, type: 'COMBO' },
    });
    if (!product) throw new NotFoundException('Producto tipo COMBO no encontrado');

    return this.prisma.comboItem.findMany({
      where: { comboProductId: productId },
      include: { child: { include: { images: true } } },
    });
  }

  async upsertComboItems(productId: string, items: Array<{ childProductId: string; quantity: number }>) {
    const tenantId = this.tenantContext.requireTenantId();
    const product = await this.prisma.product.findFirst({
      where: { id: productId, tenantId, type: 'COMBO' },
    });
    if (!product) throw new NotFoundException('Producto tipo COMBO no encontrado');

    await this.assertChildProductsInTenant(this.prisma, tenantId, items.map((i) => i.childProductId));

    return this.prisma.$transaction(async (tx) => {
      await tx.comboItem.deleteMany({ where: { comboProductId: productId } });
      if (items.length > 0) {
        await tx.comboItem.createMany({
          data: items.map((i) => ({
            comboProductId: productId,
            childProductId: i.childProductId,
            quantity: i.quantity,
          })),
        });
      }
      return tx.comboItem.findMany({
        where: { comboProductId: productId },
        include: { child: { include: { images: true } } },
      });
    });
  }
}
