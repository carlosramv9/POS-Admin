import { useCartStore, type CartLine } from '~/stores/cart-store'
import type { OrderTotalsPreview } from '~/services/order-totals'
import { Icon } from '~/components/shared/Icon'
import { amount, money } from '~/utils/money'
import { toast } from '~/components/ui/Toast'

/**
 * Panel derecho: la venta en curso.
 *
 * El desglose (subtotal, descuento, IVA, total) es una **vista previa** que
 * replica la aritmética del backend; los importes definitivos son los que
 * devuelve la orden al cobrar. Ver `services/order-totals.ts`.
 */
export function CartPanel({
  totals,
  onCheckout,
  onPickCustomer,
  onApplyDiscount,
  onSuspend,
  canCheckout,
}: {
  totals: OrderTotalsPreview
  onCheckout: () => void
  onPickCustomer: () => void
  onApplyDiscount: () => void
  onSuspend: () => void
  canCheckout: boolean
}) {
  const lines = useCartStore((s) => s.lines)
  const customer = useCartStore((s) => s.customer)
  const clear = useCartStore((s) => s.clear)

  const empty = lines.length === 0

  return (
    <aside
      className="pos-cart"
    >
      <div
        style={{
          padding: '16px 18px',
          borderBottom: '1px solid var(--hairline)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
        }}
      >
        <div>
          <div style={{ fontSize: 15, fontWeight: 700 }}>Venta actual</div>
          <div style={{ fontSize: 11.5, color: 'var(--muted-foreground)' }}>
            {lines.length} {lines.length === 1 ? 'línea' : 'líneas'} · {totals.itemCount} {totals.itemCount === 1 ? 'artículo' : 'artículos'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <SmallButton onClick={onSuspend} disabled={empty}>
            Suspender
          </SmallButton>
          <SmallButton onClick={clear} disabled={empty} tone="danger">
            Cancelar
          </SmallButton>
        </div>
      </div>

      <button
        type="button"
        onClick={onPickCustomer}
        style={{
          cursor: 'pointer',
          fontFamily: 'inherit',
          textAlign: 'left',
          display: 'flex',
          alignItems: 'center',
          gap: 11,
          padding: '12px 18px',
          border: 'none',
          borderBottom: '1px solid var(--hairline)',
          background: 'transparent',
          width: '100%',
        }}
      >
        <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--muted)', display: 'grid', placeItems: 'center' }}>
          <Icon name="user" size={17} color="var(--muted-foreground)" />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>{customer ? customer.nombre : 'Venta de mostrador'}</div>
          <div style={{ fontSize: 11.5, color: 'var(--muted-foreground)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {customer ? customer.email || customer.telefono || 'Cliente registrado' : 'Sin cliente asignado'}
          </div>
        </div>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--primary)' }}>{customer ? 'Cambiar' : 'Asignar'}</span>
      </button>

      <div className="pos-scroll" style={{ flex: 1, minHeight: 0 }}>
        {empty ? (
          <div
            style={{
              height: '100%',
              minHeight: 280,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              padding: 32,
              textAlign: 'center',
            }}
          >
            <div style={{ width: 48, height: 48, borderRadius: 14, background: 'var(--muted)', display: 'grid', placeItems: 'center' }}>
              <Icon name="cart" size={22} color="var(--muted-foreground)" />
            </div>
            <div style={{ fontSize: 14.5, fontWeight: 700 }}>Carrito vacío</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted-foreground)' }}>Escanea un código o toca un producto del catálogo.</div>
          </div>
        ) : (
          lines.map((line) => <CartRow key={line.key} line={line} />)
        )}
      </div>

      <div
        style={{
          borderTop: '1px solid var(--hairline)',
          padding: '16px 18px',
          display: 'flex',
          flexDirection: 'column',
          gap: 9,
          background: 'var(--neutral-0)',
        }}
      >
        <SummaryRow label="Subtotal" value={money(totals.subtotal)} />

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13.5, color: 'var(--muted-foreground)' }}>
          <button
            type="button"
            onClick={onApplyDiscount}
            disabled={empty}
            style={{
              cursor: empty ? 'not-allowed' : 'pointer',
              background: 'transparent',
              border: 'none',
              padding: 0,
              fontFamily: 'inherit',
              fontSize: 13.5,
              fontWeight: 600,
              color: 'var(--primary)',
              opacity: empty ? 0.5 : 1,
            }}
          >
            Aplicar descuento
          </button>
          <span className="tabular" style={{ fontWeight: 600, color: totals.discount > 0 ? 'var(--semantic-green-fg)' : 'var(--foreground)' }}>
            {totals.discount > 0 ? `− ${money(totals.discount)}` : money(0)}
          </span>
        </div>

        <SummaryRow
          label={totals.effectiveTaxRate != null ? `IVA ${totals.effectiveTaxRate}%` : 'Impuestos'}
          value={money(totals.tax)}
        />

        <div style={{ height: 1, background: 'var(--hairline)', margin: '3px 0' }} />

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--brand-blue-700)' }}>
            Total
          </span>
          <span className="tabular" style={{ fontSize: 36, fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--brand-blue-700)' }}>
            {money(totals.total)}
          </span>
        </div>

        <button
          type="button"
          onClick={onCheckout}
          disabled={!canCheckout}
          style={{
            marginTop: 4,
            height: 74,
            width: '100%',
            cursor: canCheckout ? 'pointer' : 'not-allowed',
            border: 'none',
            borderRadius: 14,
            background: 'var(--primary)',
            color: 'var(--primary-foreground)',
            fontFamily: 'inherit',
            fontSize: 19,
            fontWeight: 800,
            letterSpacing: '0.06em',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            boxShadow: '0 4px 12px oklch(0.52 0.18 250 / 0.28)',
            opacity: canCheckout ? 1 : 0.45,
          }}
        >
          <span>COBRAR</span>
          <span className="tabular" style={{ fontSize: 15, fontWeight: 700, letterSpacing: 0, opacity: 0.75 }}>
            {money(totals.total)}
          </span>
        </button>
      </div>
    </aside>
  )
}

