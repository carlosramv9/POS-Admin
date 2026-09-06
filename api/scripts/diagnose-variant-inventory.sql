-- ============================================================================
-- Diagnóstico: existencias infladas por la siembra replicada (fase 0)
--
-- Entre 2026-08-18 y esta entrega, tres caminos podían multiplicar el
-- inventario de un producto:
--
--   1. El alta copiaba la existencia inicial en TODAS las sucursales activas
--      (10 unidades en un tenant de tres sucursales nacían como 30).
--   2. La migración expand hizo lo mismo con el catálogo existente.
--   3. El motor de inventario, al toparse con una combinación (sucursal,
--      variante) sin fila, la sembraba con `products.stock` — el espejo legacy,
--      que es la suma de todo.
--
-- No hay forma de saber por código qué parte de una cantidad es real, así que
-- esto NO corrige nada: lista los candidatos para que se resuelvan con un
-- conteo físico. Es de solo lectura.
--
-- Uso:
--   psql "$DATABASE_URL" -f api/scripts/diagnose-variant-inventory.sql
-- ============================================================================

\echo ''
\echo '== 1. Productos cuya suma por sucursal no cuadra con el espejo legacy =='
\echo '   Una diferencia que es múltiplo del número de sucursales es la firma'
\echo '   típica de la replicación. `sucursales_con_la_misma_cantidad` > 1 con'
\echo '   una cantidad distinta de cero la confirma casi siempre.'
\echo ''

WITH por_producto AS (
  SELECT
    p."tenantId",
    p."id"    AS producto_id,
    p."sku",
    p."name"  AS producto,
    p."stock" AS espejo_legacy,
    SUM(bi."stock")                          AS suma_por_sucursal,
    COUNT(DISTINCT bi."branchId")            AS sucursales,
    COUNT(DISTINCT bi."variantId")           AS variantes,
    MAX(bi."stock")                          AS mayor_cantidad,
    COUNT(*) FILTER (
      WHERE bi."stock" = p."stock" AND p."stock" > 0
    )                                        AS filas_iguales_al_espejo
  FROM "products" p
  JOIN "branch_inventory" bi ON bi."productId" = p."id"
  GROUP BY p."tenantId", p."id", p."sku", p."name", p."stock"
)
SELECT
  t."name" AS empresa,
  pp.sku,
  pp.producto,
  pp.espejo_legacy,
  pp.suma_por_sucursal,
  pp.suma_por_sucursal - pp.espejo_legacy AS diferencia,
  pp.sucursales,
  pp.variantes,
  pp.filas_iguales_al_espejo AS sucursales_con_la_misma_cantidad
FROM por_producto pp
JOIN "tenants" t ON t."id" = pp."tenantId"
WHERE pp.suma_por_sucursal <> pp.espejo_legacy
ORDER BY (pp.suma_por_sucursal - pp.espejo_legacy) DESC, t."name", pp.sku
LIMIT 200;

\echo ''
\echo '== 2. Filas sembradas por el motor, no por un alta ni por la migración =='
\echo '   Se crearon con existencia distinta de cero pero no tienen NINGÚN'
\echo '   movimiento de entrada que la explique: la cantidad salió del espejo'
\echo '   legacy en el momento en que el motor necesitó la fila.'
\echo ''

SELECT
  t."name"  AS empresa,
  b."name"  AS sucursal,
  p."sku",
  p."name"  AS producto,
  COALESCE(v."name", '(sin variante)') AS variante,
  bi."stock" AS existencia_actual,
  bi."updatedAt"
FROM "branch_inventory" bi
JOIN "products" p        ON p."id" = bi."productId"
JOIN "product_variants" v ON v."id" = bi."variantId"
JOIN "branches" b        ON b."id" = bi."branchId"
JOIN "tenants" t         ON t."id" = p."tenantId"
WHERE bi."stock" > 0
  AND NOT EXISTS (
    SELECT 1 FROM "inventory_movements" m
    WHERE m."productId" = p."id"
      AND m."branchId"  = b."id"
      AND m."type" IN ('COMPRA', 'AJUSTE', 'DEVOLUCION', 'TRANSFERENCIA')
  )
ORDER BY bi."stock" DESC, t."name", p."sku"
LIMIT 200;

\echo ''
\echo '== 3. Resumen por empresa: cuánto inventario está en disputa =='
\echo ''

SELECT
  t."name" AS empresa,
  COUNT(DISTINCT b."id")                            AS sucursales,
  COUNT(DISTINCT p."id")                            AS productos,
  SUM(bi."stock")                                   AS unidades_por_sucursal,
  (SELECT SUM(p2."stock") FROM "products" p2 WHERE p2."tenantId" = t."id") AS unidades_espejo_legacy
FROM "tenants" t
JOIN "products" p         ON p."tenantId" = t."id"
JOIN "branch_inventory" bi ON bi."productId" = p."id"
JOIN "branches" b         ON b."id" = bi."branchId"
GROUP BY t."id", t."name"
HAVING SUM(bi."stock") <> (SELECT COALESCE(SUM(p2."stock"), 0) FROM "products" p2 WHERE p2."tenantId" = t."id")
ORDER BY SUM(bi."stock") DESC;
