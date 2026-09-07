import { IsInt, IsOptional, IsString, Min, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class InventoryItemDto {
  @ApiProperty() @IsString() productId: string;

  /**
   * Variante que se cuenta. Omitirla significa la default — "el producto en
   * sí"—, que es lo único que este endpoint sabía contar antes.
   */
  @ApiPropertyOptional({ description: 'Variante contada; por defecto, la del producto sin variante' })
  @IsOptional()
  @IsString()
  variantId?: string;

  @ApiProperty() @IsInt() @Min(0) stock: number;
}

export class BulkUpdateInventoryDto {
  @ApiProperty({ type: [InventoryItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InventoryItemDto)
  items: InventoryItemDto[];
}

export class TransferStockDto {
  @ApiProperty() @IsString() toBranchId: string;
  @ApiProperty() @IsString() productId: string;

  /** Variante que se traslada. Por defecto, la del producto sin variante. */
  @ApiPropertyOptional({ description: 'Variante trasladada; por defecto, la del producto sin variante' })
  @IsOptional()
  @IsString()
  variantId?: string;

  @ApiProperty() @IsInt() @Min(1) quantity: number;
}
