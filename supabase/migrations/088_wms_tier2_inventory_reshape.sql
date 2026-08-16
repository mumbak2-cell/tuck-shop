-- ============================================================
-- 088_wms_tier2_inventory_reshape.sql
--
-- Tier 2 Phase 1 (part 2/3) — inventory reshape for bins + avg cost.
--
-- Changes
--   - wms_inventory.location_id  NEW column, backfilled to each org's
--     MAIN location, then set NOT NULL. Unique reshaped from
--     (org_id, wms_item_id) → (org_id, wms_item_id, location_id).
--   - wms_inventory.avg_cost     NEW column, NULL for pre-Tier2 rows.
--                                Migration 089's receive RPC populates.
--   - wms_catalog.default_location_id  NEW column, optional. Frontend
--                                putaway defaults to it when set.
--   - wms_inventory_by_item      NEW regular VIEW summing qty across
--                                bins per (org, item). Regular view
--                                is always correct without refresh
--                                cadence (see design note below).
--
-- CRITICAL — apply 089 in the SAME SQL Editor session
-- ----------------------------------------------------
-- Dropping the (org_id, wms_item_id) unique breaks every existing
-- ON CONFLICT clause in receive_wms_stock, receive_wms_purchase_order,
-- and any other RPC that upserts by that pair. Migration 089 rewrites
-- those RPCs to use (org_id, wms_item_id, location_id). If 088 lands
-- without 089 following immediately, EVERY WMS stock write fails.
--
-- Depends on 087 (wms_locations must exist and be backfilled).
--
-- Idempotent. Safe to re-run.
--
-- Design note — regular view vs materialised
-- ------------------------------------------
-- REFRESH MATERIALIZED VIEW CONCURRENTLY cannot run inside a trigger
-- (needs its own transaction). Non-concurrent REFRESH holds an
-- ACCESS EXCLUSIVE lock during the rebuild, blocking every reader
-- and colliding with WMS mutations under load. So while the plan
-- called for "trigger for correctness", the safest way to deliver
-- correctness IS a regular view — always fresh, no refresh cadence
-- to argue about, no deadlock surface. If the view becomes hot (a
-- large-catalog org's dashboard is measurably slow), swap it for a
-- denormalised column on wms_catalog maintained by a trigger on
-- wms_inventory UPDATE — a mechanical change with no frontend impact.
--
-- Record with:
--   node node_modules/supabase/dist/supabase.js migration repair \
--     --status applied 088
-- ============================================================

-- ------------------------------------------------------------
-- 1. Add new columns (nullable).
-- ------------------------------------------------------------
ALTER TABLE wms_inventory
  ADD COLUMN IF NOT EXISTS location_id UUID,
  ADD COLUMN IF NOT EXISTS avg_cost    NUMERIC(12,2);

ALTER TABLE wms_catalog
  ADD COLUMN IF NOT EXISTS default_location_id UUID;

-- ------------------------------------------------------------
-- 2. Backfill location_id → each org's MAIN.
-- ------------------------------------------------------------
UPDATE wms_inventory i
   SET location_id = l.id
  FROM wms_locations l
 WHERE i.location_id IS NULL
   AND l.org_id = i.org_id
   AND l.code   = 'MAIN';

-- Safety: any inventory rows still NULL after backfill mean an org has
-- no MAIN — should be impossible (087 seeded + trigger), but guard.
DO $$
DECLARE v_orphans INT;
BEGIN
  SELECT COUNT(*) INTO v_orphans FROM wms_inventory WHERE location_id IS NULL;
  IF v_orphans > 0 THEN
    RAISE EXCEPTION 'Migration 088 aborted: % wms_inventory rows have no MAIN location — check migration 087 backfill', v_orphans;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 3. NOT NULL + FKs.
-- ------------------------------------------------------------
ALTER TABLE wms_inventory
  ALTER COLUMN location_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'wms_inventory_location_id_fkey'
       AND conrelid = 'public.wms_inventory'::regclass
  ) THEN
    ALTER TABLE wms_inventory
      ADD CONSTRAINT wms_inventory_location_id_fkey
      FOREIGN KEY (location_id) REFERENCES wms_locations(id) ON DELETE RESTRICT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'wms_catalog_default_location_id_fkey'
       AND conrelid = 'public.wms_catalog'::regclass
  ) THEN
    ALTER TABLE wms_catalog
      ADD CONSTRAINT wms_catalog_default_location_id_fkey
      FOREIGN KEY (default_location_id) REFERENCES wms_locations(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 4. Unique reshape: (org, item) → (org, item, location)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_old_conname TEXT;
BEGIN
  SELECT conname INTO v_old_conname
    FROM pg_constraint
   WHERE conrelid = 'public.wms_inventory'::regclass
     AND contype  = 'u'
     AND pg_get_constraintdef(oid) = 'UNIQUE (org_id, wms_item_id)';

  IF v_old_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE wms_inventory DROP CONSTRAINT %I', v_old_conname);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'wms_inventory_org_item_location_key'
       AND conrelid = 'public.wms_inventory'::regclass
  ) THEN
    ALTER TABLE wms_inventory
      ADD CONSTRAINT wms_inventory_org_item_location_key
      UNIQUE (org_id, wms_item_id, location_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_wms_inventory_location
  ON wms_inventory(location_id);

-- ------------------------------------------------------------
-- 5. wms_inventory_by_item — regular view (always fresh).
--    Sums qty across bins per (org, item). Callers reading
--    org-wide item quantity (dashboard, reorder alerts, dead-
--    stock reports) hit this view instead of wms_inventory
--    directly.
-- ------------------------------------------------------------
DROP VIEW IF EXISTS wms_inventory_by_item;

CREATE VIEW wms_inventory_by_item AS
SELECT org_id,
       wms_item_id,
       SUM(physical_qty)::INT AS physical_qty,
       -- Weighted average cost across bins; ignores rows without avg_cost
       -- (pre-Tier2). Bin-level moving averages live on wms_inventory.
       CASE
         WHEN SUM(CASE WHEN avg_cost IS NOT NULL THEN physical_qty ELSE 0 END) > 0
         THEN SUM(avg_cost * physical_qty) FILTER (WHERE avg_cost IS NOT NULL)
              / NULLIF(SUM(physical_qty) FILTER (WHERE avg_cost IS NOT NULL), 0)
         ELSE NULL
       END::NUMERIC(12,2) AS avg_cost,
       MAX(updated_at) AS updated_at
  FROM wms_inventory
 GROUP BY org_id, wms_item_id;

-- The view inherits RLS through the underlying table (wms_inventory
-- already has org_isolation policy). No separate policy needed.

-- ============================================================
-- Verification (run manually in SQL Editor after applying)
-- ============================================================
-- -- 1. New columns present:
-- SELECT 'wms_inventory.location_id',        EXISTS (SELECT 1 FROM information_schema.columns
--                                                     WHERE table_schema='public' AND table_name='wms_inventory' AND column_name='location_id')::text UNION ALL
-- SELECT 'wms_inventory.avg_cost',           EXISTS (SELECT 1 FROM information_schema.columns
--                                                     WHERE table_schema='public' AND table_name='wms_inventory' AND column_name='avg_cost')::text UNION ALL
-- SELECT 'wms_catalog.default_location_id',  EXISTS (SELECT 1 FROM information_schema.columns
--                                                     WHERE table_schema='public' AND table_name='wms_catalog' AND column_name='default_location_id')::text UNION ALL
-- SELECT 'wms_inventory_by_item view',       EXISTS (SELECT 1 FROM information_schema.views
--                                                     WHERE table_schema='public' AND table_name='wms_inventory_by_item')::text UNION ALL
-- SELECT 'unique (org,item,location)',       EXISTS (SELECT 1 FROM pg_constraint
--                                                     WHERE conrelid='public.wms_inventory'::regclass
--                                                       AND conname='wms_inventory_org_item_location_key')::text UNION ALL
-- SELECT 'old unique (org,item) dropped',    NOT EXISTS (SELECT 1 FROM pg_constraint
--                                                         WHERE conrelid='public.wms_inventory'::regclass
--                                                           AND contype='u'
--                                                           AND pg_get_constraintdef(oid)='UNIQUE (org_id, wms_item_id)')::text
--  ORDER BY 1;
-- -- Expect: 6 rows, every value 'true'.
--
-- -- 2. Zero inventory rows have NULL location_id:
-- SELECT COUNT(*) FROM wms_inventory WHERE location_id IS NULL;
-- -- Expect: 0.
--
-- -- 3. View returns something sane (pick any WMS-active org's id):
-- SELECT wms_item_id, physical_qty FROM wms_inventory_by_item WHERE org_id = '<ORG-UUID>' ORDER BY wms_item_id LIMIT 5;
-- -- Expect: per-item totals matching the sum of that item's rows in wms_inventory.
