import { Dialog } from '~/components/ui/Dialog'
import { Button } from '~/components/ui/Button'
import { money } from '~/utils/money'
import { sellableVariants } from '~/stores/cart-store'
import type { Product, ProductVariant } from '~/services/orbix'

/**
 * Elección de presentación al agregar un producto que se vende en varias.
 *
 * Cada variante lleva su propio precio y su propia existencia por sucursal, así
 * que el cajero tiene que decir cuál está entregando: sin esta elección la venta
 * viajaba sin `variantId` y el backend la cargaba a la línea default —"el
 * producto en sí"—, de modo que vender una talla L descontaba de un contador que
 * no correspondía a nada de lo que había en el mostrador.
 *
 * Solo aparece cuando el producto tiene presentaciones con nombre; la default es
 * interna y nunca se ofrece como opción.
 */
export function VariantDialog({
  product,
  onClose,
  onPick,
}: {
  product: Product | null
  onClose: () => void
  onPick: (product: Product, variant: ProductVariant) => void
}) {
  const variants = product ? sellableVariants(product) : []

  return (
    <Dialog
      open={product !== null}
      onClose={onClose}
      title={product ? `Presentación de ${product.name}` : 'Presentación'}
      description="Cada presentación tiene su propio precio y su propia existencia."
      footer={
        <Button variant="ghost" style={{ height: 38 }} onClick={onClose}>
          Cancelar
        </Button>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {variants.map((variant) => {
          const stock = Number(variant.stock ?? 0)
          // `trackInventory` es del producto: una presentación de un producto que
          // no lleva inventario siempre se puede vender.
          const agotada = product!.trackInventory && stock <= 0

          return (
            <button
              key={variant.id}
              type="button"
              disabled={agotada}
              onClick={() => onPick(product!, variant)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '12px 14px',
                borderRadius: 11,
                border: '1px solid var(--border)',
                background: agotada ? 'var(--muted)' : 'var(--card)',
                color: agotada ? 'var(--muted-foreground)' : 'var(--foreground)',
                cursor: agotada ? 'not-allowed' : 'pointer',
                textAlign: 'left',
                font: 'inherit',
              }}
            >
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 14, fontWeight: 700 }}>{variant.name}</span>
                <span style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>
                  {product!.trackInventory
                    ? agotada
                      ? 'Sin existencia'
                      : `${stock} disponibles`
                    : 'Sin control de existencia'}
                </span>
              </span>
              <span className="tabular" style={{ fontSize: 15, fontWeight: 700 }}>
                {money(Number(variant.price ?? product!.price))}
              </span>
            </button>
          )
        })}

        {variants.length === 0 && (
          <p style={{ fontSize: 13, color: 'var(--muted-foreground)', margin: 0 }}>
            Este producto no tiene presentaciones configuradas.
          </p>
        )}
      </div>
    </Dialog>
  )
}
