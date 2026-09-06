import { useRef, useState, useEffect, useMemo, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { FormField } from '@/components/shared/form-modal'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { STATUS_OPTIONS, TAX_CODES, TAX_RATE_MAP, PRODUCT_TYPE_OPTIONS } from '@/hooks/retail/use-products'
import type { Product, RecipeItem, ComboItem, ProductVariant, ProductFeature } from '@/services/retail/product-service'
import type { Category } from '@/services/retail/categories-service'
import { uploadProductImage, deleteProductImage } from '@/services/retail/product-service'
import { ImageViewer } from '@/components/shared/image-viewer'
import { fetchSupplies, type Supply } from '@/services/retail/supplies-service'
import { fetchAllProducts } from '@/services/retail/product-service'
import { useTenantFeatures } from '@/hooks/use-tenant-features'
import { useAuthStore } from '@/store/auth-store'
import { Trash2, Plus, Tag, CircleDollarSign, Boxes, Megaphone, ImageIcon, Check, ChevronLeft, ChevronRight } from 'lucide-react'

export interface ProductFormModalProps {
  open: boolean
  onClose: () => void
  editingId: string | null
  form: Product
  setForm: Dispatch<SetStateAction<Product>>
  onSave: () => void
  onImageChange?: () => void
  categories: Category[]
}

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const MAX_SIZE = 5 * 1024 * 1024

function IconImage() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground/40">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  )
}

function IconUpload() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  )
}

function IconEye() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function IconDownload() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}

function IconRefresh() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M23 4v6h-6" />
      <path d="M1 20v-6h6" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  )
}

function IconTrash() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  )
}

function IconSpinner() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="animate-spin">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  )
}

// ── Recipe Editor ────────────────────────────────────────────────────────────

