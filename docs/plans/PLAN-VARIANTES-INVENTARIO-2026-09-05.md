# Plan — Inventario por variante: cerrar la fase *contract* de ADR-0030

**Fecha:** 2026-09-05
**Alcance:** `orbix-admin/` · `api/src/modules/retail/products`, `retail/inventory`, `retail/purchases`, `core/branches`, `core/store` · `apps/pos-web/` · `web/`
**Origen:** auditoría del módulo de productos (variantes), 2026-09-05
**Decisión de referencia:** ADR-0030 *Variante por defecto obligatoria como unidad vendible (Orbix)* — aceptada 2026-08-17, entregada en fase *expand* 2026-08-18, *contract* pendiente
**Estado del plan:** Fase 0 implementada (2026-09-05). Fases 1–3 pendientes.

> Convenciones: **Confirmado** = respaldado por código citado en la auditoría. **Bloqueante** = no se puede desplegar la fase siguiente sin esto. **S/M/L** = tamaño relativo de la entrega.

---

## 1. Objetivo

Las cuatro reglas de negocio que debe cumplir el módulo:

1. Un producto que se da de alta **sin variantes** obtiene una variante *default* implícita que representa "el producto en sí".
2. Al configurar la **primera variante con nombre**, la default **se promueve** a esa variante — se renombra conservando id, existencias e historial. No se crea una segunda fila ni queda una default fantasma.
3. Las variantes siguientes se agregan normal.
4. **Cada variante lleva su propio inventario.** El producto "solo" no acumula un stock aparte del de sus variantes.

Las reglas 1 y 3 ya se cumplen. Las reglas **2 y 4 no**, y no son entregables de forma aislada: la 2 depende de la 4, y la 4 depende de un cambio de contrato en la cadena de venta y compra.

## 2. Por qué no se puede empezar por la promoción

La tentación es implementar la regla 2 primero — es un cambio pequeño en `ProductsService.update`. **Rompería la venta.**

Hoy toda la cadena de inventario resuelve la variante a través de `VariantInventoryResolver.resolveVariantId`, que busca `isDefault: true`. Si la promoción elimina la default de un producto con variantes:

```
resolveVariantId → null
  → applyProductStockDelta cae al camino legacy sobre Product.stock
    → la venta no toca branch_inventory y el stock por variante nunca se mueve
```

Los llamadores no pueden nombrar la variante porque el modelo no la guarda: `OrderItem`, `InventoryMovement`, `PurchaseOrderItem`, `PurchaseReceiptItem` y `StoreWhatsappOrderItem` **no tienen `variantId`**, y el POS no tiene ninguna referencia a variantes.

Por eso el orden es: **primero dar a los llamadores la capacidad de nombrar la variante, después promover la default.**

## 3. Fases

| Fase | Qué entrega | Migración | Tamaño | Reversible |
|---|---|---|---|---|
| 0 | Corrección de los bugs que hoy inflan inventario | no | S | sí |
| 1 | `variantId` en la cadena de venta, compra y sucursales | expand (aditiva) | L | sí |
| 2 | Promoción de la default + invariantes en base | pequeña | M | sí |
| 3 | Contract: retirar columnas legacy | destructiva | M | **no** |

Cada fase es desplegable por sí sola y deja el sistema en un estado coherente.

---

## Fase 0 — Estabilizar (sin cambio de contrato) — ✅ implementada 2026-09-05

> **Cambio respecto de lo planeado.** Poner en cero la siembra de emergencia
> (0.2) convierte un bug silencioso en un bloqueo visible: donde antes se
> inflaba el stock, ahora la venta se rechaza por existencia insuficiente. Un
> tenant cuya sucursal se creó después de la migración expand no tiene ninguna
> fila y su inventario real vive en `products.stock`, así que habría dejado de
> vender. Se añadió por eso la migración
> `20260905120000_seed_missing_variant_branch_inventory`, que **solo inserta
> filas ausentes** —ninguna existente se toca— y asigna la existencia legacy a
> UNA sucursal (la `isMain`, o la activa más antigua) para la variante default.
> No corrige las cantidades ya infladas: eso sigue siendo 0.7.
>
> Fuera de plan, por dependencia directa: la app móvil también enviaba `stock`
> en el PATCH y habría recibido 400 con `forbidNonWhitelisted` activo
> (`apps/mobile/orbix-mobile/src/features/products/product-schemas.ts`,
> `product-form.tsx`).

