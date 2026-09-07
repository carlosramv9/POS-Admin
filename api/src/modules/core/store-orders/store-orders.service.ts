import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma, StoreWhatsappOrderStatus } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { CreateStoreOrderDto, UpdateStoreOrderStatusDto, QueryStoreOrdersDto } from './dto/store-order.dto';
import { PaginatedResponse } from '../../../common/dto/pagination.dto';
import { InventoryConsumptionEngine } from '../../retail/inventory/inventory-consumption.engine';

// Sin pago en línea: el status avanza a mano según lo que el administrador
// confirma que de verdad pasó. DELIVERED/CANCELLED son terminales — el
// primero ya descontó stock y contó como ingreso, el segundo ya no procede.
const ALLOWED_TRANSITIONS: Record<StoreWhatsappOrderStatus, StoreWhatsappOrderStatus[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['DELIVERED', 'CANCELLED'],
  DELIVERED: [],
  CANCELLED: [],
};

type OrderWithItems = Prisma.StoreWhatsappOrderGetPayload<{ include: { items: true } }>;

@Injectable()
export class StoreOrdersService {
  constructor(
    private prisma: PrismaService,
    private inventory: InventoryConsumptionEngine,
  ) {}

  async createOrder(tenantId: string, dto: CreateStoreOrderDto) {
    const subtotal = dto.items.reduce((sum, item) => sum + item.price * item.quantity, 0);

    // El carrito vive en localStorage del cliente y puede traer un productId
    // de un producto ya borrado o de otro tenant (ej. carrito viejo). El
    // detalle es una foto (nombre/precio/cantidad ya capturados) — no debe
    // fallar todo el pedido por una referencia inválida, solo se guarda sin
    // el link al producto.
    const productIds = dto.items.map((item) => item.productId).filter((id): id is string => Boolean(id));
    const validProductIds = productIds.length
      ? new Set(
          (
            await this.prisma.product.findMany({
              where: { id: { in: productIds }, tenantId },
              select: { id: true },
            })
          ).map((p) => p.id),
        )
      : new Set<string>();

    // El folio es secuencial por tenant; bajo carrera concurrente el `create`
    // choca contra @@unique([tenantId, orderNumber]) y se reintenta con el
    // conteo actualizado en vez de fallarle el pedido al cliente.
    for (let attempt = 0; attempt < 5; attempt++) {
      const count = await this.prisma.storeWhatsappOrder.count({ where: { tenantId } });
      const orderNumber = `WA-${String(count + 1).padStart(4, '0')}`;

      try {
        return await this.prisma.storeWhatsappOrder.create({
          data: {
            tenantId,
            orderNumber,
            phone: dto.phone,
            subtotal,
            items: {
              create: dto.items.map((item) => ({
                productId: item.productId && validProductIds.has(item.productId) ? item.productId : null,
                name: item.name,
                price: item.price,
                quantity: item.quantity,
                subtotal: item.price * item.quantity,
              })),
            },
          },
          select: { id: true, orderNumber: true },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
        throw err;
      }
    }
    throw new ConflictException('No se pudo generar el folio del pedido, intenta de nuevo');
  }

  async list(tenantId: string, query: QueryStoreOrdersDto): Promise<PaginatedResponse<unknown>> {
    const where: Prisma.StoreWhatsappOrderWhereInput = {
      tenantId,
      ...(query.status && { status: query.status }),
    };

    const [data, total] = await Promise.all([
      this.prisma.storeWhatsappOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
        include: { _count: { select: { items: true } } },
      }),
      this.prisma.storeWhatsappOrder.count({ where }),
    ]);

    return {
      data,
      meta: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
    };
  }

  async getOne(tenantId: string, id: string) {
    const order = await this.prisma.storeWhatsappOrder.findFirst({
      where: { id, tenantId },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('Pedido no encontrado');
    return order;
  }

  async updateStatus(tenantId: string, id: string, dto: UpdateStoreOrderStatusDto) {
    const order = await this.prisma.storeWhatsappOrder.findFirst({
      where: { id, tenantId },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('Pedido no encontrado');

    if (!ALLOWED_TRANSITIONS[order.status].includes(dto.status)) {
      throw new BadRequestException(`No se puede pasar de ${order.status} a ${dto.status}`);
    }

    if (dto.status === 'DELIVERED') return this.deliverOrder(tenantId, order);

    return this.prisma.storeWhatsappOrder.update({ where: { id }, data: { status: dto.status } });
  }

  // Descuenta stock de cada línea de forma atómica y guardada contra stock
  // negativo — si un producto ya no tiene existencia suficiente, se cancela
  // toda la transacción y no se marca nada como entregado.
  //
  // Pasa por InventoryConsumptionEngine igual que el resto de los canales de
  // venta. El descuento a mano que había aquí no expandía COMBO ni RECIPE (un
  // combo entregado no consumía a sus hijos), no tocaba existencias por sucursal
  // y no dejaba movimiento en el ledger, así que estas entregas eran invisibles
  // en el historial de inventario.
  private async deliverOrder(tenantId: string, order: OrderWithItems) {
    return this.prisma.$transaction(async (tx) => {
      await this.inventory.consume(
        tx,
        order.items.map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
          itemType: 'PRODUCT' as const,
          // La variante que pidió el cliente; sin ella, la default.
          variantId: item.variantId,
        })),
        {
          tenantId,
          branchId: null,
          userId: null,
          referenceId: order.id,
          referenceType: 'STORE_WHATSAPP_ORDER',
          note: 'Entrega de pedido de tienda en línea',
        },
      );

      return tx.storeWhatsappOrder.update({
        where: { id: order.id },
        data: { status: 'DELIVERED', deliveredAt: new Date() },
      });
    });
  }
}