function RecipeEditor({
  items,
  onChange,
  onCostChange,
}: {
  items: RecipeItem[]
  onChange: (items: RecipeItem[]) => void
  onCostChange?: (cost: number) => void
}) {
  const [supplies, setSupplies] = useState<Supply[]>([])

  useEffect(() => {
    fetchSupplies()
      .then((r) => setSupplies((r.data || []).filter((s) => s.status === 'ACTIVE')))
      .catch(() => {})
  }, [])

  const addItem = () =>
    onChange([...items, { supplyId: '', quantity: 1, unit: '', unitId: null }])

  const removeItem = (idx: number) =>
    onChange(items.filter((_, i) => i !== idx))

  const updateItem = (idx: number, patch: Partial<RecipeItem>) => {
    onChange(
      items.map((item, i) => {
        if (i !== idx) return item
        const updated = { ...item, ...patch }

        // When supply changes, reset unit to inventoryUnit
        if ('supplyId' in patch) {
          const s = supplies.find((x) => x.id === patch.supplyId)
          if (s) {
            updated.unitId = s.inventoryUnitId ?? null
            updated.unit = s.inventoryUnit?.symbol ?? s.unit
          } else {
            updated.unitId = null
            updated.unit = ''
          }
        }

        // Recompute normalizedQuantity
        const s = supplies.find((x) => x.id === updated.supplyId)
        if (s && updated.unitId) {
          const cf = Number(s.conversionFactor ?? 1) || 1
          if (updated.unitId === s.inventoryUnitId) {
            updated.normalizedQuantity = updated.quantity * cf
          } else if (updated.unitId === s.baseUnitId) {
            updated.normalizedQuantity = updated.quantity
          }
        }

        return updated
      }),
    )
  }

  const totalCost = useMemo(() => {
    return items.reduce((sum, item) => {
      const s = supplies.find((x) => x.id === item.supplyId)
      if (!s || !item.quantity) return sum
      const cost = Number(s.cost) || 0
      const cf = Number(s.conversionFactor ?? 1) || 1
      if (!s.inventoryUnitId || !item.unitId || item.unitId === s.inventoryUnitId) {
        return sum + item.quantity * cost
      }
      if (item.unitId === s.baseUnitId) {
        return sum + (item.quantity / cf) * cost
      }
      return sum + item.quantity * cost
    }, 0)
  }, [items, supplies])

  useEffect(() => {
    onCostChange?.(totalCost)
  }, [totalCost, onCostChange])

  return (
    <div className="col-span-2 mb-3.5">
      <div className="flex items-center justify-between mb-2">
        <label className="text-xs font-semibold text-muted-foreground">Ingredientes / Insumos</label>
        <button
          type="button"
          onClick={addItem}
          className="flex items-center gap-1 px-2 py-1 text-[11px] bg-primary/10 text-primary rounded-md hover:bg-primary/20 transition-colors cursor-pointer"
        >
          <Plus className="w-3 h-3" /> Agregar
        </button>
      </div>

      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-4 border border-dashed border-border rounded-lg">
          Sin ingredientes. Agrega al menos uno.
        </p>
      ) : (
        <>
          {/* Column headers */}
          <div className="grid grid-cols-[1fr_7.5rem_5.5rem_5rem_1.75rem] gap-1.5 px-1 mb-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Insumo</span>
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Unidad</span>
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Cantidad</span>
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground text-right">Subtotal</span>
            <span />
          </div>

          <div className="space-y-1.5">
            {items.map((item, idx) => {
              const s = supplies.find((x) => x.id === item.supplyId)
              const cf = Number(s?.conversionFactor ?? 1) || 1
              const hasTwoUnits =
                s?.inventoryUnitId && s?.baseUnitId && s.inventoryUnitId !== s.baseUnitId

              // Unit options: only units valid for this supply
              const unitOptions = s
                ? ([
                    s.inventoryUnitId
                      ? {
                          id: s.inventoryUnitId,
                          symbol: s.inventoryUnit?.symbol ?? s.unit,
                          label: s.inventoryUnit
                            ? `${s.inventoryUnit.name} (${s.inventoryUnit.symbol})`
                            : s.unit,
                        }
                      : null,
                    s.baseUnitId && s.baseUnitId !== s.inventoryUnitId
                      ? {
                          id: s.baseUnitId,
                          symbol: s.baseUnit?.symbol ?? '',
                          label: s.baseUnit
                            ? `${s.baseUnit.name} (${s.baseUnit.symbol})`
                            : '',
                        }
                      : null,
                  ] as const).filter((x): x is NonNullable<typeof x> => x !== null)
                : []

              // Conversion preview
              let conversionText = ''
              if (hasTwoUnits && item.quantity > 0 && item.unitId && s) {
                const invSym = s.inventoryUnit?.symbol ?? s.unit
                const baseSym = s.baseUnit?.symbol ?? s.unit
                if (item.unitId === s.inventoryUnitId) {
                  const bq = item.quantity * cf
                  conversionText = `= ${bq.toLocaleString('es-MX', { maximumFractionDigits: 3 })} ${baseSym}`
                } else if (item.unitId === s.baseUnitId) {
                  const iq = item.quantity / cf
                  conversionText = `= ${iq.toLocaleString('es-MX', { maximumFractionDigits: 3 })} ${invSym}`
                }
              }

              // Per-ingredient cost subtotal
              const cost = Number(s?.cost) || 0
              let subtotal = 0
              if (s && item.quantity > 0) {
                if (!s.inventoryUnitId || !item.unitId || item.unitId === s.inventoryUnitId) {
                  subtotal = item.quantity * cost
                } else if (item.unitId === s.baseUnitId) {
                  subtotal = (item.quantity / cf) * cost
                } else {
                  subtotal = item.quantity * cost
                }
              }

              return (
                <div key={idx} className="rounded-lg border border-border bg-card/50 p-2 space-y-1">
                  <div className="grid grid-cols-[1fr_7.5rem_5.5rem_5rem_1.75rem] gap-1.5 items-center">
                    {/* Supply */}
                    <select
                      value={item.supplyId}
                      onChange={(e) => updateItem(idx, { supplyId: e.target.value })}
                      className="w-full px-2 py-1.5 border border-border rounded-md text-[12px] bg-card outline-none focus:border-primary"
                    >
                      <option value="">— Insumo —</option>
                      {supplies.map((sup) => (
                        <option key={sup.id} value={sup.id}>
                          {sup.name}
                        </option>
                      ))}
                    </select>

                    {/* Unit */}
                    {unitOptions.length > 1 ? (
                      <select
                        value={item.unitId ?? ''}
                        onChange={(e) => {
                          const opt = unitOptions.find((u) => u.id === e.target.value)
                          updateItem(idx, { unitId: e.target.value, unit: opt?.symbol ?? '' })
                        }}
                        className="w-full px-2 py-1.5 border border-border rounded-md text-[12px] bg-card outline-none focus:border-primary"
                      >
                        {unitOptions.map((u) => (
                          <option key={u.id} value={u.id}>{u.label}</option>
                        ))}
                      </select>
                    ) : (
                      <span className="px-2 py-1.5 text-[12px] text-muted-foreground bg-muted/30 rounded-md border border-border text-center block">
                        {s?.inventoryUnit?.symbol ?? s?.unit ?? item.unit ?? '—'}
                      </span>
                    )}

                    {/* Quantity */}
                    <input
                      type="number"
                      step="0.001"
                      min="0.001"
                      value={item.quantity}
                      onChange={(e) => updateItem(idx, { quantity: Number(e.target.value) || 0 })}
                      className="w-full px-2 py-1.5 border border-border rounded-md text-[12px] bg-card outline-none focus:border-primary text-right"
                    />

                    {/* Subtotal */}
                    <span className="text-[12px] text-right font-medium text-foreground shrink-0">
                      {subtotal > 0
                        ? subtotal.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })
                        : '—'}
                    </span>

                    {/* Delete */}
                    <button
                      type="button"
                      onClick={() => removeItem(idx)}
                      className="p-1 text-muted-foreground hover:text-destructive transition-colors flex items-center justify-center"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* Conversion preview */}
                  {conversionText && (
                    <p className="text-[11px] text-blue-600 dark:text-blue-400 pl-1 font-medium">
                      {conversionText}
                    </p>
                  )}
                </div>
              )
            })}
          </div>

          {/* Recipe total cost */}
          <div className="flex items-center justify-between mt-3 pt-2.5 border-t border-border">
            <span className="text-[12px] font-semibold text-muted-foreground">Costo total receta</span>
            <span className="text-[14px] font-bold text-foreground">
              {totalCost.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })}
            </span>
          </div>
        </>
      )}
    </div>
  )
}

// ── Combo Editor ─────────────────────────────────────────────────────────────

