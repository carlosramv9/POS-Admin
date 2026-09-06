import { IsString, IsNumber, IsOptional, IsEnum, IsBoolean, IsUUID, Min, IsArray, ValidateNested } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ProductStatus, TaxCode, ProductType } from '@prisma/client';
import { Type, Transform } from 'class-transformer';
import { RecipeItemDto, ComboItemDto, ProductVariantDto, ProductFeatureDto } from './create-product.dto';

export class UpdateProductDto {
  @ApiPropertyOptional({ enum: ProductType })
  @IsOptional()
  @IsEnum(ProductType)
  type?: ProductType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  price?: number;

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

  @ApiPropertyOptional({ enum: ProductStatus })
  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  /**
   * `stock` NO se acepta al editar, a propósito.
   *
   * Escribirlo actualizaba `products.stock` —la columna espejo legacy— sin tocar
   * `branch_inventory`, que es de donde se lee la existencia: el usuario cambiaba
   * el número, guardaba, y no pasaba nada visible. De paso desincronizaba el
   * espejo, que el motor de inventario usaba para sembrar filas nuevas.
   *
   * La existencia se mueve por su flujo propio, que sí escribe el
   * `InventoryMovement` correspondiente: `PATCH /products/:id/stock`.
   */

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  trackInventory?: boolean;

  @ApiPropertyOptional()
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

  @ApiPropertyOptional({ enum: TaxCode })
  @IsOptional()
  @IsEnum(TaxCode)
  taxCode?: TaxCode;

  @ApiPropertyOptional({
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
}
