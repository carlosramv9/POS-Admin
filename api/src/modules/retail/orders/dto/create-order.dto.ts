import {
  IsString,
  IsOptional,
  IsUUID,
  IsArray,
  ValidateNested,
  IsNumber,
  IsBoolean,
  Min,
  Max,
  IsNotEmpty,
  MaxLength,
  IsEnum,
  ValidateIf,
} from 'class-validator';


import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreatePaymentSplitDto {
  @ApiProperty({ example: 'CASH', description: 'Método de pago: CASH, CARD, TRANSFER' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  method: string;

  @ApiPropertyOptional({ example: 'MXN', enum: ['MXN', 'USD'], description: 'Moneda del pago' })
  @IsOptional()
  @IsEnum(['MXN', 'USD'])
  currency?: 'MXN' | 'USD';

  @ApiProperty({ example: 150.0, minimum: 0, description: 'Monto en la moneda del pago' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amount: number;

  @ApiPropertyOptional({ minimum: 0, description: 'CASH: monto recibido del cliente (en la moneda del pago)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amountReceived?: number;

  @ApiPropertyOptional({ minimum: 0, description: 'CASH: cambio entregado al cliente (en la moneda del pago)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  changeGiven?: number;
}

export class CreateOrderItemDto {
  @ApiPropertyOptional({ enum: ['PRODUCT', 'SERVICE'], default: 'PRODUCT' })
  @IsOptional()
  @IsEnum(['PRODUCT', 'SERVICE'])
  itemType?: 'PRODUCT' | 'SERVICE';

  /** Requerido si itemType = PRODUCT */
  @ApiPropertyOptional({ description: 'ID de producto (requerido si itemType=PRODUCT)' })
  @ValidateIf((o) => !o.itemType || o.itemType === 'PRODUCT')
  @IsNotEmpty()
  @IsUUID()
  productId?: string;

  /**
   * Variante vendida (talla, presentación...). Omitirla significa la default —
   * "el producto en sí"—, que es el caso de todo producto que nunca se dividió
   * en presentaciones.
   *
   * De ella depende de qué existencia se descuenta: sin este campo, vender una
   * talla L bajaba el stock de la línea default y el de la L no se movía nunca.
   * Se valida contra el producto; una variante ajena se rechaza.
   */
  @ApiPropertyOptional({ description: 'ID de la variante vendida (por defecto, la del producto sin variante)' })
  @IsOptional()
  @IsUUID()
  variantId?: string;

  /** Opcional si itemType = SERVICE — puede ser del catálogo o null (manual) */
  @ApiPropertyOptional({ description: 'ID de servicio del catálogo (itemType=SERVICE)' })
  @IsOptional()
  @IsUUID()
  serviceId?: string;

  /** Requerido si itemType = SERVICE y no hay serviceId */
  @ApiPropertyOptional({ description: 'Nombre del item (requerido para SERVICE sin serviceId)' })
  @ValidateIf((o) => o.itemType === 'SERVICE' && !o.serviceId)
  @IsNotEmpty()
  @IsString()
  @MaxLength(300)
  name?: string;

  @ApiPropertyOptional({ description: 'Descripción o notas del item' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  // Tope arbitrario pero generoso: ninguna venta de mostrador real llega a
  // 10,000 unidades de un mismo item. Sin techo, `quantity` sin `@Max` dejaba
  // vaciar el inventario de un producto ajeno en una sola línea (ver C-01).
  @ApiProperty({ minimum: 1, maximum: 10_000 })
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(10_000)
  quantity: number;

  @ApiProperty({ minimum: 0, description: 'Precio unitario' })
  @Transform(({ value }) => (value === '' || value === null ? undefined : Number(value)))
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  price: number;

  @ApiPropertyOptional({ minimum: 0, default: 0, description: 'Descuento sobre el item' })
  @IsOptional()
  @Transform(({ value }) => (value === '' || value === null ? 0 : Number(value)))
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  discount?: number;

  @ApiPropertyOptional({ minimum: 0, default: 0, description: 'Impuesto sobre el item' })
  @IsOptional()
  @Transform(({ value }) => (value === '' || value === null ? 0 : Number(value)))
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  tax?: number;

  @ApiPropertyOptional({
    default: false,
    description: 'Forzar impuesto en 0 para este item (ignora taxRate del producto/tenant). Útil cuando el cliente no requiere factura.',
  })
  @IsOptional()
  @IsBoolean()
  taxExempt?: boolean;
}

export class CreateOrderDto {
  @ApiPropertyOptional({ description: 'Omitir = venta general (mostrador)' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiProperty({ type: [CreateOrderItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items: CreateOrderItemDto[];

  @ApiProperty({ example: 'CASH', description: 'Método de pago principal: CASH, CARD, TRANSFER' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  paymentMethod: string;

  @ApiPropertyOptional({
    type: [CreatePaymentSplitDto],
    description: 'Pago dividido en múltiples métodos. Si se provee, se ignora paymentMethod para los registros de pago.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreatePaymentSplitDto)
  payments?: CreatePaymentSplitDto[];

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Transform(({ value }) => (value === '' || value === null ? undefined : Number(value)))
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  shippingCost?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional({ description: 'Código de cupón a aplicar' })
  @IsOptional()
  @IsString()
  couponCode?: string;

  @ApiPropertyOptional({ enum: ['PENDING', 'PARTIALLY_PAID', 'PAID', 'FAILED', 'REFUNDED'], default: 'PENDING' })
  @IsOptional()
  @IsEnum(['PENDING', 'PARTIALLY_PAID', 'PAID', 'FAILED', 'REFUNDED'])
  paymentStatus?: string;

  @ApiPropertyOptional({ enum: ['PENDING', 'LAYAWAY', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED'], default: 'PENDING' })
  @IsOptional()
  @IsEnum(['PENDING', 'LAYAWAY', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED'])
  status?: string;

  @ApiPropertyOptional({ description: 'Crear como apartado (LAYAWAY). Los pagos se tratan como depósito/anticipo.' })
  @IsOptional()
  isLayaway?: boolean;

  @ApiPropertyOptional({ description: 'Fecha de vencimiento para órdenes a crédito (ISO string). Default: 30 días.' })
  @IsOptional()
  @IsString()
  dueDate?: string;

  @ApiPropertyOptional({ description: 'ID de cotización de servicio que origina esta venta (se marcará como CONVERTED).' })
  @IsOptional()
  @IsUUID()
  sourceQuoteId?: string;

  @ApiPropertyOptional({ minimum: 0, description: 'Cambio total a devolver al cliente en efectivo (en la moneda de changeCurrency)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  changeAmount?: number;

  @ApiPropertyOptional({ enum: ['MXN', 'USD'], description: 'Moneda en que se entregará el cambio' })
  @IsOptional()
  @IsEnum(['MXN', 'USD'])
  changeCurrency?: 'MXN' | 'USD';
}
