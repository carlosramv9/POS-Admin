-- ============================================================================
-- `sku` y `barcode` en la variante (ADR-0030).
--
-- La variante es la unidad vendible, así que los códigos van con ella: una
-- talla M y una L son artículos distintos al etiquetar, recibir y contar. Hasta
-- ahora el catálogo tenía UN solo código por producto, de modo que no había
-- forma de identificar una presentación concreta en la caja ni en un conteo.
--
-- Aditivo a propósito. `products.sku` NO se toca y sigue siendo el código
-- padre: lo usan la importación como llave, la búsqueda del POS, la
-- instantánea de `order_items.sku` y su índice único por tenant. Vacío aquí,
-- manda el del producto.
--
-- Sobre la unicidad: se pide "único por empresa", pero eso NO cabe en un índice
-- de esta tabla — `product_variants` no tiene `tenantId`, su dueño es el
-- producto, y Postgres no admite un índice único que cruce tablas. Se impone en
-- `ProductsService`, que responde 409 ante un duplicado. Los índices de abajo
-- existen para RESOLVER un escaneo rápido, no para restringir.
-- ============================================================================

ALTER TABLE "product_variants" ADD COLUMN "sku" TEXT;
ALTER TABLE "product_variants" ADD COLUMN "barcode" TEXT;

-- Búsqueda por código: es la ruta del escáner y del buscador del POS.
CREATE INDEX "product_variants_sku_idx" ON "product_variants" ("sku");
CREATE INDEX "product_variants_barcode_idx" ON "product_variants" ("barcode");