function CartRow({ line }: { line: CartLine }) {
  const increment = useCartStore((s) => s.increment)
  const decrement = useCartStore((s) => s.decrement)
  const remove = useCartStore((s) => s.remove)

  const onIncrement = () => {
    const res = increment(line.key)
    if (!res.ok && res.reason) toast(res.reason, 'error')
  }

  return (
    <div style={{ padding: '13px 18px', borderBottom: '1px solid var(--hairline)', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.3 }}>
          {line.name}
          {/* La presentación va en el renglón: dos variantes del mismo producto
              son dos líneas, y sin el nombre el cajero no las distingue. */}
          {line.variantName && (
            <span style={{ fontWeight: 500, color: 'var(--muted-foreground)' }}> — {line.variantName}</span>
          )}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--muted-foreground)', marginTop: 2 }}>
          {line.sku} · {money(line.unitPrice)} c/u
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <QtyButton label="−" ariaLabel={`Quitar uno de ${line.name}`} onClick={() => decrement(line.key)} />
        <span className="tabular" style={{ minWidth: 26, textAlign: 'center', fontSize: 14.5, fontWeight: 700 }}>
          {line.qty}
        </span>
        <QtyButton label="+" ariaLabel={`Agregar uno de ${line.name}`} onClick={onIncrement} />
      </div>

      <div className="tabular" style={{ width: 82, textAlign: 'right', fontSize: 15, fontWeight: 700 }}>
        {amount(line.unitPrice * line.qty)}
      </div>

      <button
        type="button"
        onClick={() => remove(line.key)}
        aria-label={`Eliminar ${line.name}`}
        style={{
          cursor: 'pointer',
          width: 28,
          height: 28,
          borderRadius: 8,
          border: 'none',
          background: 'transparent',
          color: 'var(--muted-foreground)',
          fontFamily: 'inherit',
          fontSize: 15,
          lineHeight: 1,
        }}
      >
        ×
      </button>
    </div>
  )
}

function QtyButton({ label, ariaLabel, onClick }: { label: string; ariaLabel: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      style={{
        cursor: 'pointer',
        width: 32,
        height: 32,
        borderRadius: 9,
        border: '1px solid var(--hairline)',
        background: 'var(--card)',
        fontFamily: 'inherit',
        fontSize: 17,
        fontWeight: 700,
        color: 'var(--foreground)',
        lineHeight: 1,
      }}
    >
      {label}
    </button>
  )
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13.5, color: 'var(--muted-foreground)' }}>
      <span>{label}</span>
      <span className="tabular" style={{ fontWeight: 600, color: 'var(--foreground)' }}>
        {value}
      </span>
    </div>
  )
}

function SmallButton({
  children,
  onClick,
  disabled,
  tone = 'neutral',
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  tone?: 'neutral' | 'danger'
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontFamily: 'inherit',
        fontSize: 12,
        fontWeight: 600,
        height: 32,
        padding: '0 11px',
        borderRadius: 9,
        border: '1px solid var(--hairline)',
        background: 'transparent',
        color: tone === 'danger' ? 'var(--semantic-red-fg)' : 'var(--muted-foreground)',
        opacity: disabled ? 0.45 : 1,
      }}
    >
      {children}
    </button>
  )
}
