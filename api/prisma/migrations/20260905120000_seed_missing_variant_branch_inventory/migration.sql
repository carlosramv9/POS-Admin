-- ============================================================================
-- Siembra las filas de branch_inventory que faltan, para que ninguna quede a
-- merced de `ensureBranchInventoryRow`.
--
-- Contexto: hasta ahora, cuando el motor de inventario se topaba con una
-- combinación (sucursal, variante) sin fila, la creaba con `products.stock` —
-- el espejo legacy, que es la suma de TODAS las variantes de TODAS las
-- sucursales. Cada combinación nueva (una sucursal recién creada, una variante
-- recién añadida) multiplicaba el inventario. A partir de esta entrega esa
-- siembra de emergencia nace en CERO, que es lo correcto: una fila ausente
-- significa que ahí nunca hubo existencia.
--
-- El cambio deja un hueco que esta migración cierra: un tenant cuya sucursal se
-- creó DESPUÉS de la migración expand (20260818140000) no tiene ninguna fila, y
-- su inventario real sigue viviendo en `products.stock`. Con la siembra de
-- emergencia en cero, ese tenant dejaría de poder vender.
--
-- Regla de reparto, deliberadamente conservadora:
--
--   · Solo se INSERTAN filas ausentes. Ninguna fila existente se toca, se
--     recalcula ni se borra. Las existencias por sucursal que ya estaban
--     capturadas son la verdad y esta migración no opina sobre ellas.
--   · La existencia legacy `products.stock` es UNA cantidad física y se asigna a
--     UNA sucursal: la `isMain` del tenant o, si no hay ninguna marcada, la
--     activa más antigua. Nunca se replica.
--   · Solo la variante default hereda esa existencia: es "el producto en sí", la
--     línea contra la que se ha estado moviendo todo el stock hasta hoy.
--   · Cualquier otra combinación (variante con nombre, sucursal secundaria)
--     arranca en 0 y se surte con una compra, una transferencia o un conteo.
--
-- Esta migración NO corrige las existencias ya infladas por el bug: no hay forma
-- de distinguir por código qué parte de una cantidad es real. Eso se resuelve
-- con el reporte de diagnóstico y un conteo físico.
-- ============================================================================

-- Sucursal que recibe la existencia legacy de cada tenant: la `isMain`, y si no
-- hay ninguna marcada, la activa más antigua.
WITH target_branch AS (
  SELECT DISTINCT ON (b."tenantId")
    b."tenantId",
    b."id" AS branch_id
  FROM "branches" b
  WHERE b."status" = 'ACTIVE'
  ORDER BY b."tenantId", b."isMain" DESC, b."createdAt", b."id"
)
INSERT INTO "branch_inventory" (
  "branchId", "productId", "variantId", "stock",
  "cost", "price", "comparePrice", "lastCost", "avgCost", "lowStockAlert", "updatedAt"
)
SELECT
  b."id",
  p."id",
  v."id",
  CASE
    WHEN v."isDefault" AND b."id" = t.branch_id THEN p."stock"
    ELSE 0
  END,
  COALESCE(p."costPrice", 0),
  p."price",
  p."comparePrice",
  p."lastCost",
  p."avgCost",
  p."lowStockAlert",
  NOW()
FROM "products" p
JOIN "product_variants" v ON v."productId" = p."id"
JOIN "branches" b ON b."tenantId" = p."tenantId" AND b."status" = 'ACTIVE'
LEFT JOIN target_branch t ON t."tenantId" = p."tenantId"
WHERE NOT EXISTS (
  SELECT 1 FROM "branch_inventory" bi
  WHERE bi."branchId" = b."id" AND bi."variantId" = v."id"
);
