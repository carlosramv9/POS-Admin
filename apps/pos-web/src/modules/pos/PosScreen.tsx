import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PosTopbar } from './components/PosTopbar'
import { PosNav } from './components/PosNav'
import { CatalogPanel } from './components/CatalogPanel'
import { CartPanel } from './components/CartPanel'
import { CustomerDialog } from './components/CustomerDialog'
import { DiscountDialog } from './components/DiscountDialog'
import { SuspendedDialog } from './components/SuspendedDialog'
import { VariantDialog } from './components/VariantDialog'
import { CheckoutDialog } from '~/modules/checkout/CheckoutDialog'
import { useCatalog } from '~/hooks/use-catalog'
import { useDebounced } from '~/hooks/use-debounced'
import { useCheckout } from '~/hooks/use-checkout'
import { useCartStore, sellableVariants } from '~/stores/cart-store'
import { useCashStore } from '~/stores/cash-store'
import { useAuthStore } from '~/stores/session-store'
import { previewTotals } from '~/services/order-totals'
import { toast } from '~/components/ui/Toast'
import type { Product, ProductVariant } from '~/services/orbix'

/**
 * Pantalla principal del POS: catálogo a la izquierda, venta en curso a la
 * derecha, y el cobro como capa encima. El flujo completo — buscar, agregar,
 * cobrar — se resuelve sin cambiar de ruta.
 */
export function PosScreen() {
  const navigate = useNavigate()
  const branchId = useAuthStore((s) => s.currentBranch?.id)
  const refreshCash = useCashStore((s) => s.refresh)

  const catalog = useCatalog()
  const [rawQuery, setRawQuery] = useState('')
  const query = useDebounced(rawQuery, 180)
  const searchRef = useRef<HTMLInputElement>(null)

  const [customerOpen, setCustomerOpen] = useState(false)
  const [discountOpen, setDiscountOpen] = useState(false)
  const [suspendedOpen, setSuspendedOpen] = useState(false)
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  /** Producto a la espera de que el cajero elija presentación. */
  const [variantPick, setVariantPick] = useState<Product | null>(null)

  const lines = useCartStore((s) => s.lines)
  const discount = useCartStore((s) => s.discount)
  const customer = useCartStore((s) => s.customer)
  const suspendedCount = useCartStore((s) => s.suspended.length)
  const addToCart = useCartStore((s) => s.add)
  const setCustomer = useCartStore((s) => s.setCustomer)
  const setDiscount = useCartStore((s) => s.setDiscount)
  const suspend = useCartStore((s) => s.suspend)

  const totalsContext = useMemo(
    () => ({ productsById: catalog.productsById, defaultTaxRate: catalog.defaultTaxRate }),
    [catalog.productsById, catalog.defaultTaxRate],
  )

  const totals = useMemo(() => previewTotals(lines, totalsContext), [lines, totalsContext])
  const checkout = useCheckout(totalsContext)

  const onAdd = useCallback(
    (product: Product) => {
      // Con varias presentaciones no se puede adivinar cuál se está vendiendo:
      // cada una tiene su precio y su existencia. Se pregunta antes de agregar,
      // en vez de cargar la venta a la línea default.
      if (sellableVariants(product).length > 0) {
        setVariantPick(product)
        return
      }
      const res = addToCart(product)
      if (!res.ok) toast(res.reason ?? 'No se pudo agregar el producto', 'error')
    },
    [addToCart],
  )

  const onPickVariant = useCallback(
    (product: Product, variant: ProductVariant) => {
      setVariantPick(null)
      const res = addToCart(product, variant)
      if (!res.ok) toast(res.reason ?? 'No se pudo agregar el producto', 'error')
    },
    [addToCart],
  )

  /**
   * Enter en el buscador con una única coincidencia agrega directo y limpia:
   * es el comportamiento que espera un escáner de código de barras.
   */
  const onSearchEnter = useCallback(() => {
    const q = rawQuery.trim().toLowerCase()
    if (!q) return
    const exact = catalog.products.find((p) => p.sku.toLowerCase() === q)
    const matches = catalog.products.filter((p) => `${p.name} ${p.sku}`.toLowerCase().includes(q))
    const target = exact ?? (matches.length === 1 ? matches[0] : null)
    if (target) {
      onAdd(target)
      setRawQuery('')
    }
  }, [rawQuery, catalog.products, onAdd])

  const openCheckout = useCallback(() => {
    if (lines.length === 0 || totals.total <= 0) return
    checkout.reset()
    setCheckoutOpen(true)
  }, [lines.length, totals.total, checkout])

  // Atajos del diseño: F2 enfoca la búsqueda, F4 abre el cobro.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (checkoutOpen) return
      if (e.key === 'F2') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
      if (e.key === 'F4') {
        e.preventDefault()
        openCheckout()
      }
      if (e.key === 'Enter' && document.activeElement === searchRef.current) {
        e.preventDefault()
        onSearchEnter()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [checkoutOpen, openCheckout, onSearchEnter])

  const onSuspend = () => {
    const label = customer?.nombre ?? `Venta ${new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}`
    if (suspend(label)) toast('Venta suspendida')
    else toast('No hay nada que suspender', 'error')
  }

  const onCompleted = (orderId: string) => {
    setCheckoutOpen(false)
    // La venta movió el efectivo de la caja: se refresca para que la barra
    // superior muestre el esperado real que reporta el backend.
    void refreshCash(branchId)
    navigate(`/ticket/${orderId}`)
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <PosTopbar
        suspendedCount={suspendedCount}
        onOpenSuspended={() => setSuspendedOpen(true)}
        onOpenCash={() => navigate('/caja')}
      />

      <div className="pos-layout">
        <PosNav />

        <CatalogPanel
          products={catalog.products}
          categories={catalog.categories}
          categoryIndexOf={catalog.categoryIndexOf}
          categoryNameOf={catalog.categoryNameOf}
          loading={catalog.loading}
          error={catalog.error}
          onReload={catalog.reload}
          onAdd={onAdd}
          query={rawQuery}
          filterQuery={query}
          onQueryChange={setRawQuery}
          searchRef={searchRef}
        />

        <CartPanel
          totals={totals}
          canCheckout={lines.length > 0 && totals.total > 0}
          onCheckout={openCheckout}
          onPickCustomer={() => setCustomerOpen(true)}
          onApplyDiscount={() => setDiscountOpen(true)}
          onSuspend={onSuspend}
        />
      </div>

      <CustomerDialog open={customerOpen} onClose={() => setCustomerOpen(false)} onSelect={setCustomer} current={customer} />

      <DiscountDialog
        open={discountOpen}
        onClose={() => setDiscountOpen(false)}
        onApply={setDiscount}
        currentDiscount={discount}
        subtotal={totals.subtotal}
      />

      <SuspendedDialog open={suspendedOpen} onClose={() => setSuspendedOpen(false)} />

      <VariantDialog product={variantPick} onClose={() => setVariantPick(null)} onPick={onPickVariant} />

      {checkoutOpen && <CheckoutDialog checkout={checkout} onClose={() => setCheckoutOpen(false)} onCompleted={onCompleted} />}
    </div>
  )
}

/** El query con debounce alimenta el filtrado; se expone para pruebas futuras. */
export type { Product }