function ComboEditor({
  items,
  currentProductId,
  onChange,
  onCostChange,
}: {
  items: ComboItem[]
  currentProductId: string | null
  onChange: (items: ComboItem[]) => void
  onCostChange?: (cost: number) => void
}) {
  const [products, setProducts] = useState<Product[]>([])

  useEffect(() => {
    fetchAllProducts().then(setProducts).catch(() => {})
  }, [])

  const eligible = products.filter((p) => p.id !== currentProductId)

  const totalCost = useMemo(() => {
    return items.reduce((sum, item) => {
      const p = products.find((x) => x.id === item.childProductId)
      if (!p || !item.quantity) return sum
      return sum + Number(p.costPrice) * item.quantity
    }, 0)
  }, [items, products])

  useEffect(() => {
    onCostChange?.(totalCost)
  }, [totalCost, onCostChange])

  const addItem = () =>
    onChange([...items, { childProductId: '', quantity: 1 }])

  const removeItem = (idx: number) =>
    onChange(items.filter((_, i) => i !== idx))

  const updateItem = (idx: number, patch: Partial<ComboItem>) =>
    onChange(items.map((item, i) => (i !== idx ? item : { ...item, ...patch })))

  return (
    <div className="col-span-2 mb-3.5">
      <div className="flex items-center justify-between mb-2">
        <label className="text-xs font-semibold text-muted-foreground">Productos del Combo</label>
        <button
          type="button"
          onClick={addItem}
          className="flex items-center gap-1 px-2 py-1 text-[11px] bg-primary/10 text-primary rounded-md hover:bg-primary/20 transition-colors cursor-pointer"
        >
          <Plus className="w-3 h-3" /> Agregar
        </button>
      </div>

      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-3 border border-dashed border-border rounded-lg">
          Sin productos. Agrega al menos uno.
        </p>
      ) : (
        <>
          {/* Column headers */}
          <div className="grid grid-cols-[1fr_5rem_5rem_1.75rem] gap-1.5 px-1 mb-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Producto</span>
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Cantidad</span>
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground text-right">Subtotal</span>
            <span />
          </div>

          <div className="space-y-1.5">
            {items.map((item, idx) => {
              const p = products.find((x) => x.id === item.childProductId)
              const subtotal = p ? Number(p.costPrice) * item.quantity : 0
              return (
                <div key={idx} className="rounded-lg border border-border bg-card/50 p-2">
                  <div className="grid grid-cols-[1fr_5rem_5rem_1.75rem] gap-1.5 items-center">
                    <select
                      value={item.childProductId}
                      onChange={(e) => updateItem(idx, { childProductId: e.target.value })}
                      className="w-full px-2 py-1.5 border border-border rounded-md text-[12px] bg-card outline-none focus:border-primary"
                    >
                      <option value="">— Producto —</option>
                      {eligible.map((prod) => (
                        <option key={prod.id} value={prod.id}>
                          {prod.name} ({prod.sku}) [{prod.type}]
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={item.quantity}
                      onChange={(e) => updateItem(idx, { quantity: Number(e.target.value) || 1 })}
                      className="w-full px-2 py-1.5 border border-border rounded-md text-[12px] bg-card outline-none focus:border-primary text-right"
                    />
                    <span className="text-[12px] text-right font-medium text-foreground">
                      {subtotal > 0
                        ? subtotal.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })
                        : '—'}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeItem(idx)}
                      className="p-1 text-muted-foreground hover:text-destructive transition-colors flex items-center justify-center"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>

          {/* Total */}
          <div className="flex items-center justify-between mt-3 pt-2.5 border-t border-border">
            <span className="text-[12px] font-semibold text-muted-foreground">Costo total combo</span>
            <span className="text-[14px] font-bold text-foreground">
              {totalCost.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })}
            </span>
          </div>
        </>
      )}
    </div>
  )
}

// ── Variants Editor (variantes ligadas al producto: nombre + costo + precio) ─

