import {
  Injectable, NotFoundException, ConflictException, BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { TenantContextService } from '../../../common/context/tenant-context.service';
import { AuditService } from '../../../common/services/audit.service';
import { PlanLimitsService } from '../../../common/services/plan-limits.service';
import { randomUUID } from 'node:crypto';
import { CreateBranchDto } from './dto/create-branch.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';
import { BulkUpdateInventoryDto, TransferStockDto } from './dto/update-inventory.dto';
import { VariantInventoryResolver } from '../../retail/inventory/variant-inventory.resolver';
import { Branch, BranchInventory } from '@prisma/client';

@Injectable()
export class BranchesService {
  constructor(
    private prisma: PrismaService,
    private tenantContext: TenantContextService,
    private audit: AuditService,
    private planLimits: PlanLimitsService,
    private variants: VariantInventoryResolver,
  ) {}

  async create(dto: CreateBranchDto): Promise<Branch> {
    const tenantId = this.tenantContext.requireTenantId();

    await this.planLimits.assertCanAddBranch(tenantId);

    const exists = await this.prisma.branch.findUnique({
      where: { tenantId_code: { tenantId, code: dto.code } },
    });
    if (exists) throw new ConflictException('Branch code already exists in this tenant');

    // If isMain, unset any existing main branch
    if (dto.isMain) {
      await this.prisma.branch.updateMany({ where: { tenantId, isMain: true }, data: { isMain: false } });
    }

    const branch = await this.prisma.branch.create({
      data: { ...dto, tenantId },
      include: { manager: { select: { id: true, firstName: true, lastName: true, email: true } } },
    });

    await this.seedInventoryForBranch(branch.id, tenantId);

    return branch;
  }

  /**
   * Siembra el catálogo completo del tenant en una sucursal recién creada: una
   * fila de existencias por cada variante de cada producto, con existencia CERO
   * y los valores comerciales del producto.
   *
   * Sin esto la sucursal nacía sin una sola fila y el inventario aparecía vacío
   * hasta el primer movimiento, que era además quien creaba la fila sobre la
   * marcha. La existencia arranca en cero porque abrir una sucursal no crea
   * mercancía: se surte con una compra, una transferencia o un conteo inicial.
   *
   * `skipDuplicates` la hace idempotente. El fallo no tumba el alta de la
   * sucursal: se puede resembrar, y la siembra de emergencia del motor de
   * inventario sigue cubriendo la fila que falte.
   */
  private async seedInventoryForBranch(branchId: string, tenantId: string): Promise<void> {
    const variants = await this.prisma.productVariant.findMany({
      where: { product: { tenantId } },
      select: {
        id: true,
        productId: true,
        product: {
          select: {
            price: true,
            costPrice: true,
            comparePrice: true,
            lastCost: true,
            avgCost: true,
            lowStockAlert: true,
          },
        },
      },
    });
    if (variants.length === 0) return;

    await this.prisma.branchInventory.createMany({
      data: variants.map((variant) => ({
        branchId,
        productId: variant.productId,
        variantId: variant.id,
        stock: 0,
        cost: variant.product.costPrice,
        price: variant.product.price,
        comparePrice: variant.product.comparePrice,
        lastCost: variant.product.lastCost,
        avgCost: variant.product.avgCost,
        lowStockAlert: variant.product.lowStockAlert,
      })),
      skipDuplicates: true,
    });
  }

  async findAll(): Promise<Branch[]> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.prisma.branch.findMany({
      where: { tenantId },
      include: {
        manager: { select: { id: true, firstName: true, lastName: true, email: true } },
        _count: { select: { memberships: true, orders: true, inventory: true } },
      },
      orderBy: [{ isMain: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async findOne(id: string): Promise<Branch> {
    const tenantId = this.tenantContext.requireTenantId();
    const branch = await this.prisma.branch.findFirst({
      where: { id, tenantId },
      include: {
        manager: { select: { id: true, firstName: true, lastName: true, email: true } },
        memberships: {
          include: { user: { select: { id: true, firstName: true, lastName: true, email: true, status: true } } },
        },
        _count: { select: { orders: true, inventory: true } },
      },
    });
    if (!branch) throw new NotFoundException('Branch not found');
    return branch;
  }

  async update(id: string, dto: UpdateBranchDto): Promise<Branch> {
    const tenantId = this.tenantContext.requireTenantId();
    const branch = await this.prisma.branch.findFirst({ where: { id, tenantId } });
    if (!branch) throw new NotFoundException('Branch not found');

    if (dto.code && dto.code !== branch.code) {
      const conflict = await this.prisma.branch.findUnique({
        where: { tenantId_code: { tenantId, code: dto.code } },
      });
      if (conflict) throw new ConflictException('Branch code already exists');
    }

    if (dto.isMain) {
      await this.prisma.branch.updateMany({ where: { tenantId, isMain: true, NOT: { id } }, data: { isMain: false } });
    }

    return this.prisma.branch.update({
      where: { id },
      data: dto,
      include: { manager: { select: { id: true, firstName: true, lastName: true, email: true } } },
    });
  }

  async remove(id: string): Promise<void> {
    const tenantId = this.tenantContext.requireTenantId();
    const branch = await this.prisma.branch.findFirst({ where: { id, tenantId } });
    if (!branch) throw new NotFoundException('Branch not found');
    if (branch.isMain) throw new BadRequestException('Cannot delete the main branch');
    await this.prisma.branch.delete({ where: { id } });
  }

  async setMain(id: string): Promise<Branch> {
    const tenantId = this.tenantContext.requireTenantId();
    const branch = await this.prisma.branch.findFirst({ where: { id, tenantId } });
    if (!branch) throw new NotFoundException('Branch not found');
    await this.prisma.branch.updateMany({ where: { tenantId }, data: { isMain: false } });
    return this.prisma.branch.update({ where: { id }, data: { isMain: true } });
  }

  // ── Members ──────────────────────────────────────────────────────────────

  async addMember(branchId: string, userId: string, isPrimary = false): Promise<void> {
    const tenantId = this.tenantContext.requireTenantId();
    const branch = await this.prisma.branch.findFirst({ where: { id: branchId, tenantId } });
    if (!branch) throw new NotFoundException('Branch not found');

    await this.prisma.branchMembership.upsert({
      where: { branchId_userId: { branchId, userId } },
      update: { isPrimary },
      create: { branchId, userId, isPrimary },
    });
  }

  async removeMember(branchId: string, userId: string): Promise<void> {
    const tenantId = this.tenantContext.requireTenantId();
    const branch = await this.prisma.branch.findFirst({ where: { id: branchId, tenantId } });
    if (!branch) throw new NotFoundException('Branch not found');
    await this.prisma.branchMembership.delete({
      where: { branchId_userId: { branchId, userId } },
    });
  }

  // ── Inventory ─────────────────────────────────────────────────────────────

  /**
   * Comprueba que un `productId` recibido del cliente pertenezca al tenant.
   *
   * La sucursal ya se validaba, el producto no: un id ajeno acababa sembrando
   * una `ProductVariant` y una fila de `BranchInventory` sobre el producto de
   * otra organización, desde donde después se leían su nombre, SKU y precios.
   */
  private async assertProductInTenant(tenantId: string, productId: string): Promise<void> {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, tenantId },
      select: { id: true },
    });
    if (!product) throw new NotFoundException('Product not found');
  }

  async getInventory(branchId: string) {
    const tenantId = this.tenantContext.requireTenantId();
    const branch = await this.prisma.branch.findFirst({ where: { id: branchId, tenantId } });
    if (!branch) throw new NotFoundException('Branch not found');

    return this.prisma.branchInventory.findMany({
      where: { branchId },
      include: {
        product: { select: { id: true, name: true, sku: true, price: true, status: true, lowStockAlert: true } },
      },
      orderBy: { product: { name: 'asc' } },
    });
  }

  async updateInventoryItem(branchId: string, productId: string, stock: number): Promise<BranchInventory> {
    const tenantId = this.tenantContext.requireTenantId();
    const branch = await this.prisma.branch.findFirst({ where: { id: branchId, tenantId } });
    if (!branch) throw new NotFoundException('Branch not found');

    await this.assertProductInTenant(tenantId, productId);

    // El inventario se lleva por variante; esta API sigue siendo por producto,
    // así que apunta a la variante default (la línea "el producto en sí").
    const variantId = await this.variants.ensureDefaultVariantId(this.prisma, productId, tenantId);
    if (!variantId) throw new NotFoundException('Product not found');

    const existing = await this.prisma.branchInventory.findUnique({
      where: { branchId_variantId: { branchId, variantId } },
      select: { stock: true },
    });

    const previousStock = existing?.stock ?? 0;
    const delta = stock - previousStock;

    // Mismo resultado de stock que antes; se AÑADE el registro en el ledger para
    // que el ajuste manual quede trazable (antes solo existía audit.log).
    const result = await this.prisma.$transaction(async (tx) => {
      const upserted = await tx.branchInventory.upsert({
        where: { branchId_variantId: { branchId, variantId } },
        update: { stock },
        create: { branchId, productId, variantId, stock },
      });
      if (delta !== 0) {
        await tx.inventoryMovement.create({
          data: {
            tenantId,
            type: 'AJUSTE',
            productId,
            branchId,
            quantity: delta,
            referenceId: `${branchId}:${productId}`,
            referenceType: 'INVENTORY_ADJUST',
            notes: 'Ajuste manual de inventario de sucursal',
          },
        });
      }
      return upserted;
    });

    await this.audit.log({
      action: 'INVENTORY_ADJUST',
      entityType: 'BranchInventory',
      entityId: `${branchId}:${productId}`,
      before: { stock: previousStock },
      after: { stock: result.stock },
      reason: 'Ajuste manual de inventario de sucursal',
    });

    return result;
  }

  async bulkUpdateInventory(branchId: string, dto: BulkUpdateInventoryDto): Promise<void> {
    const tenantId = this.tenantContext.requireTenantId();
    const branch = await this.prisma.branch.findFirst({ where: { id: branchId, tenantId } });
    if (!branch) throw new NotFoundException('Branch not found');

    // Conteo físico / ajuste masivo. Mismo resultado de stock; se AÑADE un
    // movimiento AJUSTE por cada diferencia para dejar el conteo trazable.
    const productIds = dto.items.map((i) => i.productId);
    const existingRows = await this.prisma.branchInventory.findMany({
      where: { branchId, productId: { in: productIds } },
      select: { productId: true, stock: true },
    });
    const prevByProduct = new Map(existingRows.map((r) => [r.productId, r.stock]));

    // Resuelto fuera de la transacción para no alargarla: el conteo físico es
    // por producto, pero cada fila cuelga de la variante default.
    // Los ids llegan en el body: se rechaza el lote completo si alguno no es de
    // este tenant, en vez de saltárselo en silencio.
    const owned = await this.prisma.product.findMany({
      where: { id: { in: productIds }, tenantId },
      select: { id: true },
    });
    if (owned.length !== new Set(productIds).size) {
      throw new NotFoundException('Alguno de los productos no existe en esta empresa');
    }

    const variantByProduct = new Map<string, string>();
    for (const productId of productIds) {
      const variantId = await this.variants.ensureDefaultVariantId(this.prisma, productId, tenantId);
      if (variantId) variantByProduct.set(productId, variantId);
    }

    await this.prisma.$transaction(
      dto.items.flatMap((item) => {
        const variantId = variantByProduct.get(item.productId);
        if (!variantId) return [];

        const delta = item.stock - (prevByProduct.get(item.productId) ?? 0);
        const ops: ReturnType<typeof this.prisma.branchInventory.upsert>[] = [
          this.prisma.branchInventory.upsert({
            where: { branchId_variantId: { branchId, variantId } },
            update: { stock: item.stock },
            create: { branchId, productId: item.productId, variantId, stock: item.stock },
          }),
        ];
        if (delta !== 0) {
          ops.push(
            this.prisma.inventoryMovement.create({
              data: {
                tenantId,
                type: 'AJUSTE',
                productId: item.productId,
                branchId,
                quantity: delta,
                referenceId: branchId,
                referenceType: 'INVENTORY_COUNT',
                notes: 'Conteo físico / ajuste masivo de inventario',
              },
            }) as never,
          );
        }
        return ops;
      }),
    );
  }

  async transferStock(fromBranchId: string, dto: TransferStockDto): Promise<void> {
    const tenantId = this.tenantContext.requireTenantId();
    const [from, to] = await Promise.all([
      this.prisma.branch.findFirst({ where: { id: fromBranchId, tenantId } }),
      this.prisma.branch.findFirst({ where: { id: dto.toBranchId, tenantId } }),
    ]);
    if (!from || !to) throw new NotFoundException('Branch not found');

    await this.assertProductInTenant(tenantId, dto.productId);

    const variantId = await this.variants.ensureDefaultVariantId(this.prisma, dto.productId, tenantId);
    if (!variantId) throw new NotFoundException('Product not found');

    const fromInv = await this.prisma.branchInventory.findUnique({
      where: { branchId_variantId: { branchId: fromBranchId, variantId } },
    });
    if (!fromInv || fromInv.stock < dto.quantity) {
      throw new BadRequestException('Insufficient stock in source branch');
    }

    // Mismo movimiento físico de stock entre sucursales; se AÑADEN dos registros
    // en el ledger (salida en origen, entrada en destino) enlazados por transferId
    // para trazabilidad completa. La dirección se distingue por referenceType.
    const transferId = randomUUID();

    await this.prisma.$transaction([
      this.prisma.branchInventory.update({
        where: { branchId_variantId: { branchId: fromBranchId, variantId } },
        data: { stock: { decrement: dto.quantity } },
      }),
      this.prisma.branchInventory.upsert({
        where: { branchId_variantId: { branchId: dto.toBranchId, variantId } },
        update: { stock: { increment: dto.quantity } },
        create: {
          branchId: dto.toBranchId,
          productId: dto.productId,
          variantId,
          stock: dto.quantity,
        },
      }),
      this.prisma.inventoryMovement.create({
        data: {
          tenantId,
          type: 'TRANSFERENCIA',
          productId: dto.productId,
          branchId: fromBranchId,
          quantity: dto.quantity,
          referenceId: transferId,
          referenceType: 'TRANSFER_OUT',
          notes: `Transferencia a sucursal ${dto.toBranchId}`,
        },
      }),
      this.prisma.inventoryMovement.create({
        data: {
          tenantId,
          type: 'TRANSFERENCIA',
          productId: dto.productId,
          branchId: dto.toBranchId,
          quantity: dto.quantity,
          referenceId: transferId,
          referenceType: 'TRANSFER_IN',
          notes: `Transferencia desde sucursal ${fromBranchId}`,
        },
      }),
    ]);
  }
}
