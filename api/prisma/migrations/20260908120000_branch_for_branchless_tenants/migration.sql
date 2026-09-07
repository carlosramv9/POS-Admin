-- ============================================================================
-- Sucursal principal para los tenants que no tienen ninguna, y siembra de su
-- inventario desde `products.stock`.
--
-- Por qué existe: el modelo de inventario por variante (ADR-0030) cuelga TODA
-- la existencia de `branch_inventory(branchId, variantId)`. Un tenant sin
-- ninguna sucursal no tiene dónde guardarla, así que su stock se quedó viviendo
-- solo en la columna espejo `products.stock` y cada lectura pasa por un
-- fallback. Mientras exista un solo tenant así, esa columna no se puede retirar
-- y los fallbacks tienen que quedarse en seis sitios del código.
--
-- El hueco es histórico, no una fuga abierta: las dos rutas de alta de tenant
-- (`tenants.service.ts` y `platform-tenants.service.ts`) ya crean su sucursal
-- `Principal` desde hace tiempo. Esto repara a los que se crearon antes.
--
-- Es deliberadamente conservadora:
--
--   · Solo toca tenants ACTIVE que no tienen NINGUNA sucursal (de ningún
--     estado). Un tenant suspendido o con sucursales se queda como está.
--   · La sucursal nace `isMain`, que es lo que el resolver busca por omisión.
--   · La existencia se siembra en ESA sucursal y solo para la variante default
--     —la única que puede tener un producto que nunca configuró
--     presentaciones—, con el valor exacto de `products.stock`. Al haber una
--     sola sucursal no hay forma de replicar.
--   · No borra ni recalcula nada.
-- ============================================================================

-- ── 1. Sucursal principal donde falte ───────────────────────────────────────
INSERT INTO "branches" ("id", "tenantId", "name", "code", "isMain", "status", "createdAt", "updatedAt")
SELECT
  gen_random_uuid(),
  t."id",
  'Principal',
  'MAIN',
  true,
  'ACTIVE',
  NOW(),
  NOW()
FROM "tenants" t
WHERE t."status" = 'ACTIVE'
  AND NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."tenantId" = t."id");

-- ── 2. Variante default para el producto al que le falte ────────────────────
-- Defensivo: un producto sembrado por una ruta antigua podría no tenerla, y sin
-- variante no hay fila de inventario que crear. Respeta el invariante de la
-- fase 2 (la default no lleva nombre).
INSERT INTO "product_variants" (
  "id", "productId", "name", "isDefault", "trackInventory", "cost", "price", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(),
  p."id",
  NULL,
  true,
  p."trackInventory",
  COALESCE(p."costPrice", 0),
  p."price",
  NOW(),
  NOW()
FROM "products" p
WHERE NOT EXISTS (
  SELECT 1 FROM "product_variants" v WHERE v."productId" = p."id"
);

-- ── 3. Sembrar el inventario que hoy solo vive en products.stock ────────────
-- Solo filas AUSENTES, y solo en la sucursal principal del tenant. La variante
-- default recibe la existencia legacy; cualquier presentación con nombre
-- arranca en 0, porque su existencia nunca estuvo en la columna del producto.
INSERT INTO "branch_inventory" (
  "branchId", "productId", "variantId", "stock",
  "cost", "price", "comparePrice", "lastCost", "avgCost", "lowStockAlert", "updatedAt"
)
SELECT
  b."id",
  p."id",
  v."id",
  CASE WHEN v."isDefault" THEN p."stock" ELSE 0 END,
  COALESCE(p."costPrice", 0),
  p."price",
  p."comparePrice",
  p."lastCost",
  p."avgCost",
  p."lowStockAlert",
  NOW()
FROM "products" p
JOIN "product_variants" v ON v."productId" = p."id"
JOIN "branches" b ON b."tenantId" = p."tenantId" AND b."isMain" AND b."status" = 'ACTIVE'
WHERE NOT EXISTS (
  SELECT 1 FROM "branch_inventory" bi
  WHERE bi."branchId" = b."id" AND bi."variantId" = v."id"
);

-- ── 4. Guarda: ningún producto puede quedar sin inventario ──────────────────
-- Si algo quedó fuera, la migración falla en vez de dejar el sistema a medias:
-- retirar los fallbacks a `products.stock` con productos huérfanos les pondría
-- la existencia en cero.
DO $$
DECLARE
  huerfanos INTEGER;
BEGIN
  SELECT COUNT(*) INTO huerfanos
  FROM "products" p
  JOIN "tenants" t ON t."id" = p."tenantId" AND t."status" = 'ACTIVE'
  WHERE NOT EXISTS (
    SELECT 1 FROM "branch_inventory" bi WHERE bi."productId" = p."id"
  );

  IF huerfanos > 0 THEN
    RAISE EXCEPTION
      'Quedan % productos de tenants activos sin ninguna fila de branch_inventory; no es seguro retirar el respaldo sobre products.stock',
      huerfanos;
  END IF;
END $$;
