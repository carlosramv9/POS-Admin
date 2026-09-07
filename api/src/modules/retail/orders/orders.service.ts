import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { AuditContextService } from '../../../common/context/audit-context.service';
import { TenantContextService } from '../../../common/context/tenant-context.service';
import { PaginatedResponse } from '../../../common/dto/pagination.dto';
import { QueryOrdersDto } from './dto/query-orders.dto';
import { Order, OrderStatus, Coupon } from '@prisma/client';
import { CouponsService } from '../coupons/coupons.service';
import { AuditService } from '../../../common/services/audit.service';
import { assertSessionOpen, requireOpenSession } from '../../../common/helpers/cash-session.helper';
import { CreateOrderDto } from './dto/create-order.dto';
import { AddPaymentDto } from './dto/add-payment.dto';
import { RefundOrderDto } from './dto/refund-order.dto';
import {
  roundMoney,
  sumMoney,
  calculateLineSubtotal,
  calculateTax,
  convertMoney,
} from '../../../common/utils/money.util';
import { InventoryConsumptionEngine } from '../inventory/inventory-consumption.engine';
import { EffectivePermissionsService } from '../../../common/services/effective-permissions.service';

@Injectable()
export class OrdersService {
  constructor(
    private prisma: PrismaService,
    private auditContext: AuditContextService,
    private tenantContext: TenantContextService,
    private couponsService: CouponsService,
    private audit: AuditService,
    private inventory: InventoryConsumptionEngine,
    private effectivePermissions: EffectivePermissionsService,
  ) { }

