import type { ListResponse } from '@/interfaces/list-response'
import { api } from '@/lib/api-client'

export interface ProductImage {
  id: string
  productId: string
  url: string
  key?: string
  mimeType?: string
  size?: number
  altText?: string
  sortOrder: number
  isPrimary: boolean
  createdAt: string
}

export type ProductType = 'SIMPLE' | 'RECIPE' | 'COMBO' | 'SERVICE'

export interface RecipeItem {
  id?: string
  supplyId: string
  quantity: number
  unit: string
  unitId?: string | null
  normalizedQuantity?: number | null
  supply?: {
    id: string
    name: string
    unit: string
    stock: number
    cost: number
    conversionFactor?: number
    inventoryUnitId?: string | null
    baseUnitId?: string | null
    inventoryUnit?: { id: string; symbol: string; name: string } | null
    baseUnit?: { id: string; symbol: string; name: string } | null
  }
}

export interface ComboItem {
  id?: string
  childProductId: string
  quantity: number
  child?: { id: string; name: string; sku: string; images?: ProductImage[] }
}

export interface ProductVariant {
  id?: string
  name: string
  cost: number
  price: number
  /**
   * Existencia de la variante en la sucursal en contexto (o la suma de todas
   * cuando no hay ninguna seleccionada). El stock vive por sucursal+variante,
   * no en el producto.
   */
  stock: number
  /**
   * La variante default es la línea implícita "el producto en sí": no tiene
   * nombre y es la que lleva el stock de los productos que nunca se dividieron
   * en variantes con nombre. La UI no la lista como una opción más.
   */
  isDefault?: boolean
  trackInventory?: boolean
  lowStockAlert?: number | null
  stockByBranch?: { branchId: string; stock: number }[]
}

export interface ProductFeature {
  id?: string
  feature: string
  value: string
}

export interface ImportRowError {
  row: number
  sku?: string
  message: string
}

export interface ImportResult {
  totalRows: number
  created: number
  updated: number
  errors: ImportRowError[]
}

export interface Product {
  id?: string
  type: ProductType
  sku: string
  name: string
  description: string
  price: number
  comparePrice: number
  costPrice: number
  categoryId: string
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED'
  stock: number
  trackInventory: boolean
  lowStockAlert: number
  metaTitle: string
  metaDescription: string
  taxRate: number
  taxCode: string
  slug: string
  isEcommerce: boolean
  images?: ProductImage[]
  category?: { id: string; name: string } | null
  recipe?: { id: string; notes?: string; items: RecipeItem[] } | null
  comboItems?: ComboItem[]
  variants?: ProductVariant[]
  features?: ProductFeature[]
  /** Presente cuando el producto viene de un borrador del AI Product Assistant — ver §07. */
  aiRequestId?: string
  aiOutcome?: 'ACCEPTED' | 'EDITED'
}

export async function fetchProducts(params?: { page?: number; limit?: number }): Promise<ListResponse<Product>> {
  const { data } = await api.get<ListResponse<Product>>('products', { params })
  return data
}

/** Trae todo el catálogo del tenant, sin importar cuántas páginas requiera el API. */
export async function fetchAllProducts(): Promise<Product[]> {
  const first = await fetchProducts({ page: 1, limit: 500 })
  const totalPages = first?.meta?.totalPages || 1
  if (totalPages <= 1) return first?.data || []

  const rest = await Promise.all(
    Array.from({ length: totalPages - 1 }, (_, i) => fetchProducts({ page: i + 2, limit: 500 }))
  )
  return [...(first?.data || []), ...rest.flatMap((r) => r?.data || [])]
}