function VariantsEditor({
  items,
  onChange,
}: {
  items: ProductVariant[]
  onChange: (items: ProductVariant[]) => void
}) {
  const addItem = () => onChange([...items, { name: '', cost: 0, price: 0, stock: 0 }])

  const removeItem = (idx: number) => onChange(items.filter((_, i) => i !== idx))

  const updateItem = (idx: number, patch: Partial<ProductVariant>) =>
    onChange(items.map((item, i) => (i !== idx ? item : { ...item, ...patch })))

  return (
    <div className="col-span-2 mb-3.5">
      <div className="flex items-center justify-between mb-2">
        <label className="text-xs font-semibold text-muted-foreground">Variantes (talla, color, tipo...)</label>
        <button
          type="button"
          onClick={addItem}
          className="flex items-center gap-1 px-2 py-1 text-[11px] bg-primary/10 text-primary rounded-md hover:bg-primary/20 transition-colors cursor-pointer"
        >
          <Plus className="w-3 h-3" /> Agregar
        </button>
      </div>

      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-4 border border-dashed border-border rounded-lg">
          Sin variantes. Agrega una si este producto se vende en varias presentaciones con
          existencia, costo y precio propios.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-[1fr_5rem_6rem_6rem_1.75rem] gap-1.5 px-1 mb-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Nombre</span>
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground text-right">Stock</span>
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground text-right">Costo</span>
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground text-right">Precio</span>
            <span />
          </div>

          <div className="space-y-1.5">
            {items.map((item, idx) => (
              <div key={item.id ?? idx} className="grid grid-cols-[1fr_5rem_6rem_6rem_1.75rem] gap-1.5 items-center">
                <input
                  type="text"
                  placeholder="Ej. Talla M"
                  value={item.name}
                  onChange={(e) => updateItem(idx, { name: e.target.value })}
                  className="w-full px-2 py-1.5 border border-border rounded-md text-[12px] bg-card outline-none focus:border-primary"
                />
                {/* La existencia solo se captura al ALTA de la variante. En una
                    variante que ya existe (trae `id`) el backend la ignora a
                    propósito: el stock se mueve por movimientos de inventario,
                    no por guardar el formulario. Se muestra en solo lectura en
                    vez de aceptar un número que nunca se aplicaba. */}
                <input
                  type="number"
                  step="1"
                  min="0"
                  value={item.stock}
                  readOnly={Boolean(item.id)}
                  title={item.id ? 'Se ajusta desde Inventario, para que quede el movimiento' : undefined}
                  onChange={(e) => updateItem(idx, { stock: Number(e.target.value) || 0 })}
                  className={`w-full px-2 py-1.5 border border-border rounded-md text-[12px] outline-none focus:border-primary text-right ${
                    item.id ? 'bg-muted text-muted-foreground cursor-not-allowed' : 'bg-card'
                  }`}
                />
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={item.cost}
                  onChange={(e) => updateItem(idx, { cost: Number(e.target.value) || 0 })}
                  className="w-full px-2 py-1.5 border border-border rounded-md text-[12px] bg-card outline-none focus:border-primary text-right"
                />
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={item.price}
                  onChange={(e) => updateItem(idx, { price: Number(e.target.value) || 0 })}
                  className="w-full px-2 py-1.5 border border-border rounded-md text-[12px] bg-card outline-none focus:border-primary text-right"
                />
                <button
                  type="button"
                  onClick={() => removeItem(idx)}
                  className="p-1 text-muted-foreground hover:text-destructive transition-colors flex items-center justify-center"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>

          <p className="text-[11px] text-muted-foreground mt-2">
            La existencia de cada variante corresponde a la sucursal seleccionada.
          </p>
        </>
      )}
    </div>
  )
}

// ── Features Editor (ficha técnica opcional: característica + valor) ───────────

function FeaturesEditor({
  items,
  onChange,
}: {
  items: ProductFeature[]
  onChange: (items: ProductFeature[]) => void
}) {
  const addItem = () => onChange([...items, { feature: '', value: '' }])

  const removeItem = (idx: number) => onChange(items.filter((_, i) => i !== idx))

  const updateItem = (idx: number, patch: Partial<ProductFeature>) =>
    onChange(items.map((item, i) => (i !== idx ? item : { ...item, ...patch })))

  return (
    <div className="col-span-2 mb-3.5">
      <div className="flex items-center justify-between mb-2">
        <label className="text-xs font-semibold text-muted-foreground">Ficha técnica (opcional)</label>
        <button
          type="button"
          onClick={addItem}
          className="flex items-center gap-1 px-2 py-1 text-[11px] bg-primary/10 text-primary rounded-md hover:bg-primary/20 transition-colors cursor-pointer"
        >
          <Plus className="w-3 h-3" /> Agregar
        </button>
      </div>

      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-4 border border-dashed border-border rounded-lg">
          Sin características. Agrega una si quieres documentar especificaciones (material, peso, origen...).
        </p>
      ) : (
        <>
          <div className="grid grid-cols-[1fr_1fr_1.75rem] gap-1.5 px-1 mb-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Característica</span>
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Valor</span>
            <span />
          </div>

          <div className="space-y-1.5">
            {items.map((item, idx) => (
              <div key={idx} className="grid grid-cols-[1fr_1fr_1.75rem] gap-1.5 items-center">
                <input
                  type="text"
                  placeholder="Ej. Material"
                  value={item.feature}
                  onChange={(e) => updateItem(idx, { feature: e.target.value })}
                  className="w-full px-2 py-1.5 border border-border rounded-md text-[12px] bg-card outline-none focus:border-primary"
                />
                <input
                  type="text"
                  placeholder="Ej. Algodón"
                  value={item.value}
                  onChange={(e) => updateItem(idx, { value: e.target.value })}
                  className="w-full px-2 py-1.5 border border-border rounded-md text-[12px] bg-card outline-none focus:border-primary"
                />
                <button
                  type="button"
                  onClick={() => removeItem(idx)}
                  className="p-1 text-muted-foreground hover:text-destructive transition-colors flex items-center justify-center"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ── Wizard step rail ─────────────────────────────────────────────────────────
// Pasos libres (no bloqueados): esto es un formulario de edición, no un
// onboarding — el usuario puede saltar a cualquier paso y guardar desde
// cualquiera. El punto ámbar solo señala "falta algo aquí", nunca bloquea.

interface WizardStep {
  id: string
  label: string
  hint: string
  icon: typeof Tag
  incomplete?: boolean
}

function StepRail({
  steps,
  activeStep,
  onSelect,
}: {
  steps: WizardStep[]
  activeStep: number
  onSelect: (idx: number) => void
}) {
  return (
    <nav className="flex md:flex-col gap-1 overflow-x-auto md:overflow-visible px-1 md:px-0 -mx-1 md:mx-0 pb-0.5 md:pb-0">
      {steps.map((step, idx) => {
        const isActive = idx === activeStep
        const Icon = step.icon
        return (
          <button
            key={step.id}
            type="button"
            onClick={() => onSelect(idx)}
            className={`group relative flex items-center gap-2.5 shrink-0 md:w-full text-left px-3 py-2.5 rounded-lg transition-colors cursor-pointer ${
              isActive
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
            }`}
          >
            <span
              className={`flex items-center justify-center w-7 h-7 rounded-md shrink-0 transition-colors ${
                isActive ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground/70'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
            </span>
            <span className="min-w-0 hidden sm:block">
              <span className="block text-[12.5px] font-semibold leading-tight whitespace-nowrap md:whitespace-normal">
                {step.label}
              </span>
              <span className="hidden md:block text-[10.5px] text-muted-foreground/70 leading-tight mt-0.5">
                {step.hint}
              </span>
            </span>
            {step.incomplete && (
              <span
                className="absolute top-1.5 right-1.5 md:static md:ml-auto w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0"
                title="Falta información en este paso"
              />
            )}
          </button>
        )
      })}
    </nav>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function ProductFormModal({
  open,
  onClose,
  editingId,
  form,
  setForm,
  onSave,
  onImageChange,
  categories,
}: ProductFormModalProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [viewerOpen, setViewerOpen] = useState(false)
  const [hovered, setHovered] = useState(false)

  const primaryImage = form.images?.find(img => img.isPrimary) ?? form.images?.[0]
  const productType = form.type ?? 'SIMPLE'
  const showStock = productType === 'SIMPLE'
  const showRecipe = productType === 'RECIPE'
  const showCombo = productType === 'COMBO'

  // El campo "Stock" es la existencia del producto "sin variante" (la default).
  // En cuanto hay variantes con nombre deja de tener sentido: lo que se vende y
  // se inventaría son ellas, y capturar aquí un número aparte creaba existencia
  // fantasma que no pertenecía a ninguna opción comprable.
  const hasNamedVariants = (form.variants?.length ?? 0) > 0
  // Al editar, la existencia solo se mueve por el flujo de ajuste, que deja su
  // InventoryMovement. El backend ya ignoraba este campo en el PATCH; ahora
  // además lo rechaza, así que aquí se muestra en modo lectura en vez de
  // ofrecer una edición que nunca se aplicaba.
  const stockIsReadOnly = editingId !== null

  // Tipos de producto disponibles según la configuración del negocio:
  // - RECIPE: solo si la capacidad enableRecipes está activa (derivada del
  //   business profile; el backend también lo bloquea vía enableRecipes).
  // - SERVICE: solo si el módulo 'servicios' está habilitado para el tenant.
  // Siempre se conserva el tipo actual para no romper la edición de un producto
  // existente cuyo tipo ya no esté disponible.
  const { hasBusinessFeature } = useTenantFeatures()
  const enabledModules = useAuthStore(s => s.enabledModules)
  const availableTypeOptions = useMemo(
    () =>
      PRODUCT_TYPE_OPTIONS.filter(o => {
        if (o.value === productType) return true
        if (o.value === 'RECIPE') return hasBusinessFeature('enableRecipes')
        if (o.value === 'SERVICE') return enabledModules.includes('servicios')
        return true
      }),
    [productType, hasBusinessFeature, enabledModules],
  )

  // ── Wizard ──────────────────────────────────────────────────────────────
  // Reinicia siempre en "General" al abrir — evita quedarse en un paso
  // intermedio de una edición anterior cuando se abre un producto distinto.
  const [activeStep, setActiveStep] = useState(0)
  useEffect(() => {
    if (open) setActiveStep(0)
  }, [open, editingId])

  const structureLabel = showRecipe ? 'Receta' : showCombo ? 'Combo' : productType === 'SERVICE' ? 'Servicio' : 'Inventario'

  const steps: WizardStep[] = useMemo(
    () => [
      {
        id: 'general',
        label: 'General',
        hint: 'Tipo, nombre y categoría',
        icon: Tag,
        incomplete: !form.name?.trim(),
      },
      {
        id: 'precios',
        label: 'Precios',
        hint: 'Venta, costo e impuesto',
        icon: CircleDollarSign,
        incomplete: !(Number(form.price) > 0),
      },
      {
        id: 'estructura',
        label: structureLabel,
        hint: showRecipe ? 'Ingredientes y costo' : showCombo ? 'Productos incluidos' : 'Existencia y variantes',
        icon: Boxes,
        incomplete: showRecipe
          ? (form.recipe?.items?.length ?? 0) === 0
          : showCombo
            ? (form.comboItems?.length ?? 0) === 0
            : false,
      },
      {
        id: 'publicacion',
        label: 'Publicación y SEO',
        hint: 'Tienda en línea, ficha técnica',
        icon: Megaphone,
      },
      {
        id: 'imagen',
        label: 'Imagen',
        hint: editingId ? 'Foto del producto' : 'Disponible al guardar',
        icon: ImageIcon,
      },
    ],
    [form.name, form.price, form.recipe, form.comboItems, showRecipe, showCombo, structureLabel, editingId],
  )

  const isLastStep = activeStep === steps.length - 1
  const isFirstStep = activeStep === 0

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !editingId) return

    setUploadError(null)

    if (!ACCEPTED_TYPES.includes(file.type)) {
      setUploadError('Formato no permitido. Usa PNG, JPG o WebP.')
      return
    }
    if (file.size > MAX_SIZE) {
      setUploadError('La imagen supera 5 MB.')
      return
    }

    setUploading(true)
    try {
      const newImage = await uploadProductImage(editingId, file)
      setForm(p => ({ ...p, images: [newImage] }))
      onImageChange?.()
    } catch {
      setUploadError('Error al subir la imagen. Intenta de nuevo.')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function handleRemoveImage() {
    if (!editingId || !primaryImage) return
    setUploadError(null)
    setUploading(true)
    try {
      await deleteProductImage(editingId, primaryImage.id)
      setForm(p => ({
        ...p,
        images: p.images?.filter(img => img.id !== primaryImage.id) ?? [],
      }))
      onImageChange?.()
    } catch {
      setUploadError('Error al eliminar la imagen.')
    } finally {
      setUploading(false)
    }
  }

  async function handleDownload() {
    if (!primaryImage) return
    try {
      const res = await fetch(primaryImage.url)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const ext = blob.type.split('/')[1] || 'jpg'
      a.download = `${(form.name || 'producto').replace(/\s+/g, '-').toLowerCase()}.${ext}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch {
      window.open(primaryImage.url, '_blank')
    }
  }

  // ── Contenido de cada paso ────────────────────────────────────────────────

  let stepContent: ReactNode

  if (steps[activeStep].id === 'general') {
    stepContent = (
      <div className="grid grid-cols-2 gap-x-4">
        <div className="col-span-2 mb-3.5">
          <label className="block text-xs font-semibold text-muted-foreground mb-1.5">Tipo de producto</label>
          <Select value={productType} onValueChange={(v) => setForm((p) => ({ ...p, type: v as Product['type'] }))}>
            <SelectTrigger size="sm" className="w-full">
              <SelectValue>{PRODUCT_TYPE_OPTIONS.find((o) => o.value === productType)?.label ?? productType}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {availableTypeOptions.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {!editingId && (
          <FormField label="SKU" value={form.sku} onChange={v => setForm(p => ({ ...p, sku: v }))} />
        )}
        <div className={`mb-3.5${editingId ? ' col-span-2' : ''}`}>
          <label className="block text-xs font-semibold text-muted-foreground mb-1.5">Categoría</label>
          <select
            value={form.categoryId}
            onChange={e => setForm(p => ({ ...p, categoryId: e.target.value }))}
            className="w-full px-2.5 py-2 border border-border rounded-lg text-[13px] text-foreground bg-card outline-none focus:border-primary"
          >
            <option value="">— Sin categoría —</option>
            {categories.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div className="col-span-2">
          <FormField label="Nombre" value={form.name} onChange={v => setForm(p => ({ ...p, name: v }))} />
        </div>
        <div className="col-span-2">
          <FormField label="Descripción" value={form.description} onChange={v => setForm(p => ({ ...p, description: v }))} />
        </div>
        <div className="mb-3.5">
          <label className="block text-xs font-semibold text-muted-foreground mb-1.5">Estado</label>
          <Select value={form.status} onValueChange={v => setForm(p => ({ ...p, status: v as 'DRAFT' | 'ACTIVE' | 'ARCHIVED' }))}>
            <SelectTrigger size="sm" className="w-full">
              <SelectValue>{STATUS_OPTIONS.find(o => o.value === form.status)?.label ?? form.status}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {!editingId && (
          <FormField label="Slug" value={form.slug} onChange={v => setForm(p => ({ ...p, slug: v }))} />
        )}
      </div>
    )
  } else if (steps[activeStep].id === 'precios') {
    stepContent = (
      <div className="grid grid-cols-2 gap-x-4">
        <FormField label="Precio" type="number" value={form.price.toString()} onChange={v => setForm(p => ({ ...p, price: Number(v) || 0 }))} />
        <FormField label="Precio Compare" type="number" value={Number(form.comparePrice).toString()} onChange={v => setForm(p => ({ ...p, comparePrice: Number(v) || 0 }))} />
        <FormField label="Costo" type="number" value={Number(form.costPrice).toString()} onChange={v => setForm(p => ({ ...p, costPrice: Number(v) || 0 }))} />
        <div className="mb-3.5">
          <label className="block text-xs font-semibold text-muted-foreground mb-1.5">Código Impuesto</label>
          <Select
            value={form.taxCode}
            onValueChange={v => setForm(p => ({
              ...p,
              taxCode: v ?? p.taxCode,
              taxRate: (v ? TAX_RATE_MAP[v] : undefined) ?? p.taxRate,
            }))}
          >
            <SelectTrigger size="sm" className="w-full">
              <SelectValue>{TAX_CODES.find(t => t.value === form.taxCode)?.label ?? form.taxCode}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {TAX_CODES.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {/* Análisis de precio — visible siempre que haya costo y precio, no
            solo en receta: también ayuda en SIMPLE/COMBO a ver el margen. */}
        {Number(form.costPrice) > 0 && Number(form.price) > 0 && (() => {
          const costVal = Number(form.costPrice)
          const priceVal = Number(form.price)
          const margin = ((priceVal - costVal) / costVal) * 100
          return (
            <div className="col-span-2 mt-1 rounded-lg border border-border bg-muted/20 p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-2.5">
                Análisis de precio
              </div>
              <div className="flex items-center justify-around gap-2">
                <div className="text-center">
                  <div className="text-[10px] text-muted-foreground mb-0.5">Costo</div>
                  <div className="text-[13px] font-semibold">
                    {costVal.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })}
                  </div>
                </div>
                <span className="text-muted-foreground text-[11px]">→</span>
                <div className="text-center">
                  <div className="text-[10px] text-muted-foreground mb-0.5">Precio venta</div>
                  <div className="text-[13px] font-semibold">
                    {priceVal.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })}
                  </div>
                </div>
                <span className="text-muted-foreground text-[11px]">→</span>
                <div className="text-center">
                  <div className="text-[10px] text-muted-foreground mb-0.5">Margen</div>
                  <div className={`text-[15px] font-bold ${margin >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                    {margin >= 0 ? '+' : ''}{margin.toFixed(1)}%
                  </div>
                </div>
              </div>
            </div>
          )
        })()}
      </div>
    )
  } else if (steps[activeStep].id === 'estructura') {
    stepContent = (
      <div className="grid grid-cols-2 gap-x-4">
        {productType === 'SERVICE' && (
          <div className="col-span-2 mb-3.5 p-3 rounded-lg bg-muted/30 border border-border">
            <p className="text-xs text-muted-foreground">
              Los servicios no manejan inventario directo. Solo se registra la venta.
            </p>
          </div>
        )}

        {(productType === 'RECIPE' || productType === 'COMBO') && (
          <div className="col-span-2 mb-3.5 p-3 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800">
            <p className="text-xs text-blue-700 dark:text-blue-300">
              {productType === 'RECIPE'
                ? 'Este producto consume insumos al venderse. No maneja stock propio.'
                : 'El combo agrupa productos vendibles. No maneja stock propio.'}
            </p>
          </div>
        )}

        {showRecipe && (
          <RecipeEditor
            items={form.recipe?.items ?? []}
            onChange={(items) =>
              setForm((p) => ({ ...p, recipe: { ...(p.recipe ?? { id: '', notes: undefined }), items } }))
            }
            onCostChange={(cost) => setForm((p) => ({ ...p, costPrice: cost }))}
          />
        )}

        {showCombo && (
          <ComboEditor
            items={form.comboItems ?? []}
            currentProductId={editingId}
            onChange={(items) => setForm((p) => ({ ...p, comboItems: items }))}
            onCostChange={(cost) => setForm((p) => ({ ...p, costPrice: cost }))}
          />
        )}

        {/* Stock — solo para SIMPLE. Es la existencia del producto "sin
            variante"; las variantes con nombre llevan la suya abajo, y en
            cuanto existe una este campo desaparece: lo inventariable son ellas. */}
        {showStock && (
          <>
            {!hasNamedVariants && (
              <FormField
                label="Stock"
                type="number"
                value={Number(form.stock).toString()}
                onChange={v => setForm(p => ({ ...p, stock: Number(v) || 0 }))}
                readOnly={stockIsReadOnly}
                hint={stockIsReadOnly ? 'Se ajusta desde Inventario, para que quede el movimiento' : undefined}
              />
            )}
            <FormField label="Stock Mínimo" type="number" value={form.lowStockAlert.toString()} onChange={v => setForm(p => ({ ...p, lowStockAlert: Number(v) || 0 }))} />
            <div className="col-span-2 flex items-center gap-2 mb-3.5">
              <input type="checkbox" id="trackInv" checked={form.trackInventory} onChange={e => setForm(p => ({ ...p, trackInventory: e.target.checked }))} />
              <label htmlFor="trackInv" className="text-xs text-muted-foreground cursor-pointer">Rastrear inventario</label>
            </div>
            {/* Las variantes ya no son exclusivas de e-commerce: cualquier
                producto con inventario puede venderse en varias presentaciones. */}
            <VariantsEditor
              items={form.variants ?? []}
              onChange={(items) => setForm(p => ({ ...p, variants: items }))}
            />
          </>
        )}
      </div>
    )
  } else if (steps[activeStep].id === 'publicacion') {
    stepContent = (
      <div className="grid grid-cols-2 gap-x-4">
        <div className="col-span-2 flex items-center gap-2 mb-3.5">
          <input
            type="checkbox"
            id="isEcommerce"
            checked={form.isEcommerce}
            onChange={e => setForm(p => ({ ...p, isEcommerce: e.target.checked }))}
          />
          <label htmlFor="isEcommerce" className="text-xs text-muted-foreground cursor-pointer">
            ¿Publicar este producto en la tienda en línea (e-commerce)?
          </label>
        </div>

        <div className="col-span-2">
          <FormField label="Meta Title" value={form.metaTitle} onChange={v => setForm(p => ({ ...p, metaTitle: v }))} />
        </div>
        <div className="col-span-2">
          <FormField label="Meta Description" value={form.metaDescription} onChange={v => setForm(p => ({ ...p, metaDescription: v }))} />
        </div>

        <FeaturesEditor
          items={form.features ?? []}
          onChange={(items) => setForm(p => ({ ...p, features: items }))}
        />
      </div>
    )
  } else {
    // 'imagen'
    stepContent = (
      <div className="max-w-sm mx-auto">
        {editingId ? (
          <div className="space-y-2">
            <div
              className="relative w-full rounded-xl overflow-hidden border border-border bg-muted/20"
              style={{ aspectRatio: '16/9' }}
              onMouseEnter={() => setHovered(true)}
              onMouseLeave={() => setHovered(false)}
            >
              {primaryImage ? (
                <>
                  <img
                    src={primaryImage.url}
                    alt={primaryImage.altText ?? form.name}
                    loading="lazy"
                    className="w-full h-full object-contain"
                    style={{ background: 'var(--muted)' }}
                  />
                  <div
                    className="absolute inset-0 flex flex-col items-center justify-center gap-2 transition-opacity duration-200"
                    style={{
                      background: 'rgba(0,0,0,0.52)',
                      opacity: hovered && !uploading ? 1 : 0,
                      pointerEvents: hovered && !uploading ? 'auto' : 'none',
                      backdropFilter: 'blur(2px)',
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={() => setViewerOpen(true)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 text-white text-xs font-medium transition-colors border border-white/20">
                        <IconEye /> Ver
                      </button>
                      <button type="button" onClick={handleDownload} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 text-white text-xs font-medium transition-colors border border-white/20">
                        <IconDownload /> Descargar
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={() => fileInputRef.current?.click()} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 text-white text-xs font-medium transition-colors border border-white/20">
                        <IconRefresh /> Reemplazar
                      </button>
                      <button type="button" onClick={handleRemoveImage} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-destructive/70 hover:bg-destructive/90 text-white text-xs font-medium transition-colors border border-destructive/40">
                        <IconTrash /> Eliminar
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <button type="button" disabled={uploading} onClick={() => fileInputRef.current?.click()} className="w-full h-full flex flex-col items-center justify-center gap-3 text-center cursor-pointer group disabled:cursor-not-allowed">
                  <div className="w-14 h-14 rounded-2xl bg-muted/60 border-2 border-dashed border-border group-hover:border-primary/50 group-hover:bg-primary/5 flex items-center justify-center transition-colors duration-200">
                    <IconImage />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-muted-foreground group-hover:text-foreground transition-colors">Subir imagen</p>
                    <p className="text-[11px] text-muted-foreground/60 mt-0.5">PNG, JPG, WebP · máx 5 MB</p>
                  </div>
                </button>
              )}
              {uploading && (
                <div className="absolute inset-0 flex items-center justify-center bg-background/70 backdrop-blur-sm rounded-xl">
                  <div className="flex flex-col items-center gap-2">
                    <IconSpinner />
                    <span className="text-xs text-muted-foreground">{primaryImage ? 'Procesando...' : 'Subiendo...'}</span>
                  </div>
                </div>
              )}
            </div>
            {primaryImage && !uploading && (
              <button type="button" onClick={() => fileInputRef.current?.click()} className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-border rounded-lg bg-card text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors cursor-pointer">
                <IconUpload /> Reemplazar imagen
              </button>
            )}
            <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={handleFileChange} />
          </div>
        ) : (
          <div className="w-full rounded-xl border border-dashed border-border bg-muted/10 flex flex-col items-center justify-center gap-3 py-10 px-4 text-center" style={{ aspectRatio: '16/9' }}>
            <IconImage />
            <div>
              <p className="text-sm text-muted-foreground font-medium">Imagen disponible al guardar</p>
              <p className="text-[11px] text-muted-foreground/60 mt-0.5">Guarda el producto primero para subir imagen</p>
            </div>
          </div>
        )}
        {uploadError && <p className="text-xs text-destructive mt-1.5">{uploadError}</p>}
      </div>
    )
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="sm:max-w-[880px] w-[95vw] max-h-[90vh] flex flex-col overflow-hidden p-0 gap-0">
          <DialogHeader className="px-6 pt-6 pb-4 border-b border-border shrink-0">
            <DialogTitle>{editingId ? 'Editar Producto' : 'Nuevo Producto'}</DialogTitle>
            {editingId && form.name && (
              <p className="text-xs text-muted-foreground -mt-1">{form.name}</p>
            )}
          </DialogHeader>

          {/* Body: rail de pasos | contenido del paso activo. En móvil, el rail
              se vuelve una fila de chips horizontal arriba del contenido. */}
          <div className="flex-1 min-h-0 flex flex-col md:flex-row overflow-y-auto md:overflow-hidden">
            <div className="order-1 w-full md:w-[220px] md:shrink-0 border-b md:border-b-0 md:border-r border-border bg-muted/10 px-2 py-2.5 md:px-3 md:py-4">
              <StepRail steps={steps} activeStep={activeStep} onSelect={setActiveStep} />
            </div>

            <div className="order-2 flex-1 min-w-0 md:overflow-y-auto px-6 py-5">
              {stepContent}
            </div>
          </div>
          {/* /Body */}

          {/* Footer fijo — navegación del wizard + acciones. Guardar y
              Cancelar quedan disponibles siempre: nada obliga a recorrer
              todos los pasos para guardar una edición puntual. */}
          <div className="flex items-center gap-2.5 px-6 py-4 border-t border-border shrink-0 bg-card">
            <button
              type="button"
              onClick={() => setActiveStep(s => Math.max(0, s - 1))}
              disabled={isFirstStep}
              className="flex items-center gap-1 px-3 py-2 border border-border rounded-lg bg-card text-[13px] text-muted-foreground cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed hover:text-foreground transition-colors"
            >
              <ChevronLeft className="w-3.5 h-3.5" /> Anterior
            </button>
            {!isLastStep && (
              <button
                type="button"
                onClick={() => setActiveStep(s => Math.min(steps.length - 1, s + 1))}
                className="flex items-center gap-1 px-3 py-2 border border-border rounded-lg bg-card text-[13px] text-muted-foreground cursor-pointer hover:text-foreground transition-colors"
              >
                Siguiente <ChevronRight className="w-3.5 h-3.5" />
              </button>
            )}

            <span className="flex-1" />

            <button type="button" onClick={onClose} className="px-4.5 py-2 border border-border rounded-lg bg-card text-[13px] cursor-pointer text-muted-foreground">Cancelar</button>
            <button type="button" onClick={onSave} className="flex items-center gap-1.5 px-4.5 py-2 bg-primary text-primary-foreground border-none rounded-lg text-[13px] font-semibold cursor-pointer">
              <Check className="w-3.5 h-3.5" /> Guardar
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {viewerOpen && primaryImage && (
        <ImageViewer
          src={primaryImage.url}
          alt={primaryImage.altText ?? form.name}
          onClose={() => setViewerOpen(false)}
        />
      )}
    </>
  )
}
