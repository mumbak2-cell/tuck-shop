-- ============================================================
-- 087_wms_tier2_ledger_and_locations.sql
--
-- Tier 2 Phase 1 (part 1/3) — foundation schema.
--
-- Introduces
--   - stock_movements          append-only ledger, one row per stock event
--   - wms_locations            flat one-level bins/racks/zones per org
--   - trg_wms_ensure_main_loc  auto-seeds MAIN location on first
--                              wms_catalog row for an org
--
-- Behaviour change: none in this migration. Migration 088 reshapes
-- wms_inventory to point at locations; migration 089 rewires the
-- mutating RPCs to write ledger rows + honour location_id.
--
-- The ledger starts empty. Historical movement is unrecoverable —
-- pre-Tier-2 mutations wrote quantity in place with no event log,
-- which is exactly the problem this ledger solves for the future.
--
-- Backfill (this migration): seed a MAIN location for every org
-- that already has any wms_catalog row (i.e. WMS-active orgs). New
-- orgs get MAIN auto-seeded on their first wms_catalog insert by
-- the trigger below.
--
-- Idempotent. Safe to re-run.
--
-- After applying via Supabase SQL Editor, record with:
--   node node_modules/supabase/dist/supabase.js migration repair \
--     --status applied 087
-- ============================================================

-- ------------------------------------------------------------
-- 1. wms_locations — flat one-level bins/racks/zones
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wms_locations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code       TEXT NOT NULL,           -- e.g. 'MAIN', 'A-01-03'
  label      TEXT NOT NULL,           -- human name
  kind       TEXT NOT NULL DEFAULT 'bin'
             CHECK (kind IN ('rack','bin','zone','staging')),
  capacity   INT,                     -- max units; NULL = unlimited
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, code)
);

CREATE INDEX IF NOT EXISTS idx_wms_locations_org        ON wms_locations(org_id);
CREATE INDEX IF NOT EXISTS idx_wms_locations_org_active ON wms_locations(org_id) WHERE active = TRUE;

ALTER TABLE wms_locations
  ALTER COLUMN org_id SET DEFAULT default_user_org_id();

ALTER TABLE wms_locations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wms_locations_org_read"  ON wms_locations;
DROP POLICY IF EXISTS "wms_locations_org_write" ON wms_locations;

CREATE POLICY "wms_locations_org_read" ON wms_locations FOR SELECT
  USING (org_id IN (SELECT current_user_org_ids()));

-- Owners + admins with manage_warehouse may create/edit bins.
-- Writes are further constrained to writable orgs (trial/subscription
-- gate) via current_user_writable_org_ids().
CREATE POLICY "wms_locations_org_write" ON wms_locations FOR ALL
  USING      (org_id IN (SELECT current_user_writable_org_ids()))
  WITH CHECK (org_id IN (SELECT current_user_writable_org_ids()));

-- ------------------------------------------------------------
-- 2. Backfill: MAIN location per WMS-active org.
--    Only orgs that already have wms_catalog rows are considered
--    "WMS-active". Others get MAIN when they first insert into
--    wms_catalog (trigger below).
-- ------------------------------------------------------------
INSERT INTO wms_locations (org_id, code, label, kind, active)
SELECT DISTINCT c.org_id, 'MAIN', 'Main Warehouse', 'staging', TRUE
  FROM wms_catalog c
  LEFT JOIN wms_locations l
    ON l.org_id = c.org_id AND l.code = 'MAIN'
 WHERE l.id IS NULL
ON CONFLICT (org_id, code) DO NOTHING;

-- ------------------------------------------------------------
-- 3. Trigger: ensure MAIN location exists on first wms_catalog
--    insert for an org. Same shape as the wms_stock_count_sessions
--    autocreate trigger from migration 086.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION ensure_wms_main_location()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.org_id IS NULL THEN
    RETURN NEW;   -- default_user_org_id() will fill it via column default; nothing to do
  END IF;

  INSERT INTO wms_locations (org_id, code, label, kind, active)
  VALUES (NEW.org_id, 'MAIN', 'Main Warehouse', 'staging', TRUE)
  ON CONFLICT (org_id, code) DO NOTHING;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION ensure_wms_main_location() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_wms_catalog_ensure_main_loc ON wms_catalog;

