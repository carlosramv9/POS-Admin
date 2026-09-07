import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { TenantContextService } from '../../../common/context/tenant-context.service';
import { AuditContextService } from '../../../common/context/audit-context.service';
import { PaginatedResponse } from '../../../common/dto/pagination.dto';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto';
import { UpdatePurchaseOrderDto } from './dto/update-purchase-order.dto';
import { QueryPurchaseOrdersDto } from './dto/query-purchase-orders.dto';
import { ReceivePurchaseOrderDto } from './dto/receive-purchase-order.dto';
import { VariantInventoryResolver } from '../inventory/variant-inventory.resolver';

@Injectable()
export class PurchasesService {
  constructor(
    private prisma: PrismaService,
    private tenantContext: TenantContextService,
    private auditContext: AuditContextService,
    private variants: VariantInventoryResolver,
  ) {}

  /**
   * Comprueba que cada `variantId` de las líneas sea de su producto y del
   * tenant. El id viaja en el body, así que es entrada no confiable igual que
   * `productId`: sin esto, una orden podía referenciar la variante de otra
   * organización y la recepción le sumaría existencia.
   */
  private async assertVariantsOfLines(
    tx: Prisma.TransactionClient,
    tenantId: string,
    items: { productId: string; variantId?: string | null }[],
  ): Promise<void> {
    for (const item of items) {
      if (!item.variantId) continue;
      await this.variants.assertVariantOfProduct(tx, item.productId, tenantId, item.variantId);
    }
  }

  async create(dto: CreatePurchaseOrderDto) {
    const tenantId = this.tenantContext.requireTenantId();
    const userId = this.auditContext.getUserId();
    const branchId = this.tenantContext.getBranchId() ?? null;

    const random4 = Math.random().toString(36).substring(2, 6).toUpperCase();
    const orderNumber = `PC-${Date.now()}-${random4}`;

    let subtotal = 0;
    let tax = 0;
    for (const item of dto.items) {
      subtotal += item.unitCost * item.quantityOrdered;
      tax += item.tax ?? 0;
    }
    const total = subtotal + tax;

    return this.prisma.$transaction(async (tx) => {
      await this.assertVariantsOfLines(tx, tenantId, dto.items);

      const order = await tx.purchaseOrder.create({
        data: {
          tenantId,
          orderNumber,
          supplierId: dto.supplierId,
          branchId,
          status: 'BORRADOR',
          expectedDate: dto.expectedDate ? new Date(dto.expectedDate) : null,
          notes: dto.notes ?? null,
          subtotal,
          tax,
          total,
          createdById: userId ?? null,
          updatedById: userId ?? null,
          items: {
            create: dto.items.map((item) => ({
              productId: item.productId,
              variantId: item.variantId ?? null,
              quantityOrdered: item.quantityOrdered,
              unitCost: item.unitCost,
              tax: item.tax ?? 0,
              total: item.unitCost * item.quantityOrdered + (item.tax ?? 0),
            })),
          },
        },
        include: {
          supplier: true,
          items: { include: { product: true } },
        },
      });

      return order;
    });
  }

  async findAll(query: QueryPurchaseOrdersDto): Promise<PaginatedResponse<any>> {
    const tenantId = this.tenantContext.requireTenantId();
    const { skip, limit, page, supplierId, status, search } = query;

    const where: any = { tenantId };
    if (supplierId) where.supplierId = supplierId;
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { orderNumber: { contains: search, mode: 'insensitive' } },
        { supplier: { name: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [orders, total] = await Promise.all([
      this.prisma.purchaseOrder.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          supplier: true,
          items: { include: { product: true } },
        },
      }),
      this.prisma.purchaseOrder.count({ where }),
    ]);

    return {
      data: orders,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string) {
    const tenantId = this.tenantContext.requireTenantId();
    const order = await this.prisma.purchaseOrder.findFirst({
      where: { id, tenantId },
      include: {
        supplier: true,
        items: { include: { product: true } },
        receipts: {
          include: {
            items: { include: { product: true } },
            receivedBy: true,
          },
        },
        accountPayable: {
          include: { payments: { orderBy: { paymentDate: 'desc' } } },
        },
        createdBy: true,
        updatedBy: true,
      },
    });
    if (!order) throw new NotFoundException('Purchase order not found');
    return order;
  }

