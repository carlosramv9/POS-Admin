import { IsString, IsOptional, IsArray, ValidateNested, IsInt, IsNumber, Min, IsDateString, ArrayMinSize } from 'class-validator';
import { Type } from 'class-transformer';

export class CreatePurchaseOrderItemDto {
  @IsString()
  productId: string;

  /**
   * Variante que se compra. Omitirla significa la default del producto —"el
   * producto en sí"—, que es lo que hacía siempre antes de que la línea pudiera
   * nombrarla. Se valida contra el producto: una variante ajena se rechaza.
   */
  @IsOptional()
  @IsString()
  variantId?: string;

  @IsInt()
  @Min(1)
  quantityOrdered: number;

  @IsNumber()
  @Min(0)
  unitCost: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  tax?: number;
}

export class CreatePurchaseOrderDto {
  @IsString()
  supplierId: string;

  @IsDateString()
  @IsOptional()
  expectedDate?: string;

  @IsString()
  @IsOptional()
  notes?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreatePurchaseOrderItemDto)
  items: CreatePurchaseOrderItemDto[];
}