Bugs confirmados en la auditoría que corrompen existencias **hoy**, con el modelo actual. No dependen de nada de lo que sigue y deben ir primero.

### 0.1 El stock inicial se replica en cada sucursal — **Bloqueante**

`api/src/modules/retail/products/products.service.ts:432`

```ts
stock: overrides === undefined ? product.stock : scoped ? (overrides.stock ?? 0) : 0,
```

Cuando se siembra la default (`:256`, sin `overrides`) el valor va a **todas** las sucursales activas. Alta con stock 10 en un tenant de 3 sucursales → 30 unidades.

**Cambio:** la existencia inicial pertenece a **una** sucursal: la del contexto, o la `isMain` del tenant si el token no trae sucursal. El resto arranca en 0. Los valores comerciales (precio, costo, `comparePrice`, `lowStockAlert`) sí se copian a todas — eso es correcto y se conserva.

### 0.2 `ensureBranchInventoryRow` siembra con el stock global

`api/src/modules/retail/inventory/inventory.engine.ts:298`

```ts
stock: product.stock,
```

Aplica a **cualquier** variante, no solo la default. Una fila que no existe significa "en esta sucursal nunca hubo existencia de esta variante".

**Cambio:** `stock: 0`. Los valores comerciales se siguen copiando del producto.

### 0.3 Una sucursal nueva no siembra inventario

`api/src/modules/core/branches/branches.service.ts:25-44` crea la sucursal y nada más. Sin filas, el primer movimiento cae en 0.2.

**Cambio:** al crear la sucursal, sembrar una fila por cada variante de cada producto del tenant, con `stock: 0` y los valores comerciales del producto. Hace visible el catálogo completo en la pantalla de inventario por sucursal desde el día uno.

### 0.4 El campo "Stock" del formulario de edición miente

`products.service.ts:534` escribe `productData.stock` en `products.stock` pero no toca `branch_inventory`. `attachVariantStock:387` ignora `products.stock` cuando hay filas: el usuario cambia el número, guarda, y no ocurre nada visible — pero corrompe el espejo legacy que alimenta 0.2.

**Cambio:** quitar `stock` de `UpdateProductDto`. La existencia se mueve por el flujo de ajuste (`PATCH /products/:id/stock`), que ya escribe el `InventoryMovement` correspondiente. En el alta (`CreateProductDto`) `stock` se conserva: ahí sí es la existencia inicial.

### 0.5 La UI permite exactamente lo que la regla 4 prohíbe

`web/src/components/inventario/product-form-modal.tsx:1042-1056` muestra el campo "Stock" del producto **y** el editor de variantes con columna "Stock" al mismo tiempo.

**Cambio:**
- Ocultar el campo "Stock" del producto en cuanto `variants.length > 0`.
- En el editor de variantes, la columna "Stock" es editable solo en filas nuevas (sin `id`). En una variante existente pasa a solo lectura con la nota "se ajusta desde Inventario" — que es lo que el backend ya hace (documentado en `ProductVariantDto`), hoy sin decírselo al usuario.

### 0.6 Menores

| Qué | Dónde | Cambio |
|---|---|---|
| Seed con snapshot previo al update | `products.service.ts:646` | usar `updatedProduct`, no `product` |
| Variantes con nombre no heredan `trackInventory` | `products.service.ts:293-303` | heredar de `created.trackInventory`, igual que la default en `:250` |
| `getLowStock` duplica el producto por variante sin decir cuál | `products.service.ts:847` | incluir nombre de variante en la respuesta |
| La tienda publica el stock de la default como stock del producto | `core/store/store.service.ts:141` | con variantes con nombre, `stock` = suma de variantes |
| `needsRefetch` siempre `true` | `products.service.ts:258` | eliminar la variable |

### 0.7 Reporte de datos ya corrompidos — **no automatizar la corrección**