  async create(dto: CreateOrderDto): Promise<Order> {
    if (!dto.items?.length) {
      throw new BadRequestException('La venta debe tener al menos un item');
    }

    const tenantId = this.tenantContext.requireTenantId();
    const customerId: string | null = dto.customerId ?? null;
    let addressId: string | null = null;

    if (customerId) {
      // Aislamiento multi-tenant: el id viene del cliente; sin filtro tenantId un
      // operador podría referenciar un Customer de otra organización.
      const customer = await this.prisma.customer.findFirst({
        where: { id: customerId, tenantId },
        include: { addresses: true },
      });
      if (!customer) {
        throw new NotFoundException('Cliente no encontrado');
      }
      const address = customer.addresses.find((a) => a.isDefault) ?? customer.addresses[0];
      if (address) addressId = address.id;
    }

    // Separate product and service items
    const productItems = dto.items.filter((i) => !i.itemType || i.itemType === 'PRODUCT');
    const serviceItems = dto.items.filter((i) => i.itemType === 'SERVICE');

    // Validate and load products (include recipe for consumption check)
    const productIds = [...new Set(productItems.map((i) => i.productId).filter(Boolean) as string[])];
    const products = productIds.length
      ? await this.prisma.product.findMany({
          // Aislamiento multi-tenant: ids controlados por el cliente — un producto
          // de otro tenant decrementaría su stock. Filtrar por tenantId.
          where: { id: { in: productIds }, tenantId },
          include: {
            category: true,
            recipe: {
              include: {
                items: {
                  include: { supply: { include: { baseUnit: true, inventoryUnit: true } } },
                },
              },
            },
          },
        })
      : [];
    if (products.length !== productIds.length) {
      const found = new Set(products.map((p) => p.id));
      const missing = productIds.filter((id) => !found.has(id));
      throw new NotFoundException(`Productos no encontrados: ${missing.join(', ')}`);
    }

    // Stock availability (SIMPLE / RECIPE / COMBO) is validated and applied
    // atomically by InventoryConsumptionEngine inside the transaction below.

    // Optionally validate services from catalog
    const catalogServiceIds = [...new Set(serviceItems.map((i) => i.serviceId).filter(Boolean) as string[])];
    const catalogServices = catalogServiceIds.length
      ? await this.prisma.service.findMany({ where: { id: { in: catalogServiceIds }, tenantId } })
      : [];
    // Un serviceId del catálogo debe pertenecer al tenant. Si tras el filtro falta
    // alguno, es una referencia cruzada entre organizaciones → se rechaza.
    if (catalogServices.length !== catalogServiceIds.length) {
      const found = new Set(catalogServices.map((s) => s.id));
      const missing = catalogServiceIds.filter((id) => !found.has(id));
      throw new NotFoundException(`Servicios no encontrados: ${missing.join(', ')}`);
    }
    const serviceMap = new Map(catalogServices.map((s) => [s.id, s]));

    const productMap = new Map(products.map((p) => [p.id, p]));

    // El precio de línea es del cliente (`item.price`) con la única
    // restricción `@Min(0)` — nunca se comparaba contra el catálogo. Cobrar
    // lo que el cajero quiera es el fraude de POS más clásico (H-05): se
    // exige el precio de catálogo salvo que el actor tenga
    // `orders:price-override`, y cada venta que sí lo use queda en
    // AuditLog.
    const priceOverrides: { productId: string; catalogPrice: number; chargedPrice: number }[] = [];
    for (const item of productItems) {
      const product = productMap.get(item.productId!);
      if (!product) continue;
      const catalogPrice = Number(product.price);
      if (Math.abs(item.price - catalogPrice) > 0.01) {
        priceOverrides.push({ productId: product.id, catalogPrice, chargedPrice: item.price });
      }
    }
    if (priceOverrides.length > 0) {
      const canOverride = await this.effectivePermissions.actorHas('orders:price-override');
      if (!canOverride) {
        const [first] = priceOverrides;
        const product = productMap.get(first.productId)!;
        throw new BadRequestException(
          `El precio de "${product.name}" ($${first.chargedPrice}) no coincide con el de catálogo ($${first.catalogPrice}). ` +
            'Ajusta el precio del producto o pide autorización para cobrar un precio distinto.',
        );
      }
    }

    // H-05 (re-auditoría): `item.discount` se dejó libre a propósito la
    // primera vez ("es el mecanismo normal para bajar el precio"), pero eso
    // es exactamente el hueco: sin tope ni permiso, un descuento manual lleva
    // el total a $0 igual que un precio manipulado — mismo fraude, otra
    // puerta. Cualquier descuento (>0) exige `orders:discount-override` y
    // queda auditado, igual que el precio.
    const discountOverrides: { label: string; discount: number }[] = [];
    for (const item of dto.items) {
      const discount = roundMoney(item.discount ?? 0);
      if (discount > 0) {
        const label = item.productId ? (productMap.get(item.productId)?.name ?? item.productId) : (item.name ?? 'item');
        discountOverrides.push({ label, discount });
      }
    }
    if (discountOverrides.length > 0) {
      const canDiscount = await this.effectivePermissions.actorHas('orders:discount-override');
      if (!canDiscount) {
        const [first] = discountOverrides;
        throw new BadRequestException(
          `"${first.label}" tiene un descuento manual de $${first.discount}. Pide autorización para aplicar descuentos.`,
        );
      }
    }

    // Tenant default tax rate (percent) from settings JSON; product.taxRate overrides per item
    const tenantRow = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const tenantSettings = (tenantRow?.settings ?? {}) as Record<string, unknown>;
    const tenantDefaultTaxRate = Number(tenantSettings.defaultTaxRate ?? 0) || 0;

    const resolveTaxRate = (productId?: string): number => {
      if (!productId) return tenantDefaultTaxRate;
      const p = productMap.get(productId);
      return p?.taxRate != null ? Number(p.taxRate) : tenantDefaultTaxRate;
    };

    const subtotal = sumMoney(
      dto.items.map((item) => item.price * item.quantity),
    );

    let discountAmount = 0;
    let couponId: string | null = null;
    let couponCode: string | null = null;

    if (dto.couponCode?.trim()) {
      const categoryIds = [
        ...new Set(
          products
            .map((p) => p.categoryId)
            .filter((id): id is string => id !== null),
        ),
      ];
      const validation = await this.couponsService.validateCoupon({
        code: dto.couponCode.trim(),
        customerId: customerId ?? undefined,
        productIds,
        categoryIds,
        totalAmount: subtotal,
      });
      if (!validation.valid) {
        throw new BadRequestException(validation.message ?? 'Cupón no válido');
      }
      discountAmount = validation.discountAmount ?? 0;
      if (validation.coupon) {
        couponId = validation.coupon.id;
        couponCode = validation.coupon.code;
      }
    }

    // Per-item line math (discount, tax, subtotal, total) computed once and reused
    const lineMath = new Map<
      (typeof dto.items)[number],
      { discount: number; tax: number; subtotal: number; total: number }
    >();
    for (const item of dto.items) {
      const itemDiscount = roundMoney(item.discount ?? 0);
      const itemSubtotal = calculateLineSubtotal(
        item.price,
        item.quantity,
        itemDiscount,
      );
      const isProduct = !item.itemType || item.itemType === 'PRODUCT';
      // Explicit per-item tax wins; otherwise derive from product/tenant rate.
      // `taxExempt` fuerza 0 aunque el producto/tenant tengan taxRate — es
      // el único caso en que un 0 explícito debe ganarle al derivado (un
      // `tax: 0` sin este flag se sigue tratando como "no enviado", igual
      // que antes, para no romper integraciones existentes).
      const explicitTax = roundMoney(item.tax ?? 0);
      const derivedTax = isProduct
        ? calculateTax(itemSubtotal, resolveTaxRate(item.productId))
        : 0;
      const itemTax = item.taxExempt ? 0 : explicitTax > 0 ? explicitTax : derivedTax;
      lineMath.set(item, {
        discount: itemDiscount,
        tax: itemTax,
        subtotal: itemSubtotal,
        total: roundMoney(itemSubtotal + itemTax),
      });
    }

    const shippingCost = roundMoney(dto.shippingCost ?? 0);
    // El descuento por línea (`item.discount`) ya reducía `itemSubtotal`/
    // `itemTotal` de cada renglón, pero antes no se reflejaba en
    // `order.total` (solo el descuento de cupón lo hacía) — se suma aquí
    // para que el campo "Descuento sobre el item" ya documentado en el DTO
    // efectivamente reduzca el total cobrado, sin tocar el cálculo de
    // cupón existente (ambos se suman, no se reemplazan).
    const itemDiscountsTotal = sumMoney([...lineMath.values()].map((l) => l.discount));
    discountAmount = roundMoney(discountAmount + itemDiscountsTotal);
    const tax = sumMoney([...lineMath.values()].map((l) => l.tax));
    const total = roundMoney(
      Math.max(0, subtotal - discountAmount + shippingCost + tax),
    );
    const orderNumber = `V-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    const createdById = this.auditContext.getUserId() ?? null;
    const branchId = this.tenantContext.getBranchId() ?? null;

    // Validate source quote if provided
    if (dto.sourceQuoteId) {
      const quote = await this.prisma.serviceQuote.findFirst({
        where: { id: dto.sourceQuoteId, tenantId },
      });
      if (!quote) throw new NotFoundException('Cotización no encontrada');
      if (quote.status !== 'APPROVED') {
        throw new BadRequestException('Solo se pueden convertir cotizaciones aprobadas');
      }
    }

    // Fetch active session for TC (pre-transaction read) — required for checkout
    const activeSessionForTc = await this.prisma.cashSession.findFirst({
      where: { tenantId, branchId: branchId ?? undefined, status: 'ABIERTA' },
      select: { id: true, exchangeRateUsdMxn: true },
    });
    if (!activeSessionForTc) {
      throw new BadRequestException('No hay sesión de caja activa. Abre la caja antes de realizar ventas.');
    }
    const exchangeRate = Number(activeSessionForTc.exchangeRateUsdMxn);
    const hasUsdPayment = (dto.payments?.some((p) => p.currency === 'USD') ?? false) || dto.changeCurrency === 'USD';

    const isCredit =
      dto.paymentMethod === 'CREDITO' ||
      (dto.payments?.some((p) => p.method === 'CREDITO') ?? false);

    // Cuánto se paga ahora, en MXN (moneda base) — convierte cada pago en USD
    // con el tipo de cambio de la sesión antes de sumar. Antes se sumaban
    // montos crudos de monedas distintas sin convertir.
    const paidNow = dto.payments?.length
      ? sumMoney(
          dto.payments
            .filter((p) => p.method !== 'CREDITO')
            .map((p) => (p.currency === 'USD' ? convertMoney(p.amount, exchangeRate) : roundMoney(p.amount))),
        )
      : dto.paymentMethod !== 'CREDITO' ? total : 0;

    // H-05: el cliente no puede declarar una venta como pagada cobrando menos
    // del total. Layaway y crédito son los únicos casos donde un saldo
    // pendiente es intencional (van a CxC); fuera de esos dos, lo pagado
    // debe cuadrar con el total o se rechaza la venta completa, en vez de
    // aceptarla con el libro descuadrado y el inventario ya descontado.
    if (dto.payments?.length && !dto.isLayaway && !isCredit && Math.abs(paidNow - total) > 0.01) {
      throw new BadRequestException(
        `El monto pagado ($${paidNow.toFixed(2)}) no coincide con el total de la venta ($${total.toFixed(2)}).`,
      );
    }

    // `paymentStatus` ya no lo decide el cliente (dto.paymentStatus se
    // ignora) para layaway y crédito, que ya se derivaban server-side; y para
    // el resto, la reconciliación de arriba garantiza que si se llegó hasta
    // aquí es porque ya se pagó el total completo.
    let initialPaymentStatus: string;
    if (dto.isLayaway || isCredit) {
      initialPaymentStatus = paidNow >= total ? 'PAID' : paidNow > 0 ? 'PARTIALLY_PAID' : 'PENDING';
    } else {
      initialPaymentStatus = 'PAID';
    }

    const order = await this.prisma.$transaction(async (tx) => {
      // La sesión se resolvió fuera de la transacción (se necesita su tipo de
      // cambio para calcular totales). Revalidar aquí evita que una caja cerrada
      // en esa ventana reciba el movimiento y altere un corte ya emitido —
      // docs/AUDITORIA-CAJA.md (CASH-003).
      await assertSessionOpen(tx, tenantId, activeSessionForTc.id);

      const newOrder = await tx.order.create({
        data: {
          orderNumber,
          tenantId,
          ...(customerId != null && { customerId }),
          ...(addressId != null && { addressId }),
          subtotal,
          tax,
          shippingCost,
          discount: discountAmount,
          total,
          ...(dto.notes != null && dto.notes !== '' && { notes: dto.notes }),
          ...(couponId != null && { couponId }),
          ...(couponCode != null && { couponCode }),
          status: dto.isLayaway ? ('LAYAWAY' as any) : ((dto.status ?? 'PENDING') as any),
          paymentStatus: initialPaymentStatus as any,
          orderOrigin: 'RETAIL_POS',
          ...(createdById != null && { createdById }),
          ...(branchId != null && { branchId }),
          ...(dto.sourceQuoteId != null && { serviceQuoteId: dto.sourceQuoteId }),
          ...(hasUsdPayment && { exchangeRateUsed: exchangeRate }),
        },
      });

      // Create product order items
      for (const item of productItems) {
        const product = productMap.get(item.productId!)!;
        const m = lineMath.get(item)!;
        await tx.orderItem.create({
          data: {
            orderId: newOrder.id,
            itemType: 'PRODUCT',
            productId: product.id,
            // Qué variante se vendió. Sin esto la orden solo decía el producto,
            // y ni la devolución ni los reportes podían saber la talla.
            variantId: item.variantId ?? null,
            name: product.name,
            sku: product.sku,
            description: item.description ?? null,
            quantity: item.quantity,
            price: item.price,
            discount: m.discount,
            tax: m.tax,
            subtotal: m.subtotal,
            total: m.total,
          },
        });
      }

      // Create service order items (no stock impact)
      for (const item of serviceItems) {
        const catalogSvc = item.serviceId ? serviceMap.get(item.serviceId) : null;
        const m = lineMath.get(item)!;
        await tx.orderItem.create({
          data: {
            orderId: newOrder.id,
            itemType: 'SERVICE',
            serviceId: item.serviceId ?? null,
            name: item.name ?? catalogSvc?.name ?? 'Servicio',
            sku: null,
            description: item.description ?? null,
            quantity: item.quantity,
            price: item.price,
            discount: m.discount,
            tax: m.tax,
            subtotal: m.subtotal,
            total: m.total,
          },
        });
      }

      // Single inventory engine: SIMPLE / RECIPE / COMBO consumption + branch
      // inventory + movements, guarded against negative stock atomically.
      await this.inventory.consume(
        tx,
        productItems.map((i) => ({
          productId: i.productId ?? null,
          quantity: i.quantity,
          itemType: 'PRODUCT' as const,
          variantId: i.variantId ?? null,
        })),
        { tenantId, branchId: branchId ?? null, userId: createdById ?? null, referenceId: newOrder.id, referenceType: 'ORDER' },
      );

      const paymentStatus = initialPaymentStatus as any;
      const paymentConcept = dto.isLayaway ? 'LAYAWAY_DEPOSIT' : 'SALE';
      if (dto.payments && dto.payments.length > 0) {
        for (const split of dto.payments) {
          const currency = split.currency ?? 'MXN';
          const isUsd = currency === 'USD';
          const amountMxnEquivalent = isUsd ? convertMoney(split.amount, exchangeRate) : roundMoney(split.amount);
          await tx.payment.create({
            data: {
              orderId: newOrder.id,
              paymentMethod: split.method,
              currency,
              amount: split.amount,
              ...(split.amountReceived != null && { amountReceived: split.amountReceived }),
              ...(split.changeGiven != null && { changeGiven: split.changeGiven }),
              ...(split.method === 'CASH' && dto.changeCurrency != null && { changeCurrency: dto.changeCurrency }),
              ...(isUsd && {
                exchangeRateUsed: exchangeRate,
                amountOriginalCurrency: split.amount,
                amountMxnEquivalent,
              }),
              paymentConcept: paymentConcept as any,
              status: paymentStatus,
              ...(createdById != null && { createdById }),
            },
          });
        }
      } else {
        await tx.payment.create({
          data: {
            orderId: newOrder.id,
            paymentMethod: dto.paymentMethod,
            currency: 'MXN',
            amount: total,
            paymentConcept: paymentConcept as any,
            status: paymentStatus,
            ...(createdById != null && { createdById }),
          },
        });
      }

      if (couponId) {
        await this.couponsService.incrementUsage(couponId);
      }

      if (customerId) {
        await tx.customer.update({
          where: { id: customerId },
          data: {
            totalOrders: { increment: 1 },
            totalSpent: { increment: total },
          },
        });
      }

      // Auto-create CxC for credit orders and layaway with remaining balance
      // (`isCredit` ya se calculó arriba, antes de la reconciliación pago↔total).
      const remainingBalance = Math.max(0, total - paidNow);

      if (isCredit && customerId && remainingBalance > 0) {
        const dueDate = dto.dueDate
          ? new Date(dto.dueDate)
          : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

        // Pago mixto (efectivo/tarjeta/transferencia + crédito): la CxC sólo debe
        // reflejar el SALDO a crédito, no el total. paidNow ya excluye los CREDITO,
        // así que remainingBalance = lo realmente financiado. Espejo de apartados.
        await tx.accountReceivable.create({
          data: {
            tenantId,
            orderId: newOrder.id,
            customerId,
            totalAmount: total,
            balance: remainingBalance,
            status: 'PENDIENTE',
            dueDate,
          },
        });
      } else if (dto.isLayaway && remainingBalance > 0 && customerId) {
        // Layaway with partial deposit — track remainder as CxC
        const dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        await tx.accountReceivable.create({
          data: {
            tenantId,
            orderId: newOrder.id,
            customerId,
            totalAmount: total,
            balance: remainingBalance,
            status: 'PENDIENTE',
            dueDate,
          },
        });
      }

      // Create CashMovements for non-credit payments
      const cashMovementSessionId = activeSessionForTc?.id ?? null;

      const allPayments = dto.payments?.length
        ? dto.payments.map((p) => ({
            method: p.method,
            currency: p.currency ?? 'MXN',
            amount: p.amount,
            amountReceived: p.amountReceived ?? null,
            changeGiven: p.changeGiven ?? null,
          }))
        : [{ method: dto.paymentMethod, currency: 'MXN', amount: total, amountReceived: null, changeGiven: null }];

      for (const p of allPayments) {
        if (!p.method || p.method === 'CREDITO') continue;
        const isUsd = p.currency === 'USD';
        // Use sale amount (net) — amountReceived/changeGiven are metadata only (for tickets/audit)
        const netAmount = roundMoney(Number(p.amount));
        const amountMxnEquivalent = isUsd ? convertMoney(netAmount, exchangeRate) : netAmount;
        await tx.cashMovement.create({
          data: {
            tenantId,
            cashSessionId: cashMovementSessionId,
            type: 'SALE',
            currency: p.currency,
            amount: netAmount,
            ...(isUsd && {
              exchangeRateUsed: exchangeRate,
              amountOriginalCurrency: netAmount,
              amountMxnEquivalent,
            }),
            paymentMethod: p.method,
            referenceId: newOrder.id,
            referenceType: 'ORDER',
            createdById: createdById,
          },
        });
      }
      // Change is metadata only — no separate CHANGE_OUT movement

      // Mark source quote as CONVERTED if applicable
      if (dto.sourceQuoteId) {
        await tx.serviceQuote.update({
          where: { id: dto.sourceQuoteId },
          data: { status: 'CONVERTED' },
        });
      }

      return tx.order.findUnique({
        where: { id: newOrder.id },
        include: {
          customer: true,
          shippingAddress: true,
          items: { include: { product: true } },
          payments: true,
        },
      });
    });

    if (priceOverrides.length > 0) {
      await this.audit.log({
        action: 'ORDER_PRICE_OVERRIDE',
        entityType: 'Order',
        entityId: order!.id,
        after: { orderNumber, overrides: priceOverrides },
      });
    }
    if (discountOverrides.length > 0) {
      await this.audit.log({
        action: 'ORDER_DISCOUNT_OVERRIDE',
        entityType: 'Order',
        entityId: order!.id,
        after: { orderNumber, overrides: discountOverrides },
      });
    }

    return order!;
  }

  async findAll(query: QueryOrdersDto): Promise<PaginatedResponse<Order>> {
    const tenantId = this.tenantContext.requireTenantId();
    const { skip, limit, page, customerId, status, orderOrigin } = query;

    const where: any = {
      tenantId,
      ...(customerId != null && { customerId }),
      ...(status != null && { status }),
      ...(orderOrigin != null && { orderOrigin }),
    };

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          customer: true,
          items: { include: { product: true } },
          payments: true,
          refunds: { orderBy: { createdAt: 'desc' } },
        },
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      data: orders,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string): Promise<Order> {
    const tenantId = this.tenantContext.requireTenantId();
    const order = await this.prisma.order.findFirst({
      where: { id, tenantId },
      include: {
        customer: true,
        shippingAddress: true,
        items: { include: { product: true } },
        payments: true,
        refunds: { orderBy: { createdAt: 'desc' } },
      },
    });

    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  async updateStatus(id: string, status: OrderStatus): Promise<Order> {
    const tenantId = this.tenantContext.requireTenantId();
    const order = await this.prisma.order.findFirst({ where: { id, tenantId } });
    if (!order) throw new NotFoundException('Order not found');

    return this.prisma.order.update({
      where: { id },
      data: { status },
      include: { customer: true, items: true },
    });
  }

  async updateStatusAndPayment(id: string, status: OrderStatus): Promise<Order> {
    const tenantId = this.tenantContext.requireTenantId();
    const order = await this.prisma.order.findFirst({
      where: { id, tenantId },
      include: { payments: true },
    });
    if (!order) throw new NotFoundException('Order not found');

    const isCredit = order.payments.some((p) => p.paymentMethod === 'CREDITO');
    const totalPaid = order.payments.reduce((sum, p) => sum + Number(p.amount), 0);
    const fullyPaid = !isCredit && totalPaid >= Number(order.total);

    return this.prisma.order.update({
      where: { id },
      data: {
        status,
        ...(fullyPaid && { paymentStatus: 'PAID' }),
      },
      include: { customer: true, items: true, payments: true },
    });
  }

  /** Cancel an order: void it, restore inventory/cash/CxC. */
  async cancelOrder(id: string, reason: string): Promise<Order> {
    return this.reverseOrder(id, reason, 'CANCEL');
  }

  /** Return a sale (full refund MVP): restore inventory/cash, mark REFUNDED. */
  async returnOrder(id: string, reason: string): Promise<Order> {
    return this.reverseOrder(id, reason, 'RETURN');
  }

  private async reverseOrder(
    id: string,
    reason: string,
    mode: 'CANCEL' | 'RETURN',
  ): Promise<Order> {
    const tenantId = this.tenantContext.requireTenantId();
    const userId = this.auditContext.getUserId() ?? null;

    const order = await this.prisma.order.findFirst({
      where: { id, tenantId },
      include: {
        items: true,
        payments: true,
        refunds: { include: { items: true } },
        accountReceivable: { include: { payments: true } },
      },
    });
    if (!order) throw new NotFoundException('Venta no encontrada');
    if (order.status === 'CANCELLED' || order.status === 'REFUNDED') {
      throw new BadRequestException('La venta ya fue cancelada o devuelta');
    }

    const before = { status: order.status, paymentStatus: order.paymentStatus };

    // Cantidades ya devueltas al stock por reembolsos por línea previos. La reversa
    // solo debe restaurar el remanente no reembolsado; restaurar de nuevo lo que un
    // refund ya repuso genera stock fantasma / doble devolución.
    const refundedQtyByItem = new Map<string, number>();
    for (const r of order.refunds) {
      for (const ri of r.items) {
        refundedQtyByItem.set(
          ri.orderItemId,
          (refundedQtyByItem.get(ri.orderItemId) ?? 0) + ri.quantity,
        );
      }
    }
    // La reversa devuelve a la MISMA variante que se vendió, no a la default:
    // la simetría consume/restore es lo que evita que cancelar una venta de
    // tallas L acabe sumando existencia a "el producto en sí".
    const restorableItems = order.items
      .map((it) => ({
        productId: it.productId,
        itemType: it.itemType,
        variantId: it.variantId,
        quantity: it.quantity - (refundedQtyByItem.get(it.id) ?? 0),
      }))
      .filter((it) => it.quantity > 0);

    return this.prisma.$transaction(async (tx) => {
      // 1. Restaurar SOLO el remanente no reembolsado (engine: SIMPLE/RECIPE/COMBO).
      await this.inventory.restore(
        tx,
        restorableItems,
        {
          tenantId,
          branchId: order.branchId ?? null,
          userId,
          referenceId: order.id,
          referenceType: 'ORDER',
          note: `Reversa por ${mode}`,
        },
      );

      // 2. Reversar el efectivo de la venta MENOS lo que reembolsos previos ya
      // sacaron de la caja. Sin esto, un refund parcial (efectivo ya devuelto)
      // seguido de una reversa sacaría el dinero dos veces (doble salida).
      // Reversar devuelve dinero del cajón, así que exige caja abierta — igual
      // que el reembolso. Antes, sin sesión, los movimientos de reversa quedaban
      // huérfanos y la salida de efectivo no aparecía en ningún corte (CASH-001).
      const activeSession = await requireOpenSession(
        tx,
        tenantId,
        order.branchId ?? null,
        'No hay sesión de caja activa. Abre la caja antes de reversar la venta.',
      );
      const orderMovements = await tx.cashMovement.findMany({
        where: { tenantId, referenceId: order.id, referenceType: { in: ['ORDER', 'CHANGE_OUT'] } },
      });
      const priorRefundMovements = await tx.cashMovement.findMany({
        where: { tenantId, referenceId: order.id, referenceType: 'REFUND' },
      });
      const mxnValue = (m: (typeof orderMovements)[number]): number =>
        Number(m.amountMxnEquivalent ?? m.amount);

      const alreadyRefundedMxn = priorRefundMovements.reduce((s, m) => s + mxnValue(m), 0);
      let reverseBudgetMxn = Math.max(
        0,
        orderMovements.reduce((s, m) => s + mxnValue(m), 0) - alreadyRefundedMxn,
      );

      for (const m of orderMovements) {
        if (reverseBudgetMxn <= 0.001) break;
        const movMxn = mxnValue(m);
        // Fracción de este movimiento aún por reversar (acotada por el presupuesto).
        const fraction = movMxn > 0 ? Math.min(1, reverseBudgetMxn / movMxn) : 1;
        const reverseAmount = roundMoney(Number(m.amount) * fraction);
        if (reverseAmount <= 0) continue;
        reverseBudgetMxn -= movMxn * fraction;
        // SALE (cash in) → reverse with EXPENSE; CHANGE_OUT (cash out) → reverse with INCOME
        const reverseType = m.type === 'EXPENSE' ? 'INCOME' : 'EXPENSE';
        await tx.cashMovement.create({
          data: {
            tenantId,
            cashSessionId: activeSession.id,
            type: reverseType,
            currency: m.currency,
            amount: reverseAmount,
            ...(m.exchangeRateUsed != null && { exchangeRateUsed: m.exchangeRateUsed }),
            ...(m.amountOriginalCurrency != null && {
              amountOriginalCurrency: roundMoney(Number(m.amountOriginalCurrency) * fraction),
            }),
            ...(m.amountMxnEquivalent != null && {
              amountMxnEquivalent: roundMoney(Number(m.amountMxnEquivalent) * fraction),
            }),
            paymentMethod: m.paymentMethod,
            referenceId: order.id,
            referenceType: `REVERSAL_${mode}`,
            notes: `Reversa de venta ${order.orderNumber}`,
            createdById: userId,
          },
        });
      }

      // 3. Reverse CxC: delete if nothing collected, otherwise close it out
      if (order.accountReceivable) {
        const collected = order.accountReceivable.payments.length > 0;
        if (!collected) {
          await tx.accountReceivable.delete({
            where: { id: order.accountReceivable.id },
          });
        } else {
          await tx.accountReceivable.update({
            where: { id: order.accountReceivable.id },
            data: {
              balance: 0,
              status: 'PAGADO',
              notes: `Anulada por ${mode}: ${reason}`,
            },
          });
        }
      }

      // 4. Reverse customer stats
      if (order.customerId) {
        await tx.customer.update({
          where: { id: order.customerId },
          data: {
            totalOrders: { decrement: 1 },
            totalSpent: { decrement: Number(order.total) },
          },
        });
      }

      // 5. Update order status
      const updated = await tx.order.update({
        where: { id: order.id },
        data: {
          status: mode === 'CANCEL' ? 'CANCELLED' : 'REFUNDED',
          paymentStatus: 'REFUNDED',
          cancelledAt: new Date(),
          cancellationReason: reason,
          cancelledById: userId,
        },
        include: { customer: true, items: true, payments: true },
      });

      // 6. Audit trail
      await this.audit.log(
        {
          action: mode === 'CANCEL' ? 'ORDER_CANCEL' : 'ORDER_RETURN',
          entityType: 'Order',
          entityId: order.id,
          before,
          after: { status: updated.status, paymentStatus: updated.paymentStatus },
          reason,
        },
        tx,
      );

      return updated;
    });
  }

  async addPayment(orderId: string, dto: AddPaymentDto): Promise<Order> {
    const tenantId = this.tenantContext.requireTenantId();
    const userId = this.auditContext.getUserId() ?? null;
    const branchId = this.tenantContext.getBranchId() ?? null;

    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId },
      include: { payments: true, accountReceivable: true },
    });
    if (!order) throw new NotFoundException('Orden no encontrada');
    if (['CANCELLED', 'REFUNDED'].includes(order.status)) {
      throw new BadRequestException('No se pueden agregar pagos a una orden cancelada o reembolsada');
    }
    if (order.paymentStatus === 'PAID') {
      throw new BadRequestException('La orden ya está completamente pagada');
    }

    const activeSession = await this.prisma.cashSession.findFirst({
      where: { tenantId, branchId: branchId ?? undefined, status: 'ABIERTA' },
      select: { id: true, exchangeRateUsdMxn: true },
    });
    if (!activeSession) {
      throw new BadRequestException('No hay sesión de caja activa');
    }
    const sessionRate = Number(activeSession.exchangeRateUsdMxn);

    const orderTotal = Number(order.total);
    const alreadyPaid = order.payments
      .filter((p) => p.paymentMethod !== 'CREDITO' && p.status !== 'REFUNDED')
      .reduce((s, p) => s + Number(p.amount), 0);

    const hasCardPayment = dto.payments.some((p) => p.method === 'CARD');
    const paymentConcept = (dto.paymentConcept ?? 'BALANCE_PAYMENT') as any;

    return this.prisma.$transaction(async (tx) => {
      // Misma revalidación que en `create`: la sesión se leyó fuera de la
      // transacción para obtener su tipo de cambio (CASH-003).
      await assertSessionOpen(tx, tenantId, activeSession.id);

      // Create payment records
      for (const split of dto.payments) {
        const currency = split.currency ?? 'MXN';
        const isUsd = currency === 'USD';
        const amountMxnEquivalent = isUsd ? convertMoney(split.amount, sessionRate) : roundMoney(split.amount);
        await tx.payment.create({
          data: {
            orderId: order.id,
            paymentMethod: split.method,
            currency,
            amount: split.amount,
            ...(split.amountReceived != null && { amountReceived: split.amountReceived }),
            ...(split.changeGiven != null && { changeGiven: split.changeGiven }),
            ...(split.method === 'CASH' && dto.changeCurrency != null && { changeCurrency: dto.changeCurrency }),
            ...(isUsd && {
              exchangeRateUsed: sessionRate,
              amountOriginalCurrency: split.amount,
              amountMxnEquivalent,
            }),
            paymentConcept,
            status: split.method === 'CARD' ? 'PENDING' : ('PAID' as any),
            ...(userId != null && { createdById: userId }),
          },
        });
      }

      // Create cash movements for non-credit payments — paridad con create():
      // CARD también genera CashMovement SALE (no afecta el efectivo esperado, pero
      // alimenta totals.sales.card del corte). Sin él, abonos/liquidaciones con
      // tarjeta vía addPayment no aparecían en el resumen de caja. CREDITO se excluye.
      // Use sale amount (net) — amountReceived/changeGiven are metadata only (for tickets/audit)
      for (const p of dto.payments) {
        if (!p.method || p.method === 'CREDITO') continue;
        const isUsd = (p.currency ?? 'MXN') === 'USD';
        const netAmount = roundMoney(Number(p.amount));
        const amountMxnEquivalent = isUsd ? convertMoney(netAmount, sessionRate) : netAmount;
        await tx.cashMovement.create({
          data: {
            tenantId,
            cashSessionId: activeSession.id,
            type: 'SALE',
            currency: p.currency ?? 'MXN',
            amount: netAmount,
            ...(isUsd && { exchangeRateUsed: sessionRate, amountOriginalCurrency: netAmount, amountMxnEquivalent }),
            paymentMethod: p.method,
            referenceId: order.id,
            referenceType: 'ORDER',
            ...(userId != null && { createdById: userId }),
          },
        });
      }
      // Change is metadata only — no separate CHANGE_OUT movement

      // Recompute payment status
      const newlyPaidNonCard = dto.payments
        .filter((p) => p.method !== 'CREDITO' && p.method !== 'CARD')
        .reduce((s, p) => s + Number(p.amount), 0);
      const totalPaid = alreadyPaid + newlyPaidNonCard;

      let newPaymentStatus: string;
      if (hasCardPayment) {
        newPaymentStatus = 'PENDING'; // confirmed by updateStatusAndPayment flow
      } else {
        newPaymentStatus =
          totalPaid >= orderTotal ? 'PAID' : totalPaid > 0 ? 'PARTIALLY_PAID' : 'PENDING';
      }

      const newOrderStatus =
        newPaymentStatus === 'PAID' && order.status === 'LAYAWAY' ? 'CONFIRMED' : order.status;

      await tx.order.update({
        where: { id: order.id },
        data: {
          paymentStatus: newPaymentStatus as any,
          status: newOrderStatus as any,
        },
      });

      // Update CxC balance if exists
      if (order.accountReceivable) {
        const newBalance = Math.max(0, orderTotal - totalPaid);
        const newCxCStatus =
          newBalance <= 0 ? 'PAGADO' : newBalance < orderTotal ? 'PARCIAL' : 'PENDIENTE';
        await tx.accountReceivable.update({
          where: { id: order.accountReceivable.id },
          data: { balance: newBalance, status: newCxCStatus as any },
        });
      }

      return tx.order.findUnique({
        where: { id: order.id },
        include: { customer: true, items: { include: { product: true } }, payments: true },
      }) as Promise<Order>;
    });
  }

  /**
   * Refund a layaway deposit or a partial/full amount from a sale.
   * Creates an OrderRefund record, a EXPENSE cash movement (money out to customer),
   * and updates the order paymentStatus accordingly.
   */
  async refundOrder(orderId: string, dto: RefundOrderDto): Promise<Order> {
    const tenantId = this.tenantContext.requireTenantId();
    const userId = this.auditContext.getUserId() ?? null;
    const branchId = this.tenantContext.getBranchId() ?? null;

    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId },
      include: {
        payments: true,
        items: true,
        refunds: { include: { items: true } },
        accountReceivable: true,
      },
    });
    if (!order) throw new NotFoundException('Orden no encontrada');
    if (order.status === 'CANCELLED' || order.status === 'REFUNDED') {
      throw new BadRequestException('La orden ya fue cancelada o reembolsada completamente');
    }

    // Validate amount: cannot exceed what has actually been collected
    const totalCollected = order.payments
      .filter((p) => p.status !== 'REFUNDED' && p.paymentMethod !== 'CREDITO')
      .reduce((s, p) => s + Number(p.amount), 0);
    const previouslyRefunded = order.refunds.reduce((s, r) => s + Number(r.amount), 0);
    const maxRefundable = totalCollected - previouslyRefunded;

    // Resolve the refund as money-only or item-level. Item-level refunds derive
    // their amount from the lines and drive inventory restoration; the cumulative
    // quantity already refunded per line is what prevents restoring it twice.
    const itemMap = new Map(order.items.map((i) => [i.id, i]));
    const alreadyRefundedQty = new Map<string, number>();
    for (const r of order.refunds) {
      for (const ri of r.items) {
        alreadyRefundedQty.set(ri.orderItemId, (alreadyRefundedQty.get(ri.orderItemId) ?? 0) + ri.quantity);
      }
    }

    const refundLines: { orderItem: (typeof order.items)[number]; quantity: number }[] = [];
    let refundAmount: number;

    if (dto.items?.length) {
      for (const line of dto.items) {
        const orderItem = itemMap.get(line.orderItemId);
        if (!orderItem) {
          throw new BadRequestException(`La línea ${line.orderItemId} no pertenece a esta orden`);
        }
        const refundedQty = alreadyRefundedQty.get(orderItem.id) ?? 0;
        const remaining = orderItem.quantity - refundedQty;
        if (line.quantity > remaining) {
          throw new BadRequestException(
            `No se pueden reembolsar ${line.quantity} de "${orderItem.name}": ` +
              `disponibles ${remaining} (vendidas ${orderItem.quantity}, ya reembolsadas ${refundedQty})`,
          );
        }
        refundLines.push({ orderItem, quantity: line.quantity });
      }
      const linesAmount = roundMoney(
        refundLines.reduce(
          (s, l) => s + (Number(l.orderItem.total) / l.orderItem.quantity) * l.quantity,
          0,
        ),
      );
      if (dto.amount != null && Math.abs(dto.amount - linesAmount) > 0.01) {
        throw new BadRequestException(
          `El monto indicado ($${dto.amount}) no coincide con la suma de las líneas ($${linesAmount.toFixed(2)})`,
        );
      }
      refundAmount = dto.amount ?? linesAmount;
    } else {
      if (dto.amount == null) {
        throw new BadRequestException('Debes indicar un monto a reembolsar o las líneas a devolver');
      }
      refundAmount = dto.amount;
    }

    if (refundAmount > maxRefundable + 0.001) {
      throw new BadRequestException(
        `El monto a reembolsar ($${refundAmount}) supera el máximo reembolsable ($${maxRefundable.toFixed(2)})`,
      );
    }

    // Check layaway refund time window from tenant settings (only if NOT overriding)
    if (!dto.windowOverride && order.status === 'LAYAWAY' && order.createdAt) {
      const tenantRow = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { settings: true },
      });
      const settings = (tenantRow?.settings ?? {}) as Record<string, unknown>;
      const windowHours = typeof settings.layawayRefundWindowHours === 'number'
        ? settings.layawayRefundWindowHours
        : 24;
      const hoursElapsed = (Date.now() - new Date(order.createdAt).getTime()) / 3_600_000;
      if (windowHours > 0 && hoursElapsed > windowHours) {
        throw new BadRequestException(
          `El plazo de reembolso de ${windowHours}h ha vencido. Se requiere autorización para continuar.`,
        );
      }
    }

    const currency = dto.currency ?? 'MXN';

    // Original payment method (most recent non-credit payment)
    const originalMethod =
      [...order.payments]
        .filter((p) => p.paymentMethod !== 'CREDITO')
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]
        ?.paymentMethod ?? null;

    return this.prisma.$transaction(async (tx) => {
      // 1. Find active cash session
      const activeSession = await tx.cashSession.findFirst({
        where: { tenantId, branchId: branchId ?? undefined, status: 'ABIERTA' },
        select: { id: true, exchangeRateUsdMxn: true },
      });
      if (!activeSession) throw new BadRequestException('No hay sesión de caja activa');

      const sessionRate = Number(activeSession.exchangeRateUsdMxn);
      const isUsd = currency === 'USD';

      // 2. Cash movement: REFUND (money leaves the drawer to the customer).
      //    Se tipaba EXPENSE y el corte lo mostraba como egreso manual (CASH-013).
      const cashMov = await tx.cashMovement.create({
        data: {
          tenantId,
          cashSessionId: activeSession.id,
          type: 'REFUND',
          currency,
          amount: refundAmount,
          ...(isUsd && {
            exchangeRateUsed: sessionRate,
            amountOriginalCurrency: refundAmount,
            amountMxnEquivalent: convertMoney(refundAmount, sessionRate),
          }),
          paymentMethod: dto.refundMethod,
          referenceId: order.id,
          referenceType: 'REFUND',
          notes: `Reembolso: ${dto.reason}`,
          ...(userId != null && { createdById: userId }),
        },
      });

      // 3. OrderRefund record. Item-level refunds always restore inventory.
      const restoresInventory = refundLines.length > 0;
      const refund = await tx.orderRefund.create({
        data: {
          tenantId,
          orderId: order.id,
          amount: refundAmount,
          currency,
          refundMethod: dto.refundMethod,
          originalMethod: originalMethod ?? undefined,
          reason: dto.reason,
          restoreInventory: restoresInventory,
          windowOverride: dto.windowOverride ?? false,
          notes: dto.notes ?? null,
          cashMovementId: cashMov.id,
          ...(userId != null && { createdById: userId }),
        },
      });

      // 4. Item-level refund: persist the refunded lines (cumulative cap already
      // enforced above) and restore stock for exactly those quantities. Money-only
      // refunds (no lines) never touch inventory.
      if (restoresInventory) {
        for (const line of refundLines) {
          await tx.orderRefundItem.create({
            data: {
              refundId: refund.id,
              orderItemId: line.orderItem.id,
              productId: line.orderItem.productId ?? null,
              quantity: line.quantity,
            },
          });
        }
        await this.inventory.restore(
          tx,
          refundLines.map((l) => ({
            productId: l.orderItem.productId,
            quantity: l.quantity,
            itemType: l.orderItem.itemType,
            // Se reingresa a la variante de la línea reembolsada.
            variantId: l.orderItem.variantId,
          })),
          {
            tenantId,
            branchId: order.branchId ?? null,
            userId,
            referenceId: order.id,
            referenceType: 'REFUND',
            note: `Reembolso: ${dto.reason}`,
          },
        );
      }

      // 5. Recompute payment status
      const newTotalRefunded = previouslyRefunded + refundAmount;
      const isFullRefund = newTotalRefunded >= totalCollected - 0.001;

      let newPaymentStatus: string;
      if (isFullRefund) {
        newPaymentStatus = 'REFUNDED';
      } else {
        newPaymentStatus = 'PARTIALLY_REFUNDED';
      }

      // For layaway orders being fully refunded: also cancel the order
      const isLayaway = order.status === 'LAYAWAY';
      const newOrderStatus = isFullRefund && isLayaway ? 'CANCELLED' : order.status;

      await tx.order.update({
        where: { id: order.id },
        data: {
          paymentStatus: newPaymentStatus as any,
          status: newOrderStatus as any,
          ...(isFullRefund && isLayaway && {
            cancelledAt: new Date(),
            cancellationReason: dto.reason,
            cancelledById: userId,
          }),
        },
      });

      // 6. Update CxC if exists and fully refunded
      if (order.accountReceivable && isFullRefund) {
        await tx.accountReceivable.update({
          where: { id: order.accountReceivable.id },
          data: {
            balance: 0,
            status: 'PAGADO',
            notes: `Reembolso: ${dto.reason}`,
          },
        });
      }

      // 7. Audit
      await this.audit.log(
        {
          action: 'ORDER_REFUND',
          entityType: 'Order',
          entityId: order.id,
          before: { status: order.status, paymentStatus: order.paymentStatus },
          after: { status: newOrderStatus, paymentStatus: newPaymentStatus, refundAmount },
          reason: dto.reason,
        },
        tx,
      );

      return tx.order.findUnique({
        where: { id: order.id },
        include: { customer: true, items: { include: { product: true } }, payments: true, refunds: true },
      }) as Promise<Order>;
    });
  }

  async getStats() {
    const tenantId = this.tenantContext.requireTenantId();

    const [totalOrders, totalRevenue, pendingOrders, recentOrders] =
      await Promise.all([
        this.prisma.order.count({ where: { tenantId } }),
        this.prisma.order.aggregate({
          _sum: { total: true },
          where: { tenantId, paymentStatus: 'PAID' },
        }),
        this.prisma.order.count({ where: { tenantId, status: 'PENDING' } }),
        this.prisma.order.findMany({
          where: { tenantId },
          take: 10,
          orderBy: { createdAt: 'desc' },
          include: {
            customer: true,
            _count: { select: { items: true } },
          },
        }),
      ]);

    return {
      totalOrders,
      totalRevenue: totalRevenue._sum.total || 0,
      pendingOrders,
      recentOrders,
    };
  }

  /**
   * Obtiene cupones auto-aplicables para una orden en proceso
   */
  async getApplicableCoupons(params: {
    customerId: string;
    items: Array<{ productId: string; quantity: number; price: number }>;
  }): Promise<Coupon[]> {
    // Obtener IDs de productos y sus categorías
    const productIds = params.items.map((item) => item.productId);

    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds } },
      include: { category: true },
    });

    const categoryIds = [
      ...new Set(
        products
          .map((p) => p.categoryId)
          .filter((id): id is string => id !== null),
      ),
    ];

    // Calcular total de la orden
    const totalAmount = params.items.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0,
    );

    // Obtener cupones auto-aplicables
    return this.couponsService.getAutoApplicableCoupons({
      customerId: params.customerId,
      productIds,
      categoryIds,
      totalAmount,
    });
  }

  /**
   * Calcula el mejor descuento de múltiples cupones auto-aplicables
   */
  async calculateBestDiscount(params: {
    customerId: string;
    items: Array<{ productId: string; quantity: number; price: number }>;
  }): Promise<{
    bestCoupon: Coupon | null;
    discountAmount: number;
  }> {
    const applicableCoupons = await this.getApplicableCoupons(params);

    if (applicableCoupons.length === 0) {
      return { bestCoupon: null, discountAmount: 0 };
    }

    const totalAmount = params.items.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0,
    );

    let bestCoupon: Coupon | null = null;
    let maxDiscount = 0;

    for (const coupon of applicableCoupons) {
      let discount = 0;

      if (coupon.type === 'PERCENTAGE') {
        discount = (totalAmount * Number(coupon.value)) / 100;

        // Aplicar descuento máximo si existe
        if (coupon.maxDiscount && discount > Number(coupon.maxDiscount)) {
          discount = Number(coupon.maxDiscount);
        }
      } else {
        // FIXED
        discount = Math.min(Number(coupon.value), totalAmount);
      }

      if (discount > maxDiscount) {
        maxDiscount = discount;
        bestCoupon = coupon;
      }
    }

    return {
      bestCoupon,
      discountAmount: maxDiscount,
    };
  }
}
