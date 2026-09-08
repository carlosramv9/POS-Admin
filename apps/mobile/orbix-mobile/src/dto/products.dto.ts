/**
 * `/products` and `/categories` — shapes taken from `ProductsService`/
 * `CategoriesService` (`api/src/modules/retail/{products,categories}`).
 *
 * Decimal fields (`price`, `comparePrice`, `costPrice`, `taxRate`) serialise as
 * strings over JSON, same rationale as `DashboardStatsDto.totalRevenue`.
 */
import type { ProductStatus, ProductType, TaxCode } from '@/types/api';

/**
 * Una imagen ya subida. `url` es absoluta y pública — apunta al bucket R2 de
 * Cloudflare (`R2_PUBLIC_URL`), que es lo que el API guarda en la columna: el
 * cliente la consume tal cual, sin firmar ni recomponer nada. `key` es la ruta
 * interna en el bucket y solo le sirve al servidor para borrar el objeto.
 */
export interface ProductImageDto {
  id: string;
  productId: string;
  url: string;
  key?: string | null;
  mimeType?: string | null;
  size?: number | null;
  altText?: string | null;
  sortOrder: number;
  isPrimary: boolean;
  createdAt: string;
}

/**
 * Una línea del producto: "Talla M", "Extra queso". No es un catálogo reusable
 * entre productos — cada variante pertenece a exactamente uno.
 *
 * Todo producto tiene además su variante **default** (`isDefault: true`,
 * `name: null`): la línea implícita "el producto en sí", la que lleva el stock
 * de los productos que nunca se dividieron en presentaciones. Es interna, la UI
 * no la lista ni la manda de vuelta.
 *
 * `stock`, `price` y `cost` que llegan aquí son los de la **sucursal en
 * contexto** (o la suma de todas, para el stock, si el token no trae sucursal):
 * viven en `branch_inventory` por (sucursal, variante), no en la variante.
 */
export interface ProductVariantDto {
  id: string;
  name: string | null;
  /**
   * Códigos de ESTA presentación. ADR-0030 los pone en la variante porque es la
   * unidad vendible: una talla M y una L son artículos distintos en la caja.
   * Vacíos, manda el `sku` del producto, que sigue siendo el código padre.
   */
  sku: string | null;
  barcode: string | null;
  isDefault: boolean;
  trackInventory: boolean;
  cost: string | number;
  price: string | number;
  stock: number;
  lowStockAlert: number | null;
  stockByBranch?: { branchId: string; stock: number }[];
}

/**
 * Lo que el formulario manda de vuelta. `id` distingue una variante existente
 * de una nueva: sin él el servidor no puede sincronizar y el guardado se
 * llevaría por delante las existencias de todas las sucursales.
 *
 * `stock` solo se aplica al alta de la variante — al editar una existente el
 * servidor lo ignora, porque la existencia se mueve por movimientos de
 * inventario, no por guardar el formulario.
 */
export interface ProductVariantInput {
  id?: string;
  name: string;
  sku?: string;
  barcode?: string;
  cost?: number;
  price?: number;
  stock?: number;
}

export interface ProductDto {
  id: string;
  sku: string;
  name: string;
  slug: string;
  description: string | null;
  price: string | number;
  comparePrice: string | number | null;
  costPrice: string | number | null;
  type: ProductType;
  categoryId: string | null;
  category: { id: string; name: string } | null;
  status: ProductStatus;
  stock: number;
  trackInventory: boolean;
  lowStockAlert: number;
  taxRate: string | number | null;
  taxCode: TaxCode | null;
  isEcommerce: boolean;
  /** `PRODUCT_INCLUDE` las trae ordenadas por `sortOrder` en list y en detalle. */
  images?: ProductImageDto[];
  /** La default encabeza la lista; el resto van por nombre. */
  variants?: ProductVariantDto[];
  createdAt: string;
  updatedAt: string;
}

export interface PaginatedDto<T> {
  data: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

export interface CategoryDto {
  id: string;
  name: string;
  parentId: string | null;
}

export interface CreateCategoryRequest {
  name: string;
}

export interface CreateProductRequest {
  type?: ProductType;
  sku: string;
  /**
   * Código de barras del producto sin presentaciones: el servidor lo guarda en
   * su variante única. Con presentaciones cada una trae el suyo y este se
   * ignora.
   */
  barcode?: string;
  name: string;
  description?: string;
  price: number;
  comparePrice?: number;
  costPrice?: number;
  categoryId?: string;
  status?: ProductStatus;
  stock?: number;
  trackInventory?: boolean;
  lowStockAlert?: number;
  taxRate?: number;
  taxCode?: TaxCode;
  isEcommerce?: boolean;
  /**
   * Solo las variantes con nombre. La default es interna: nunca viaja en el
   * DTO y el servidor la conserva por su cuenta.
   */
  variants?: ProductVariantInput[];
}

export type UpdateProductRequest = Partial<CreateProductRequest>;