Los bugs 0.1–0.3 llevan desde 2026-08-18 en producción. No es posible saber por código qué parte de una existencia inflada es real.

**Entregable:** una consulta de diagnóstico que liste, por tenant, los productos donde `SUM(branch_inventory.stock) <> products.stock`, más los que tienen filas de sucursal creadas el mismo día que un movimiento (síntoma de 0.2). Se resuelve con un conteo físico, no con un `UPDATE`.

### Verificación de la fase 0 — ✅ hecha

Automática: 88 suites / 658 tests en verde. Specs nuevos
`products.stock-seeding.spec.ts` (5 casos) y `branches.inventory-seed.spec.ts`
(4 casos). Reescritos los 5 tests que blindaban la siembra desde el stock global
(`inventory.engine.spec.ts`, `inventory.branch-stock.spec.ts`,
`inventory-consumption.engine.spec.ts`).

Con la app arrancada (API desde fuente en :3099, tenant `default`, sucursal
temporal creada y borrada al terminar):

| Comprobación | Resultado |
|---|---|
| El contenedor de Nest resuelve el nuevo `VariantInventoryResolver` en `ProductsService` | arranca sin error |
| `stock` desaparece del esquema de `PATCH /products/{id}` en Swagger | 19 campos, sin `stock` |
| Sucursal nueva → siembra su catálogo | 5 filas, todas en 0, con precio y costo heredados |
| Alta con stock 10, dos sucursales activas | 10 en la principal, 0 en la otra. Total **10**, antes 20 |
| `PATCH` con `stock` | **400** |
| `PATCH` sin `stock` | 200 |
| Añadir variante "Talla M" con stock 4 | total 14 (10 + 4), cada cantidad en una sola sucursal |

La última fila deja ver lo que la fase 0 **no** arregla: la default conserva sus
10 junto a la M. Es la regla 2, y es la fase 2.

---

## Fase 1 — `variantId` en la cadena — **prerequisito de todo lo demás**

### 1.1 Migración expand (aditiva, revertible)

```sql
-- variantId nullable + FK en las cinco tablas que hoy solo guardan productId
ALTER TABLE "order_items"                ADD COLUMN "variantId" TEXT;
ALTER TABLE "inventory_movements"        ADD COLUMN "variantId" TEXT;
ALTER TABLE "purchase_order_items"       ADD COLUMN "variantId" TEXT;
ALTER TABLE "purchase_receipt_items"     ADD COLUMN "variantId" TEXT;
ALTER TABLE "store_whatsapp_order_items" ADD COLUMN "variantId" TEXT;
-- + FK ON DELETE SET NULL (el historial sobrevive al borrado de la variante)
-- + backfill: variantId = la default del producto de cada fila
```

`NOT NULL` se deja para la fase 3: mientras tanto una fila sin variante es legible como "histórico anterior al cambio".

### 1.2 Motor de consumo

`api/src/modules/retail/inventory/inventory-consumption.engine.ts`

- `InventoryLineItem` gana `variantId?: string | null`.
- **`resolveEffects` agrupa hoy por `productId`.** Debe agrupar por `(productId, variantId)` o dos líneas de variantes distintas del mismo producto se fusionan en una sola resta. Es el punto más fácil de pasar por alto de toda la fase.
- `consume` y `restore` propagan `variantId` a `applyProductStockDelta` (el parámetro ya existe, `inventory.engine.ts:170`).
- El `InventoryMovement` guarda `variantId`.

### 1.3 Compras

`api/src/modules/retail/purchases/purchases.service.ts:325` deja de llamar `ensureDefaultVariantId` y usa el `variantId` de la línea de recepción, con fallback a la default mientras el front no lo envíe.

### 1.4 Sucursales

`api/src/modules/core/branches/branches.service.ts` — `updateInventoryItem` (`:176`), conteo físico masivo (`:252`) y `transferStock` (`:300`) aceptan `variantId` opcional. Sin él conservan el comportamiento actual.

### 1.5 Endpoint de ajuste por variante

