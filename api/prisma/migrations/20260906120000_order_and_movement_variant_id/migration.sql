-- ============================================================================
-- Fase 1 — `variantId` en la cadena de venta, compra y movimientos.
--
-- Hasta ahora se sabía QUÉ producto se vendió, se compró o se movió, pero no
-- qué variante: `VariantInventoryResolver` resolvía siempre la `isDefault`, así
-- que vender una talla L descontaba de la línea "el producto en sí". Sin este
-- campo, el inventario por variante es inalcanzable desde el negocio y la
-- promoción de la default (ADR-0030, regla 4) no se puede implementar.
--
-- EXPAND, aditiva y revertible: la columna es NULLABLE y las filas históricas
-- se rellenan apuntando a la variante default de su producto. Pasarla a
-- NOT NULL es la fase contract, cuando todos los escritores la manden siempre.
--
-- `ON DELETE SET NULL` a propósito: borrar una variante no puede llevarse por
-- delante el historial de ventas ni el ledger de inventario. La línea queda
-- señalando su producto, que es exactamente lo que se sabía antes.
-- ============================================================================

-- ── 1. Columnas ─────────────────────────────────────────────────────────────
ALTER TABLE "order_items"                ADD COLUMN "variantId" TEXT;
ALTER TABLE "inventory_movements"        ADD COLUMN "variantId" TEXT;
ALTER TABLE "purchase_order_items"       ADD COLUMN "variantId" TEXT;
ALTER TABLE "purchase_receipt_items"     ADD COLUMN "variantId" TEXT;
ALTER TABLE "store_whatsapp_order_items" ADD COLUMN "variantId" TEXT;

-- ── 2. Backfill: la default del producto de cada fila ───────────────────────
-- Es la variante contra la que esas operaciones movieron el stock realmente,
-- así que el histórico queda fiel y no inventado.
UPDATE "order_items" oi
SET "variantId" = v."id"
FROM "product_variants" v
WHERE v."productId" = oi."productId" AND v."isDefault" AND oi."variantId" IS NULL;

UPDATE "inventory_movements" m
SET "variantId" = v."id"
FROM "product_variants" v
WHERE v."productId" = m."productId" AND v."isDefault" AND m."variantId" IS NULL;

UPDATE "purchase_order_items" poi
SET "variantId" = v."id"
FROM "product_variants" v
WHERE v."productId" = poi."productId" AND v."isDefault" AND poi."variantId" IS NULL;

UPDATE "purchase_receipt_items" pri
SET "variantId" = v."id"
FROM "product_variants" v
WHERE v."productId" = pri."productId" AND v."isDefault" AND pri."variantId" IS NULL;

UPDATE "store_whatsapp_order_items" swi
SET "variantId" = v."id"
FROM "product_variants" v
WHERE v."productId" = swi."productId" AND v."isDefault" AND swi."variantId" IS NULL;

-- ── 3. Claves foráneas ──────────────────────────────────────────────────────
ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "product_variants"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "inventory_movements"
  ADD CONSTRAINT "inventory_movements_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "product_variants"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "purchase_order_items"
  ADD CONSTRAINT "purchase_order_items_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "product_variants"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "purchase_receipt_items"
  ADD CONSTRAINT "purchase_receipt_items_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "product_variants"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "store_whatsapp_order_items"
  ADD CONSTRAINT "store_whatsapp_order_items_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "product_variants"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 4. Índices para las lecturas por variante ───────────────────────────────
-- Ventas y ledger por talla/presentación: sin índice, cada reporte por variante
-- sería un scan de la tabla entera.
CREATE INDEX "order_items_variantId_idx"          ON "order_items" ("variantId");
CREATE INDEX "inventory_movements_variantId_idx"  ON "inventory_movements" ("variantId");