  async update(id: string, dto: UpdatePurchaseOrderDto) {
    const tenantId = this.tenantContext.requireTenantId();
    const userId = this.auditContext.getUserId();

    const order = await this.prisma.purchaseOrder.findFirst({ where: { id, tenantId } });
    if (!order) throw new NotFoundException('Purchase order not found');
    if (order.status !== 'BORRADOR') {
      throw new BadRequestException('Solo se pueden editar órdenes en estado BORRADOR');
    }

    // If items are provided, recalculate totals and replace items
    if (dto.items !== undefined && dto.items !== null) {
      const newItems = dto.items;
      let subtotal = 0;
      let tax = 0;
      for (const item of newItems) {
        subtotal += (item.unitCost ?? 0) * (item.quantityOrdered ?? 0);
        tax += item.tax ?? 0;
      }
      const total = subtotal + tax;

      return this.prisma.$transaction(async (tx) => {
        await this.assertVariantsOfLines(tx, tenantId, newItems as { productId: string; variantId?: string | null }[]);
        await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: id } });
        return tx.purchaseOrder.update({
          where: { id },
          data: {
            supplierId: dto.supplierId ?? order.supplierId,
            expectedDate: dto.expectedDate ? new Date(dto.expectedDate) : order.expectedDate,
            notes: dto.notes !== undefined ? dto.notes : order.notes,
            subtotal,
            tax,
            total,
            updatedById: userId ?? null,
            items: {
              create: newItems.map((item) => ({
                productId: item.productId,
                variantId: item.variantId ?? null,
                quantityOrdered: item.quantityOrdered,
                unitCost: item.unitCost,
                tax: item.tax ?? 0,
                total: (item.unitCost ?? 0) * (item.quantityOrdered ?? 0) + (item.tax ?? 0),
              })),
            },
          },
          include: {
            supplier: true,
            items: { include: { product: true } },
          },
        });
      });
    }

    return this.prisma.purchaseOrder.update({
      where: { id },
      data: {
        supplierId: dto.supplierId ?? order.supplierId,
        expectedDate: dto.expectedDate ? new Date(dto.expectedDate) : order.expectedDate,
        notes: dto.notes !== undefined ? dto.notes : order.notes,
        updatedById: userId ?? null,
      },
      include: {
        supplier: true,
        items: { include: { product: true } },
      },
    });
  }

  async send(id: string) {
    const tenantId = this.tenantContext.requireTenantId();
    const userId = this.auditContext.getUserId();

    const order = await this.prisma.purchaseOrder.findFirst({ where: { id, tenantId } });
    if (!order) throw new NotFoundException('Purchase order not found');
    if (order.status !== 'BORRADOR') {
      throw new BadRequestException('Solo se pueden enviar órdenes en estado BORRADOR');
    }

    return this.prisma.purchaseOrder.update({
      where: { id },
      data: { status: 'ENVIADA', updatedById: userId ?? null },
      include: { supplier: true, items: { include: { product: true } } },
    });
  }

  async cancel(id: string) {
    const tenantId = this.tenantContext.requireTenantId();
    const userId = this.auditContext.getUserId();

    const order = await this.prisma.purchaseOrder.findFirst({
      where: { id, tenantId },
      include: { receipts: true },
    });
    if (!order) throw new NotFoundException('Purchase order not found');
    if (order.status === 'CANCELADA') {
      throw new BadRequestException('La orden ya está cancelada');
    }
    if (order.status === 'COMPLETADA') {
      throw new BadRequestException('No se puede cancelar una orden completada');
    }
    if (order.receipts.length > 0) {
      throw new BadRequestException('No se puede cancelar una orden que ya tiene recepciones registradas');
    }

    return this.prisma.purchaseOrder.update({
      where: { id },
      data: { status: 'CANCELADA', updatedById: userId ?? null },
      include: { supplier: true, items: { include: { product: true } } },
    });
  }

  async receive(id: string, dto: ReceivePurchaseOrderDto) {
    const tenantId = this.tenantContext.requireTenantId();
    const userId = this.auditContext.getUserId();
    const effectiveBranchId = dto.branchId ?? this.tenantContext.getBranchId() ?? null;

    // 1. Load order with items and existing receipts
    const order = await this.prisma.purchaseOrder.findFirst({
      where: { id, tenantId },
      include: {
        items: { include: { product: { select: { id: true, name: true } } } },
        receipts: { include: { items: true } },
        supplier: true,
      },
    });
    if (!order) throw new NotFoundException('Purchase order not found');
    if (order.status === 'CANCELADA') {
      throw new BadRequestException('No se puede recibir mercancía de una orden cancelada');
    }
    if (order.status === 'BORRADOR') {
      throw new BadRequestException('La orden debe ser enviada antes de recibir mercancía');
    }
    if (order.status === 'COMPLETADA') {
      throw new BadRequestException('La orden ya está completada, no se puede recibir más mercancía');
    }

    // Build maps for validation
    const orderItemsByProduct = new Map(order.items.map((i) => [i.productId, i]));

    // Calculate already-received quantities per product across all past receipts
    const alreadyReceived = new Map<string, number>();
    for (const receipt of order.receipts) {
      for (const ri of receipt.items) {
        alreadyReceived.set(ri.productId, (alreadyReceived.get(ri.productId) ?? 0) + ri.quantityReceived);
      }
    }

    // 2. Validate each incoming item
    const itemsToReceive = dto.items.filter((i) => i.quantityReceived > 0);
    if (itemsToReceive.length === 0) {
      throw new BadRequestException('Debe recibir al menos un artículo con cantidad mayor a 0');
    }

    for (const ri of itemsToReceive) {
      const orderItem = orderItemsByProduct.get(ri.productId);
      if (!orderItem) {
        throw new BadRequestException(`El producto ${ri.productId} no está en esta orden de compra`);
      }
      const previouslyReceived = alreadyReceived.get(ri.productId) ?? 0;
      const remainingQuantity = orderItem.quantityOrdered - previouslyReceived;
      const productName = (orderItem as any).product?.name ?? ri.productId;

      if (ri.quantityReceived <= 0) {
        throw new BadRequestException(`La cantidad para "${productName}" debe ser mayor a 0`);
      }
      if (ri.quantityReceived > remainingQuantity) {
        throw new BadRequestException(
          `"${productName}": se intenta recibir ${ri.quantityReceived} pero solo quedan ${remainingQuantity} pendientes de ${orderItem.quantityOrdered} ordenados (ya recibidos: ${previouslyReceived})`,
        );
      }
    }

    // 3. Execute in a single transaction
    const updatedOrder = await this.prisma.$transaction(async (tx) => {
      // a. Create receipt
      const receipt = await tx.purchaseReceipt.create({
        data: {
          purchaseOrderId: id,
          receivedById: userId ?? null,
          notes: dto.notes ?? null,
          items: {
            create: itemsToReceive.map((ri) => ({
              productId: ri.productId,
              // La variante la fija la ORDEN, no la recepción: se recibe lo que
              // se pidió. Tomarla del body dejaría recibir una talla distinta de
              // la comprada sin que nada lo notara.
              variantId: orderItemsByProduct.get(ri.productId)?.variantId ?? null,
              quantityReceived: ri.quantityReceived,
            })),
          },
        },
      });

      // b-f. Update each product
      for (const ri of itemsToReceive) {
        const orderItem = orderItemsByProduct.get(ri.productId)!;
        const unitCost = Number(orderItem.unitCost);

        // El costeo promedio ponderado ahora es por (sucursal, variante): cada
        // sucursal lleva su propia base de costo, que es lo correcto cuando el
        // mismo producto se compra a distintos precios en distintas plazas.
        //
        // La variante sale de la línea de la orden. Antes se forzaba la default,
        // así que comprar 20 tallas L le sumaba las 20 a "el producto en sí" y
        // la L seguía en cero. `ensureDefaultVariantId` solo cubre el caso de la
        // orden sin variante (histórica, o un producto de una sola línea).
        const variantId =
          orderItem.variantId ??
          (await this.variants.ensureDefaultVariantId(tx, ri.productId, tenantId));
        const targetBranchId =
          effectiveBranchId ?? (await this.variants.resolveBranchId(tx, tenantId));

        const currentRow =
          variantId && targetBranchId
            ? await tx.branchInventory.findUnique({
                where: { branchId_variantId: { branchId: targetBranchId, variantId } },
                select: { stock: true, avgCost: true },
              })
            : null;

        // La base del costeo es la fila de (sucursal, variante). Ya no se cae
        // al espejo `products.stock`, que es la suma de TODAS las variantes de
        // TODAS las sucursales: usarlo como existencia previa de una sola
        // deformaba el promedio ponderado en cuanto el producto tenía más de
        // una presentación o más de una sucursal.
        const currentStock = currentRow?.stock ?? 0;
        const currentAvgCostRaw = currentRow?.avgCost;
        const currentAvgCost = currentAvgCostRaw ? Number(currentAvgCostRaw) : unitCost;

        const newAvgCost =
          currentStock + ri.quantityReceived > 0
            ? (currentStock * currentAvgCost + ri.quantityReceived * unitCost) /
              (currentStock + ri.quantityReceived)
            : unitCost;

        // c. Upsert de la fila autoritativa (sucursal, variante)
        if (variantId && targetBranchId) {
          await tx.branchInventory.upsert({
            where: { branchId_variantId: { branchId: targetBranchId, variantId } },
            update: {
              stock: { increment: ri.quantityReceived },
              lastCost: unitCost,
              avgCost: newAvgCost,
            },
            create: {
              branchId: targetBranchId,
              productId: ri.productId,
              variantId,
              stock: ri.quantityReceived,
              lastCost: unitCost,
              avgCost: newAvgCost,
            },
          });
        }

        // d. Espejo en el producto (legacy, se elimina en la fase contract)
        await tx.product.update({
          where: { id: ri.productId },
          data: {
            stock: { increment: ri.quantityReceived },
            lastCost: unitCost,
            avgCost: newAvgCost,
          },
        });

        // e. Create inventory movement
        await tx.inventoryMovement.create({
          data: {
            tenantId,
            type: 'COMPRA',
            productId: ri.productId,
            variantId,
            branchId: effectiveBranchId,
            quantity: ri.quantityReceived,
            referenceId: id,
            referenceType: 'PURCHASE',
            notes: `Recepción de compra ${order.orderNumber} - Recibo ${receipt.id}`,
            createdById: userId ?? null,
          },
        });
      }

      // g. Update supplier totals
      await tx.supplier.update({
        where: { id: order.supplierId },
        data: {
          totalOrders: { increment: 1 },
          totalSpent: { increment: Number(order.total) },
        },
      });

      // h-extra. Create AccountPayable if first receipt for this order
      const existingCxP = await tx.accountPayable.findUnique({
        where: { purchaseOrderId: id },
      });
      if (!existingCxP) {
        await tx.accountPayable.create({
          data: {
            tenantId,
            purchaseOrderId: id,
            supplierId: order.supplierId,
            totalAmount: order.total,
            balance: order.total,
            status: 'PENDIENTE',
          },
        });
      }

      // h. Determine new order status
      const updatedAlreadyReceived = new Map<string, number>(alreadyReceived);
      for (const ri of itemsToReceive) {
        updatedAlreadyReceived.set(
          ri.productId,
          (updatedAlreadyReceived.get(ri.productId) ?? 0) + ri.quantityReceived,
        );
      }

      let allComplete = true;
      let anyReceived = false;

      for (const item of order.items) {
        const received = updatedAlreadyReceived.get(item.productId) ?? 0;
        if (received > 0) anyReceived = true;
        if (received < item.quantityOrdered) allComplete = false;
      }

      const newStatus = allComplete ? 'COMPLETADA' : anyReceived ? 'PARCIAL' : order.status;

      return tx.purchaseOrder.update({
        where: { id },
        data: { status: newStatus, updatedById: userId ?? null },
        include: {
          supplier: true,
          items: { include: { product: true } },
          receipts: { include: { items: { include: { product: true } } } },
        },
      });
    });

    return updatedOrder;
  }

  async getReceipts(id: string) {
    const tenantId = this.tenantContext.requireTenantId();

    const order = await this.prisma.purchaseOrder.findFirst({ where: { id, tenantId } });
    if (!order) throw new NotFoundException('Purchase order not found');

    return this.prisma.purchaseReceipt.findMany({
      where: { purchaseOrderId: id },
      include: {
        items: { include: { product: true } },
        receivedBy: true,
      },
      orderBy: { receivedDate: 'desc' },
    });
  }
}