Nuevo: `PATCH /products/:id/variants/:variantId/stock`, permiso `products:edit`, misma mecánica que `PATCH /products/:id/stock` (delta + `InventoryMovement` tipo `AJUSTE` dentro de una transacción, guard de existencia en la base).

Hoy **no existe ninguna forma** de mover la existencia de una variante con nombre después de crearla.

### 1.6 POS

`apps/pos-web/` — no tiene una sola referencia a variantes.

- El catálogo marca los productos con más de una variante.
- Al tocar uno, se abre un selector de variante antes de añadir al carrito.
- La línea del carrito lleva `variantId`, el nombre de la variante y su precio de sucursal.
- El ticket imprime el nombre de la variante.

### 1.7 Tienda y back-office

- `core/store/store.service.ts`: el item de pedido por WhatsApp lleva `variantId`.
- `web/`: la pantalla de inventario por sucursal pasa a listar por variante.

### Verificación de la fase 1

- Test: dos variantes del mismo producto en una venta → dos restas independientes (cubre el riesgo de 1.2).
- Test de aislamiento multi-tenant sobre el nuevo endpoint de ajuste.
- **Con la app arrancada:** vender una L desde el POS y comprobar que baja el stock de la L, no el de otra variante.

### Orden de despliegue

API antes que POS. La API con `variantId` opcional acepta al POS viejo sin cambios.

---

## Fase 2 — Promoción de la default (la regla 2)

Solo después de que la fase 1 esté estable en producción.

### 2.1 Promoción

`ProductsService.update`, bloque de sincronización de variantes (`products.service.ts:591-660`):

- Si el producto tiene **exactamente una** variante y es la default sin nombre, y el DTO trae variantes con nombre:
  la **primera** variante del DTO no se crea. Se aplica sobre la default: `UPDATE product_variants SET name = ?, isDefault = false WHERE id = ?`. Conserva id, sus filas de `branch_inventory`, su existencia y su historial de movimientos.
- Las demás se crean como hoy.
- Precio y costo capturados se escriben en la fila de la sucursal en contexto, sin cambios respecto del comportamiento actual.

### 2.2 Degradación (quitar la última variante con nombre)

Cuando el usuario elimina todas las variantes con nombre, la última **no se borra**: se degrada de vuelta a default (`name = NULL`, `isDefault = true`), conservando su existencia.

Mantiene el invariante "todo producto tiene exactamente una variante" en los dos sentidos y evita que quitar una variante destruya inventario. Alternativa descartada: prohibir quedarse sin variantes — obliga al usuario a un rodeo sin ganar nada.

### 2.3 Resolución sin variante explícita

`VariantInventoryResolver.resolveVariantId` deja de asumir que siempre hay default:

- Producto con **una** variante → esa variante, tenga o no `isDefault`.
- Producto con **varias** y llamador sin `variantId` → **error 400 explícito** ("especifica la variante"), nunca descuento silencioso sobre una elegida por el sistema.

`ensureDefaultVariantId` se conserva solo para la auto-reparación de productos sembrados por rutas antiguas (importación, seeds), que siguen siendo de una sola variante.

### 2.4 Invariantes en base

El índice único parcial `product_variants_default_per_product` ya garantiza "como mucho una default por producto" y funciona. Faltan:

```sql
-- La default nunca tiene nombre; una variante con nombre nunca es default.
ALTER TABLE "product_variants"
  ADD CONSTRAINT "product_variants_default_has_no_name"
  CHECK ("isDefault" = false OR "name" IS NULL);
```

"Al menos una variante por producto" no es expresable como `CHECK`. Se cubre con un test de invariante; un trigger `BEFORE DELETE` es opcional y se puede añadir después si aparece una ruta que lo viole.

### 2.5 Tests que hay que reescribir

`api/src/modules/retail/products/products.variant-sync.spec.ts` blinda hoy el comportamiento que este plan corrige:

- `:86` — "conserva la variante default aunque el DTO no la mencione"
- `:197` — "quitar todas las variantes con nombre nunca borra la default"

Ambos cambian de significado. Los que cubren la no-pérdida de inventario (`:104`, `:113`, `:180`) se conservan tal cual: siguen siendo correctos y son la red de seguridad de este cambio.

