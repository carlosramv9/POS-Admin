import { IsString, IsNumber, IsOptional, IsEnum, IsBoolean, IsUUID, Min, MinLength, MaxLength, ValidateNested, IsArray } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProductStatus, TaxCode, ProductType } from '@prisma/client';
import { Type, Transform } from 'class-transformer';

export class ProductVariantDto {
  @ApiProperty({ description: 'Ej. "Talla M", "Extra queso"' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  /**
   * Costo y precio de la variante EN LA SUCURSAL EN CONTEXTO — viven en
   * `branch_inventory` por (sucursal, variante). Guardar aquí nunca cambia el
   * precio de la misma variante en otra sucursal.
   */
  @ApiPropertyOptional({ default: 0, description: 'Costo en la sucursal en contexto' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  cost?: number;

  @ApiPropertyOptional({ default: 0, description: 'Precio en la sucursal en contexto' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  price?: number;

  /**
   * Solo se aplica al ALTA de la variante. Al editar una variante existente se
   * ignora: la existencia se mueve por movimientos de inventario, no por
   * guardar el formulario.
   */
  @ApiPropertyOptional({
    description:
      'Existencia inicial de esta variante en la sucursal en contexto. Se ignora al editar una variante existente.',
    default: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  stock?: number;

  /**
   * Se envía al editar para poder distinguir una variante existente de una nueva
   * y así conservar sus existencias; sin él, guardar el producto reemplazaría el
   * juego completo de variantes y el stock se perdería.
   */
  @ApiPropertyOptional({ description: 'Id de una variante existente' })
  @IsOptional()
  @IsUUID()
  id?: string;
}

export class ProductFeatureDto {
  @ApiProperty({ description: 'Ej. "Material", "Peso", "Origen"' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  feature: string;

  @ApiProperty({ description: 'Ej. "Algodón", "500 g", "México"' })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  value: string;
}

export class RecipeItemDto {
  @ApiProperty()
  @IsUUID()
  supplyId: string;

  @ApiProperty()
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  quantity: number;

  @ApiProperty()
  @IsString()
  unit: string;

  @ApiPropertyOptional({ description: 'MeasurementUnit id — enables auto normalizedQuantity' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  unitId?: string;
}

export class ComboItemDto {
  @ApiProperty()
  @IsUUID()
  childProductId: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  quantity?: number;
}

export class CreateProductDto {
  @ApiPropertyOptional({ enum: ProductType, default: 'SIMPLE' })
  @IsOptional()
  @IsEnum(ProductType)
  type?: ProductType;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  sku: string;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  price: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  comparePrice?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costPrice?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ enum: ProductStatus, default: 'DRAFT' })
  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  stock?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  trackInventory?: boolean;

  @ApiPropertyOptional({ default: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  lowStockAlert?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  metaTitle?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  metaDescription?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => (value === '' || value === null ? undefined : value))
  @Type(() => Number)
  @IsNumber({ allowNaN: false })
  @Min(0)
  taxRate?: number;

  @ApiPropertyOptional({ enum: TaxCode, default: 'IVA_16' })
  @IsOptional()
  @IsEnum(TaxCode)
  taxCode?: TaxCode;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  slug?: string;

  @ApiPropertyOptional({
    default: false,
    description: 'Publica el producto en la tienda en línea (habilita la captura de atributos)',
  })
  @IsOptional()
  @IsBoolean()
  isEcommerce?: boolean;

  @ApiPropertyOptional({ type: [RecipeItemDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RecipeItemDto)
  recipeItems?: RecipeItemDto[];

  @ApiPropertyOptional({ type: [ComboItemDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ComboItemDto)
  comboItems?: ComboItemDto[];

  @ApiPropertyOptional({ type: [ProductVariantDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductVariantDto)
  variants?: ProductVariantDto[];

  @ApiPropertyOptional({ type: [ProductFeatureDto], description: 'Ficha técnica opcional (característica/valor)' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductFeatureDto)
  features?: ProductFeatureDto[];

  @ApiPropertyOptional({
    description:
      'requestId del borrador del AI Product Assistant, si este producto se creó a partir de uno (§07). Nunca decide qué se crea — solo permite trazar el desenlace del draft.',
  })
  @IsOptional()
  @IsString()
  aiRequestId?: string;

  @ApiPropertyOptional({
    enum: ['ACCEPTED', 'EDITED'],
    description: 'Si vino de un draft de IA: si el usuario lo aceptó tal cual o editó algún campo antes de confirmar.',
  })
  @IsOptional()
  @IsEnum(['ACCEPTED', 'EDITED'])
  aiOutcome?: 'ACCEPTED' | 'EDITED';
}