CREATE TRIGGER trg_wms_catalog_ensure_main_loc
  BEFORE INSERT ON wms_catalog
  FOR EACH ROW
  EXECUTE FUNCTION ensure_wms_main_location();

-- ------------------------------------------------------------
-- 4. stock_movements — append-only ledger
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_movements (
  id             BIGSERIAL PRIMARY KEY,
  org_id         UUID    NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  wms_item_id    BIGINT  NOT NULL REFERENCES wms_catalog(id)   ON DELETE RESTRICT,
  location_id    UUID    REFERENCES wms_locations(id)          ON DELETE RESTRICT,
    -- location_id is nullable ONLY to permit rows written between 087 and 088
    -- (there won't be any — 089 is the RPC rewrite; ledger writes start there).
    -- 088 does NOT add a NOT NULL constraint (would require backfill against
    -- an empty table anyway); 089 writes MAIN for callers that don't specify.
  qty_delta      INT     NOT NULL,   -- signed: +receipt, -dispatch, ±adjust
  cost_per_unit  NUMERIC(12,2),      -- nullable; adjustments may lack cost
  movement_type  TEXT    NOT NULL CHECK (movement_type IN (
    'receipt','dispatch','adjust','count_apply','transfer_out','transfer_in'
  )),
  ref_table      TEXT,               -- source doc table (e.g. 'wms_receipts')
  ref_id         BIGINT,             -- source doc id (numeric ids only)
  actor_user_id  UUID,               -- auth.uid() at emission
  notes          TEXT,
  at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_org_item_at
  ON stock_movements (org_id, wms_item_id, at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_movements_org_at
  ON stock_movements (org_id, at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_movements_ref
  ON stock_movements (ref_table, ref_id)
  WHERE ref_table IS NOT NULL AND ref_id IS NOT NULL;

ALTER TABLE stock_movements
  ALTER COLUMN org_id SET DEFAULT default_user_org_id();

ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;

-- Append-only: SELECT via RLS, NO client INSERT/UPDATE/DELETE policies.
-- Writes come only from SECURITY DEFINER RPCs (added in migration 089)
-- and service-role.
DROP POLICY IF EXISTS "stock_movements_org_read" ON stock_movements;
CREATE POLICY "stock_movements_org_read" ON stock_movements FOR SELECT
  USING (org_id IN (SELECT current_user_org_ids()));

-- ============================================================
-- Verification (run manually in SQL Editor after applying)
-- ============================================================
-- -- 1. Tables + trigger exist:
-- SELECT 'wms_locations',   EXISTS (SELECT 1 FROM information_schema.tables
--                                    WHERE table_schema='public' AND table_name='wms_locations')::text UNION ALL
-- SELECT 'stock_movements', EXISTS (SELECT 1 FROM information_schema.tables
--                                    WHERE table_schema='public' AND table_name='stock_movements')::text UNION ALL
-- SELECT 'trg_wms_catalog_ensure_main_loc',
--        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_wms_catalog_ensure_main_loc')::text;
-- -- Expect: three rows, all 'true'.
--
-- -- 2. MAIN backfill covered every WMS-active org:
-- SELECT COUNT(*) AS orgs_missing_main
--   FROM (SELECT DISTINCT org_id FROM wms_catalog) c
--  WHERE NOT EXISTS (
--    SELECT 1 FROM wms_locations l
--     WHERE l.org_id = c.org_id AND l.code = 'MAIN'
--  );
-- -- Expect: 0.
--
-- -- 3. Trigger fires on new catalog inserts:
-- --   For an org that has NO wms_locations, insert a wms_catalog row and
-- --   confirm MAIN appears in wms_locations for that org immediately.
-- --   (Skip if no such org exists; the backfill already covered all
-- --    WMS-active orgs.)
--
-- -- 4. RLS shape:
-- SELECT tablename, policyname, cmd
--   FROM pg_policies
--  WHERE schemaname='public' AND tablename IN ('wms_locations','stock_movements')
--  ORDER BY tablename, policyname;
-- -- Expect: wms_locations has read + write policies;
-- --         stock_movements has only the read policy (append-only).
