-- ============================================================
-- Migration 081: Backfill and auto-link wms_catalog.product_id
--
-- Migration 043 introduced the wms_catalog.product_id FK that carries a
-- warehouse dispatch through to a shop's product_stock. Its backfill ran
-- once, at apply time, when every wms_* table was empty in production. Any
-- warehouse catalogue populated AFTER 043 landed therefore drifted: rows
-- were inserted with product_id NULL and stayed that way, and every
-- Internal-Shop dispatch of those items silently skipped the retail credit
-- (create_wms_dispatch line: `IF v_product_id IS NOT NULL THEN`). Warehouse
-- stock fell, shop stock did not rise, and nothing surfaced the mismatch.
--
-- Observed on Chichi's Bakes (org 241581b1-…): 1,323 catalogue rows, 0
-- linked, three dispatches to Town Shop that produced zero product_stock
-- change. Reported by Chilufya 2026-08-14.
--
-- This migration does two things:
--
--   1. One-off backfill: link every wms_catalog row whose sku matches a
--      products.inventory_id in the same org. Only fills where product_id
--      IS NULL, so it's safe to re-run.
--
--   2. Two triggers keep the link populated going forward:
--        a. AFTER INSERT OR UPDATE OF sku ON wms_catalog — sets the row's
--           product_id from a matching product on insert or on a SKU change.
--        b. AFTER INSERT OR UPDATE OF inventory_id ON products — updates
--           any wms_catalog row whose sku now matches (or newly matches).
--
-- Both directions are needed because either table can be populated first:
-- the owner may upload the warehouse catalogue before creating retail
-- products, or vice versa.
--
-- The triggers only WRITE product_id where it is currently NULL or where
-- the match changes, so they cannot flip an existing link to a different
-- product silently. If a SKU or inventory_id is edited to no longer match,
-- the link is cleared — a stale link would be worse than none, since it
-- would credit stock to a wrong product on the next dispatch.
--
-- Reconciliation of the historical dispatches that already ran without a
-- retail credit is NOT part of this migration; it is a data mutation for
-- specific rows and is applied via scripts/reconcile-past-dispatches.mjs.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Backfill
-- ------------------------------------------------------------
UPDATE wms_catalog c
   SET product_id = p.id
  FROM products p
 WHERE p.org_id = c.org_id
   AND p.inventory_id = c.sku
   AND c.product_id IS NULL;

-- ------------------------------------------------------------
-- 2a. Trigger on wms_catalog: link on insert or SKU change
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION wms_catalog_autolink_product()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_product_id UUID;
BEGIN
  SELECT id INTO v_product_id
    FROM products
   WHERE org_id = NEW.org_id
     AND inventory_id = NEW.sku
   LIMIT 1;

  NEW.product_id := v_product_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wms_catalog_autolink ON wms_catalog;
CREATE TRIGGER trg_wms_catalog_autolink
  BEFORE INSERT OR UPDATE OF sku ON wms_catalog
  FOR EACH ROW
  EXECUTE FUNCTION wms_catalog_autolink_product();

-- ------------------------------------------------------------
-- 2b. Trigger on products: link matching wms_catalog rows when
--     inventory_id becomes (or changes to) a value that matches.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION products_autolink_wms_catalog()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Link the new inventory_id.
  UPDATE wms_catalog
     SET product_id = NEW.id
   WHERE org_id = NEW.org_id
     AND sku = NEW.inventory_id
     AND (product_id IS NULL OR product_id = NEW.id);

  -- If inventory_id changed, unlink rows that used to point at us via the
  -- old SKU so a future dispatch does not credit stock through a stale link.
  IF TG_OP = 'UPDATE' AND OLD.inventory_id IS DISTINCT FROM NEW.inventory_id THEN
    UPDATE wms_catalog
       SET product_id = NULL
     WHERE org_id = NEW.org_id
       AND sku = OLD.inventory_id
       AND product_id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_products_autolink_wms ON products;
CREATE TRIGGER trg_products_autolink_wms
  AFTER INSERT OR UPDATE OF inventory_id ON products
  FOR EACH ROW
  EXECUTE FUNCTION products_autolink_wms_catalog();

COMMIT;

-- ============================================================
-- VERIFY (run separately)
--
-- 1. Backfill count: no unlinked rows remain where a match exists.
--
--   SELECT c.org_id, COUNT(*) FILTER (WHERE c.product_id IS NULL AND p.id IS NOT NULL) AS still_unlinked_with_match
--   FROM wms_catalog c
--   LEFT JOIN products p ON p.org_id = c.org_id AND p.inventory_id = c.sku
--   GROUP BY c.org_id;
--   -- expect still_unlinked_with_match = 0 for every org.
--
-- 2. Trigger fires on new wms_catalog insert:
--
--   INSERT INTO wms_catalog (org_id, sku, item_name, category, pack_size)
--   VALUES ('<org>', '<sku that exists as inventory_id>', 'x', 'x', 1)
--   RETURNING product_id;   -- must be non-NULL
--
-- 3. Trigger fires on new product with matching sku already in wms_catalog:
--
--   INSERT INTO products (org_id, inventory_id, name, ...)
--   VALUES ('<org>', '<sku>', ...);
--   SELECT product_id FROM wms_catalog WHERE org_id = '<org>' AND sku = '<sku>';
--   -- must equal the new product's id.
-- ============================================================
