-- ============================================================
-- Migration 096: wms_catalog name-match link + reconcile past dispatches
--
-- Problem
-- -------
-- create_wms_dispatch / ship_wms_dispatch only credit product_stock at
-- an Internal Shop destination when wms_catalog.product_id is set.
-- Migration 081's backfill + triggers link on SKU match only
-- (wms_catalog.sku = products.inventory_id), but inventory_id is
-- auto-generated (PRD0001, ...) and read-only in the product form,
-- while sku is user-entered -- they never match organically. Every
-- dispatch of an unlinked item silently skipped the retail credit.
-- Warehouse stock fell, shop stock never rose. Hit Chilufya's org
-- 3 times.
--
-- Why this migration has no BEGIN/COMMIT and no temp table
-- ----------------------------------------------------------
-- The Supabase SQL Editor does not guarantee that a pasted multi-
-- statement script runs on one connection/transaction. A first attempt
-- at this migration used BEGIN;/COMMIT; around a CREATE TEMP TABLE
-- staging step, and failed with "relation does not exist" on the very
-- table just created two statements earlier -- even after switching
-- from a TEMP table to a real one. That rules out session-scoping as
-- the cause: it means later statements in the same pasted script can
-- land on a different backend connection than earlier ones, so
-- anything created there (committed or not) may not be visible yet,
-- and the BEGIN/COMMIT text does not actually bind the statements
-- together. Nothing in this migration may depend on state created by
-- an earlier statement in the same script except real, committed
-- table data -- so instead of a scratch table, reconciliation state
-- is tracked in a real, permanent column
-- (wms_dispatch_items.reconciled_at, statement 1) that survives
-- regardless of which connection later statements land on.
--
-- Execution order
-- ----------------
-- Run these 7 statements ONE AT A TIME, in order, pasted and executed
-- individually in the SQL Editor. Order matters for statements 2-5:
-- mark already-credited items (2) BEFORE the backfill (3-4) BEFORE
-- reconciling newly-linked items (5), or the migration cannot tell
-- "was already linked and credited at dispatch time" apart from "was
-- unlinked and silently skipped".
--
--   1. Add wms_dispatch_items.reconciled_at (tracking column).
--   2. Mark dispatch items whose catalog item ALREADY has product_id
--      set (i.e. was already linked before this migration's backfill)
--      with the sentinel 1970-01-01 -- these were already credited by
--      the RPC at dispatch time and must never be credited again.
--   3. SKU backfill (re-run of 081, safe -- only fills NULLs).
--   4. Name backfill fallback -- ONLY when exactly one product name
--      matches (ambiguous matches are left unlinked on purpose).
--      products has no "active" column (001_create_tables.sql) -- use
--      "discontinued = false" instead.
--   5. Reconcile: credit product_stock for dispatch items that are
--      NOW linked (after 3-4) but were NOT marked already-credited in
--      step 2 -- these are exactly the ones that silently skipped the
--      credit. Marks them reconciled_at = NOW().
--   6. Backfill warehouse_cost_per_unit (095) for products reconciled
--      in step 5, from the latest dispatch's unit_cost. Excludes
--      already-credited items (their cost was already written
--      correctly by the original dispatch RPC).
--   7. Replace both triggers from 081 with versions that also try the
--      name match, and unlink stale name matches the same way the
--      existing trigger already unlinks stale SKU matches.
--
-- Idempotent throughout -- safe to re-run any statement. Statement 2's
-- WHERE di.reconciled_at IS NULL and statement 5's WHERE
-- di.reconciled_at IS NULL both prevent double-crediting on a re-run.
--
-- Depends on: 043 (wms_catalog.product_id, create_wms_dispatch),
-- 081 (original triggers being replaced), 089 (unit_cost column),
-- 091 (packed_qty column, Received status), 095 (warehouse_cost_per_unit).
--
-- Record with (after all 7 statements have been run):
--   node node_modules/supabase/dist/supabase.js migration repair \
--     --status applied 096
-- ============================================================


-- ============================================================
-- STATEMENT 1: Add reconciliation tracking column
-- ============================================================

-- Track which dispatch items have been reconciled to prevent double-crediting.
-- NULL = not yet processed by reconciliation.
-- '1970-01-01' sentinel = was already credited at dispatch time (product_id
--   was set before the backfill, so the RPC already called
--   add_product_stock_at_location).
-- Any real timestamp = reconciled by this migration.
ALTER TABLE wms_dispatch_items
  ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ;


-- ============================================================
-- STATEMENT 2: Mark already-credited dispatch items
-- MUST run BEFORE statements 3-5.
-- ============================================================

UPDATE wms_dispatch_items di
   SET reconciled_at = '1970-01-01T00:00:00Z'
  FROM wms_dispatches d
  JOIN wms_catalog c ON c.org_id = d.org_id
 WHERE d.id = di.dispatch_id
   AND c.id = di.wms_item_id
   AND d.destination_type = 'Internal Shop'
   AND d.status IN ('Dispatched', 'Shipped', 'Received')
   AND c.product_id IS NOT NULL
   AND di.reconciled_at IS NULL;


-- ============================================================
-- STATEMENT 3: SKU backfill (case-insensitive, trimmed)
-- ============================================================

UPDATE wms_catalog c
   SET product_id = p.id
  FROM products p
 WHERE p.org_id = c.org_id
   AND LOWER(TRIM(p.inventory_id)) = LOWER(TRIM(c.sku))
   AND c.product_id IS NULL;


-- ============================================================
-- STATEMENT 4: Name backfill (unambiguous matches only)
-- Only links when exactly one non-discontinued product matches the
-- catalog item name. Ambiguous matches (2+ products with the same
-- name) are skipped -- those need manual linking.
-- ============================================================

UPDATE wms_catalog c
   SET product_id = sub.product_id
  FROM (
    SELECT c2.id AS catalog_id, MIN(p2.id::text)::uuid AS product_id
      FROM wms_catalog c2
      JOIN products p2
        ON p2.org_id = c2.org_id
       AND LOWER(TRIM(p2.name)) = LOWER(TRIM(c2.item_name))
     WHERE c2.product_id IS NULL
       AND p2.discontinued = false
     GROUP BY c2.id
    HAVING COUNT(*) = 1
  ) sub
 WHERE c.id = sub.catalog_id
   AND c.product_id IS NULL;


-- ============================================================
-- STATEMENT 5: Reconcile -- credit product_stock for past skipped
-- dispatches. Uses a writable CTE chain (single statement, single
-- round trip -- no dependency on any other statement's connection).
--
-- After the backfill (3-4), items that are NOW linked but were NOT
-- marked in statement 2 are exactly the ones that were unlinked at
-- dispatch time -- their dispatches silently skipped the credit.
-- ============================================================

WITH items_to_credit AS (
  SELECT di.id AS dispatch_item_id,
         c.product_id,
         d.destination_location_id,
         d.org_id,
         COALESCE(di.packed_qty, di.qty_sent) AS credit_qty,
         di.unit_cost
    FROM wms_dispatch_items di
    JOIN wms_dispatches d ON d.id = di.dispatch_id
    JOIN wms_catalog c ON c.id = di.wms_item_id AND c.org_id = d.org_id
   WHERE d.destination_type = 'Internal Shop'
     AND d.destination_location_id IS NOT NULL
     AND d.status IN ('Dispatched', 'Shipped', 'Received')
     AND c.product_id IS NOT NULL
     AND di.reconciled_at IS NULL
),
grouped AS (
  SELECT product_id, destination_location_id, org_id,
         SUM(credit_qty) AS total_qty
    FROM items_to_credit
   GROUP BY product_id, destination_location_id, org_id
),
do_credit AS (
  INSERT INTO product_stock (product_id, location_id, org_id, quantity)
  SELECT product_id, destination_location_id, org_id, total_qty
    FROM grouped
  ON CONFLICT (product_id, location_id)
  DO UPDATE SET quantity = product_stock.quantity + EXCLUDED.quantity,
                last_updated = NOW()
  RETURNING product_id, location_id
)
UPDATE wms_dispatch_items di
   SET reconciled_at = NOW()
  FROM items_to_credit itc
 WHERE di.id = itc.dispatch_item_id;


-- ============================================================
-- STATEMENT 6: Update warehouse_cost_per_unit for reconciled products
-- Uses the latest dispatch's unit_cost per product. Only for items
-- reconciled BY THIS migration (reconciled_at > 1970-01-02) --
-- already-credited items already had their cost written correctly by
-- the original dispatch RPC and must not be overwritten here.
-- ============================================================

UPDATE products p
   SET warehouse_cost_per_unit = sub.latest_cost
  FROM (
    SELECT DISTINCT ON (c.product_id)
           c.product_id,
           di.unit_cost AS latest_cost
      FROM wms_dispatch_items di
      JOIN wms_dispatches d ON d.id = di.dispatch_id
      JOIN wms_catalog c ON c.id = di.wms_item_id AND c.org_id = d.org_id
     WHERE d.destination_type = 'Internal Shop'
       AND c.product_id IS NOT NULL
       AND di.unit_cost IS NOT NULL
       AND di.reconciled_at IS NOT NULL
       AND di.reconciled_at > '1970-01-02'  -- only items reconciled by THIS migration
     ORDER BY c.product_id, di.dispatch_id DESC
  ) sub
 WHERE p.id = sub.product_id
   AND p.warehouse_cost_per_unit IS DISTINCT FROM sub.latest_cost;


-- ============================================================
-- STATEMENT 7: Improved triggers (SKU + name matching)
-- ============================================================

-- Trigger on wms_catalog: link on insert or SKU/name change
CREATE OR REPLACE FUNCTION wms_catalog_autolink_product()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_product_id UUID;
  v_count      INT;
BEGIN
  -- Priority 1: SKU match (case-insensitive, trimmed)
  SELECT id INTO v_product_id
    FROM products
   WHERE org_id = NEW.org_id
     AND LOWER(TRIM(inventory_id)) = LOWER(TRIM(NEW.sku))
   LIMIT 1;

  -- Priority 2: Name match (only if unambiguous)
  IF v_product_id IS NULL THEN
    SELECT COUNT(*) INTO v_count
      FROM products
     WHERE org_id = NEW.org_id
       AND LOWER(TRIM(name)) = LOWER(TRIM(NEW.item_name))
       AND discontinued = false;

    IF v_count = 1 THEN
      SELECT id INTO v_product_id
        FROM products
       WHERE org_id = NEW.org_id
         AND LOWER(TRIM(name)) = LOWER(TRIM(NEW.item_name))
         AND discontinued = false;
    END IF;
  END IF;

  NEW.product_id := v_product_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wms_catalog_autolink ON wms_catalog;
CREATE TRIGGER trg_wms_catalog_autolink
  BEFORE INSERT OR UPDATE OF sku, item_name ON wms_catalog
  FOR EACH ROW
  EXECUTE FUNCTION wms_catalog_autolink_product();

-- Trigger on products: link matching wms_catalog rows
CREATE OR REPLACE FUNCTION products_autolink_wms_catalog()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- SKU match
  UPDATE wms_catalog
     SET product_id = NEW.id
   WHERE org_id = NEW.org_id
     AND LOWER(TRIM(sku)) = LOWER(TRIM(NEW.inventory_id))
     AND (product_id IS NULL OR product_id = NEW.id);

  -- Name match (only unambiguous, only unlinked)
  IF (SELECT COUNT(*) FROM products
       WHERE org_id = NEW.org_id
         AND LOWER(TRIM(name)) = LOWER(TRIM(NEW.name))
         AND discontinued = false) = 1 THEN
    UPDATE wms_catalog
       SET product_id = NEW.id
     WHERE org_id = NEW.org_id
       AND LOWER(TRIM(item_name)) = LOWER(TRIM(NEW.name))
       AND product_id IS NULL;
  END IF;

  -- Unlink stale SKU matches on inventory_id change
  IF TG_OP = 'UPDATE' AND OLD.inventory_id IS DISTINCT FROM NEW.inventory_id THEN
    UPDATE wms_catalog
       SET product_id = NULL
     WHERE org_id = NEW.org_id
       AND LOWER(TRIM(sku)) = LOWER(TRIM(OLD.inventory_id))
       AND product_id = NEW.id;
  END IF;

  -- Unlink stale name matches on name change
  IF TG_OP = 'UPDATE' AND LOWER(TRIM(OLD.name)) IS DISTINCT FROM LOWER(TRIM(NEW.name)) THEN
    UPDATE wms_catalog
       SET product_id = NULL
     WHERE org_id = NEW.org_id
       AND LOWER(TRIM(item_name)) = LOWER(TRIM(OLD.name))
       AND product_id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_products_autolink_wms ON products;
CREATE TRIGGER trg_products_autolink_wms
  AFTER INSERT OR UPDATE OF inventory_id, name ON products
  FOR EACH ROW
  EXECUTE FUNCTION products_autolink_wms_catalog();


-- ============================================================
-- VERIFY (run after all 7 statements):
--
-- 1. How many catalog items linked vs still unlinked?
--   SELECT
--     COUNT(*) FILTER (WHERE product_id IS NOT NULL) AS linked,
--     COUNT(*) FILTER (WHERE product_id IS NULL) AS still_unlinked,
--     COUNT(*) AS total
--   FROM wms_catalog;
--
-- 2. How many dispatch items were reconciled by this migration?
--   SELECT
--     COUNT(*) FILTER (WHERE reconciled_at IS NOT NULL AND reconciled_at > '1970-01-02') AS reconciled_by_096,
--     COUNT(*) FILTER (WHERE reconciled_at = '1970-01-01') AS already_credited,
--     COUNT(*) FILTER (WHERE reconciled_at IS NULL) AS unprocessed
--   FROM wms_dispatch_items di
--   JOIN wms_dispatches d ON d.id = di.dispatch_id
--   WHERE d.destination_type = 'Internal Shop';
--
-- 3. Still-unlinked items that have NO matching product (need manual link or product creation):
--   SELECT c.org_id, c.id, c.sku, c.item_name
--     FROM wms_catalog c
--    WHERE c.product_id IS NULL
--    ORDER BY c.org_id, c.item_name;
--
-- 4. Chilufya's org link status:
--   SELECT COUNT(*) FILTER (WHERE product_id IS NULL) AS unlinked,
--          COUNT(*) FILTER (WHERE product_id IS NOT NULL) AS linked,
--          COUNT(*) AS total
--     FROM wms_catalog
--    WHERE org_id = '241581b1-534f-40f1-92c0-6df189fc47cc';
--
-- 5. Reconciled stock at Chilufya's org:
--   SELECT p.name, ps.quantity, l.name AS location
--     FROM product_stock ps
--     JOIN products p ON p.id = ps.product_id
--     JOIN locations l ON l.id = ps.location_id
--    WHERE ps.org_id = '241581b1-534f-40f1-92c0-6df189fc47cc'
--    ORDER BY p.name;
-- ============================================================