export async function createProduct(data: Product): Promise<Product> {
  const body = {
    type: data.type,
    sku: data.sku,
    name: data.name,
    description: data.description,
    price: data.price,
    comparePrice: data.comparePrice,
    costPrice: data.costPrice,
    categoryId: data.categoryId,
    status: data.status,
    stock: data.stock,
    trackInventory: data.trackInventory,
    lowStockAlert: data.lowStockAlert,
    metaTitle: data.metaTitle,
    metaDescription: data.metaDescription,
    taxRate: data.taxRate,
    taxCode: data.taxCode,
    isEcommerce: data.isEcommerce,
    recipeItems: data.recipe?.items?.map((i) => ({
      supplyId: i.supplyId,
      quantity: i.quantity,
      unit: i.unit,
      unitId: i.unitId ?? undefined,
    })),
    comboItems: data.comboItems?.map((ci) => ({
      childProductId: ci.childProductId,
      quantity: ci.quantity,
    })),
    // Se conserva el `id`: sin él el backend no puede distinguir una variante
    // existente de una nueva, y al guardar reemplazaría el juego completo —
    // llevándose por delante las existencias de todas las sucursales.
    variants: data.variants
      ?.filter((v) => !v.isDefault && v.name.trim() !== '')
      .map((v) => ({ id: v.id, name: v.name, cost: v.cost, price: v.price, stock: v.stock })),
    features: data.features
      ?.filter((f) => f.feature.trim() !== '' && f.value.trim() !== '')
      .map((f) => ({ feature: f.feature, value: f.value })),
    aiRequestId: data.aiRequestId,
    aiOutcome: data.aiRequestId ? (data.aiOutcome ?? 'ACCEPTED') : undefined,
  }
  const { data: result } = await api.post<Product>('products', body)
  return result
}

export async function updateProduct(id: string, data: Product): Promise<Product> {
  const body = {
    type: data.type,
    name: data.name,
    description: data.description,
    price: data.price,
    comparePrice: data.comparePrice,
    costPrice: data.costPrice,
    categoryId: data.categoryId,
    status: data.status,
    // `stock` NO viaja en el PATCH: el backend lo rechaza. Escribirlo solo movía
    // la columna espejo `products.stock` sin tocar las existencias por sucursal,
    // de las que se lee — el usuario cambiaba el número y no pasaba nada. La
    // existencia se ajusta por `PATCH products/:id/stock`, que deja movimiento.
    trackInventory: data.trackInventory,
    lowStockAlert: data.lowStockAlert,
    metaTitle: data.metaTitle,
    metaDescription: data.metaDescription,
    taxRate: data.taxRate,
    taxCode: data.taxCode,
    isEcommerce: data.isEcommerce,
    recipeItems: data.recipe?.items?.map((i) => ({
      supplyId: i.supplyId,
      quantity: i.quantity,
      unit: i.unit,
      unitId: i.unitId ?? undefined,
    })),
    comboItems: data.comboItems?.map((ci) => ({
      childProductId: ci.childProductId,
      quantity: ci.quantity,
    })),
    // Se conserva el `id`: sin él el backend no puede distinguir una variante
    // existente de una nueva, y al guardar reemplazaría el juego completo —
    // llevándose por delante las existencias de todas las sucursales.
    variants: data.variants
      ?.filter((v) => !v.isDefault && v.name.trim() !== '')
      .map((v) => ({ id: v.id, name: v.name, cost: v.cost, price: v.price, stock: v.stock })),
    features: data.features
      ?.filter((f) => f.feature.trim() !== '' && f.value.trim() !== '')
      .map((f) => ({ feature: f.feature, value: f.value })),
  }
  const { data: result } = await api.patch<Product>(`products/${id}`, body)
  return result
}

export async function deleteProduct(id: string): Promise<void> {
  await api.delete(`products/${id}`)
}

export async function uploadProductImage(productId: string, file: File): Promise<ProductImage> {
  const formData = new FormData()
  formData.append('file', file)
  const { data } = await api.post<ProductImage>(`products/${productId}/image`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return data
}

export async function deleteProductImage(productId: string, imageId: string): Promise<void> {
  await api.delete(`products/${productId}/images/${imageId}`)
}

export async function downloadProductImportTemplate(): Promise<void> {
  const res = await api.get('products/import/template', { responseType: 'blob' })
  const url = URL.createObjectURL(res.data as Blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'plantilla-productos.xlsx'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export async function importProductsFromExcel(file: File): Promise<ImportResult> {
  const formData = new FormData()
  formData.append('file', file)
  const { data } = await api.post<ImportResult>('products/import', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return data
}
