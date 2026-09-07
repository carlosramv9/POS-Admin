-- ============================================================================
-- Fase 2 — invariante de la variante default en la base.
--
-- La default es, por definición, la línea implícita "el producto en sí": no
-- tiene nombre. Al configurar la primera presentación se PROMUEVE a ella
-- (ADR-0030, regla 4): se renombra y deja de ser default, conservando id,
-- existencias e historial.
--
-- El índice único parcial `product_variants_default_per_product` ya garantiza
-- "como mucho una default por producto". Falta la otra mitad: que una variante
-- con nombre no pueda seguir marcada como default. Sin ella, una promoción a
-- medias (renombrar sin bajar `isDefault`) dejaba una presentación que además
-- se comportaba como la línea contra la que se descuenta todo por omisión, y
-- eso solo se nota al cuadrar el inventario.
--
-- "Al menos una variante por producto" no es expresable como CHECK; lo cubre el
-- servicio (la última presentación que se quita se degrada de vuelta a default,
-- nunca se borra) más su test de invariante.
-- ============================================================================

-- Saneo previo: si alguna fila viola el invariante, la promoción quedó a medias
-- y la forma correcta es dejarla como presentación —tiene nombre— y no como
-- default. No se borra nada.
UPDATE "product_variants"
SET "isDefault" = false
WHERE "isDefault" AND "name" IS NOT NULL;

ALTER TABLE "product_variants"
  ADD CONSTRAINT "product_variants_default_has_no_name"
  CHECK ("isDefault" = false OR "name" IS NULL);
