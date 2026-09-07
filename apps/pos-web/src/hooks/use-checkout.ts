import { useCallback, useMemo, useState } from 'react'
import {
  createOrder,
  printOrder,
  type ApiOrder,
  type CreateOrderItemInput,
  type CreateOrderPaymentSplit,
} from '~/services/orbix'
import { useCartStore } from '~/stores/cart-store'
import { distributeOrderDiscount, previewTotals, roundMoney, type TotalsContext } from '~/services/order-totals'
import { errorMessage } from '~/utils/api-error'
import { toNumber } from '~/utils/money'

/**
 * Cobro.
 *
 * El frontend captura, valida lo mínimo de UI y envía a `POST /orders`. No
 * decide impuestos, ni folio, ni asiento de caja: eso lo hace el backend, y la
 * orden que devuelve es la que se muestra en el ticket.
 */

export type PaymentMethod = 'efectivo' | 'tarjeta' | 'transferencia' | 'mixto'

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  efectivo: 'Efectivo',
  tarjeta: 'Tarjeta',
  transferencia: 'Transferencia',
  mixto: 'Pago mixto',
}

/** Códigos que entiende el backend (`payments[].method`). */
const BACKEND_METHOD = {
  efectivo: 'CASH',
  tarjeta: 'CARD',
  transferencia: 'TRANSFER',
} as const

export type MixedField = 'efectivo' | 'tarjeta' | 'transferencia'

export interface CheckoutAmounts {
  cash: number
  card: number
  transfer: number
}

export interface CompletedSale {
  order: ApiOrder
  methodLabel: string
  change: number
}

export function useCheckout(totalsContext: TotalsContext) {
  const lines = useCartStore((s) => s.lines)
  const customer = useCartStore((s) => s.customer)
  const discount = useCartStore((s) => s.discount)
  const clear = useCartStore((s) => s.clear)

  const [method, setMethod] = useState<PaymentMethod>('efectivo')
  /** Monto capturado para el método simple (efectivo/tarjeta/transferencia). */
  const [received, setReceived] = useState('')
  /** Montos por método cuando el cobro es mixto. */
  const [mixed, setMixed] = useState<Record<MixedField, string>>({ efectivo: '', tarjeta: '', transferencia: '' })
  const [activeMixedField, setActiveMixedField] = useState<MixedField>('efectivo')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const totals = useMemo(() => previewTotals(lines, totalsContext), [lines, totalsContext])

  const amounts = useMemo<CheckoutAmounts>(() => {
    if (method === 'mixto') {
      return {
        cash: toNumber(mixed.efectivo),
        card: toNumber(mixed.tarjeta),
        transfer: toNumber(mixed.transferencia),
      }
    }
    const value = toNumber(received)
    return {
      cash: method === 'efectivo' ? value : 0,
      card: method === 'tarjeta' ? value : 0,
      transfer: method === 'transferencia' ? value : 0,
    }
  }, [method, received, mixed])

  const totalReceived = roundMoney(amounts.cash + amounts.card + amounts.transfer)

  /**
   * Tarjeta y transferencia se aplican al total antes que el efectivo, de modo
   * que el cambio salga solo del efectivo excedente. Mismo criterio que el POS
   * del Admin Web.
   */
  const nonCashApplied = Math.min(roundMoney(amounts.card + amounts.transfer), totals.total)
  const remainingAfterNonCash = roundMoney(Math.max(0, totals.total - nonCashApplied))
  const cashApplied = Math.min(amounts.cash, remainingAfterNonCash)
  const change = roundMoney(Math.max(0, amounts.cash - remainingAfterNonCash))
  const missing = roundMoney(Math.max(0, totals.total - (nonCashApplied + amounts.cash)))

  const canConfirm = lines.length > 0 && totals.total > 0 && missing === 0 && !submitting

  const reset = useCallback(() => {
    setMethod('efectivo')
    setReceived('')
    setMixed({ efectivo: '', tarjeta: '', transferencia: '' })
    setActiveMixedField('efectivo')
    setError(null)
  }, [])

  const selectMethod = useCallback((next: PaymentMethod) => {
    setMethod(next)
    setReceived('')
    setMixed({ efectivo: '', tarjeta: '', transferencia: '' })
    setActiveMixedField('efectivo')
    setError(null)
  }, [])

  /** Valor que alimenta el teclado numérico según el método activo. */
  const keypadValue = method === 'mixto' ? mixed[activeMixedField] : received
  const setKeypadValue = useCallback(
    (next: string) => {
      if (method === 'mixto') setMixed((prev) => ({ ...prev, [activeMixedField]: next }))
      else setReceived(next)
    },
    [method, activeMixedField],
  )

  const confirm = useCallback(async (): Promise<CompletedSale | null> => {
    if (lines.length === 0) {
      setError('Agrega productos a la venta')
      return null
    }
    if (missing > 0) {
      setError('El monto recibido no cubre el total')
      return null
    }

    const discountByLine = distributeOrderDiscount(lines, discount)

    const items: CreateOrderItemInput[] = lines.map((line) => {
      const lineDiscount = discountByLine.get(line.key)
      return {
        productId: line.productId,
        // Sin esto el backend carga la venta a la variante default y la
        // presentación que el cajero eligió no se descuenta nunca.
        ...(line.variantId ? { variantId: line.variantId } : {}),
        quantity: line.qty,
        price: line.unitPrice,
        ...(lineDiscount ? { discount: lineDiscount } : {}),
      }
    })

    const payments: CreateOrderPaymentSplit[] = []
    if (cashApplied > 0) {
      payments.push({
        method: BACKEND_METHOD.efectivo,
        currency: 'MXN',
        amount: roundMoney(cashApplied),
        amountReceived: roundMoney(amounts.cash),
      })
    }
    if (amounts.card > 0) {
      payments.push({ method: BACKEND_METHOD.tarjeta, currency: 'MXN', amount: roundMoney(Math.min(amounts.card, totals.total)) })
    }
    if (amounts.transfer > 0) {
      payments.push({
        method: BACKEND_METHOD.transferencia,
        currency: 'MXN',
        amount: roundMoney(Math.min(amounts.transfer, roundMoney(totals.total - Math.min(amounts.card, totals.total)))),
      })
    }

    setSubmitting(true)
    setError(null)
    try {
      const order = await createOrder({
        customerId: customer?.id,
        items,
        paymentMethod: payments[0]?.method ?? BACKEND_METHOD.efectivo,
        payments: payments.length > 0 ? payments : undefined,
        paymentStatus: 'PAID',
        status: 'CONFIRMED',
        ...(change > 0 ? { changeAmount: change, changeCurrency: 'MXN' as const } : {}),
      })

      // Fire-and-forget: la venta ya está registrada; si no hay impresora
      // configurada el servicio no lanza y el flujo continúa.
      void printOrder(order.id)

      const sale: CompletedSale = {
        order,
        methodLabel: PAYMENT_METHOD_LABELS[method],
        change,
      }

      clear()
      reset()
      return sale
    } catch (e) {
      setError(errorMessage(e))
      return null
    } finally {
      setSubmitting(false)
    }
  }, [lines, missing, discount, cashApplied, amounts, totals.total, customer, change, method, clear, reset])

  return {
    method,
    selectMethod,
    received,
    setReceived,
    mixed,
    setMixed,
    activeMixedField,
    setActiveMixedField,
    keypadValue,
    setKeypadValue,
    totals,
    amounts,
    totalReceived,
    change,
    missing,
    canConfirm,
    submitting,
    error,
    setError,
    confirm,
    reset,
  }
}