Tests nuevos:
- La primera variante con nombre hereda id, stock e historial de la default.
- La segunda variante se crea, no promueve nada.
- Quitar la última variante con nombre la degrada a default sin perder existencia.
- Un producto con varias variantes y un movimiento sin `variantId` devuelve 400.

### Verificación de la fase 2

**Con la app arrancada**, la secuencia completa que describe la regla de negocio:

1. Alta de producto sin variantes, stock 10. Verificar: una variante, `isDefault = true`, 10 unidades en la sucursal del contexto y 0 en el resto.
2. Agregar variante "M". Verificar: **una sola** variante, llamada M, con las mismas 10 unidades y el mismo id que la default anterior.
3. Agregar "L" con stock 5. Verificar: dos variantes, 10 y 5. Total del producto: 15.
4. Vender una M desde el POS. Verificar: M en 9, L intacta en 5.
5. Quitar L. Verificar: M conserva sus 9; el stock de L se pierde con un movimiento que lo documente.

---

## Fase 3 — Contract (irreversible)

No antes de dos semanas de fase 2 estable en producción.

- `variantId` pasa a `NOT NULL` en las cinco tablas de la fase 1.
- Se retiran: `products.stock`, `product_variants.cost`, `product_variants.price`.
- Se elimina `mirrorLegacyProductStock` (`inventory.engine.ts:222`) y el camino legacy de `applyProductStockDelta`.
- `attachVariantStock` (`products.service.ts:356`) pierde el fallback a `rest.stock`: `branch_inventory` queda como única verdad.
- El campo `stock` del `CreateProductDto` se documenta como "existencia inicial en la sucursal del alta", no como columna del producto.

**Criterio de entrada:** cero filas con `variantId IS NULL` en las cinco tablas, y ningún acceso a `products.stock` fuera del código que se retira en esta fase.

---

## 4. Riesgos

| Riesgo | Mitigación |
|---|---|
| `resolveEffects` agrupando por `productId` fusiona líneas de variantes distintas (1.2) | test explícito de dos variantes en una venta, antes de tocar el POS |
| POS viejo contra API nueva | `variantId` opcional durante toda la fase 1; API se despliega primero |
| Existencias ya infladas por 0.1–0.3 | reporte de diagnóstico (0.7) + conteo físico; nunca un `UPDATE` masivo |
| La promoción rompe la venta si se adelanta a la fase 1 | secuencia de fases; ver §2 |
| Fase 3 irreversible | ventana de estabilización + criterio de entrada verificable por consulta |

## 5. Lecciones de método

Recogidas de la auditoría, aplican más allá de este plan.

1. **Un dual-write sin fecha de muerte se convierte en la fuente de verdad equivocada.** `mirrorLegacyProductStock` mantiene `Product.stock` "por si acaso", y ese "por si acaso" es justo lo que `ensureBranchInventoryRow` lee para sembrar: el espejo se volvió entrada. Cuando se deje un dual-write, el mismo PR debe registrar qué lo retira y qué lo bloquea.
2. **Un test y un ADR que se contradicen es deuda, no cobertura.** `products.variant-sync.spec.ts` documenta como intencional lo que ADR-0030 regla 4 declara incorrecto. Se resuelve en el momento en que se detecta, no se dejan ambos.
3. **Los invariantes que solo viven en TypeScript se saltan.** El índice único parcial de la default funciona; el resto de reglas del modelo de variantes no está en la base y ya hay una ruta que las ignora (`products-import.service.ts`, default-only).
4. **La UI tiene que reflejar la regla o la contradice.** Un campo que el backend ignora en silencio es peor que un campo ausente.
5. **El reparto de stock al configurar variantes es un ajuste explícito, con su `InventoryMovement`** — nunca automático. Ya lo dice ADR-0030 y sigue vigente.

## 6. Documentación

Al cerrar cada fase, actualizar la sección "Estado de implementación" de
`orbix-brain/vault/Decisions/ADR-0030 Variante por defecto obligatoria como unidad vendible (Orbix).md`
y su `updated:`. No se crean documentos nuevos en el vault: la decisión no cambia, cambia su estado de entrega.
