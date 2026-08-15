-- ============================================================
-- 083_wms_tier1_schema_additions.sql
--
-- Tier 1 schema additions (pure schema — no RPC changes).
--
-- Adds
--   - wms_catalog.barcode        (distinct from sku)
--   - wms_receipt_items.damage_qty, .tax_rate, .tax_amount
--   - wms_po_items.tax_rate, .tax_amount
--   - wms_adjustments.cost_price (optional; migration-068 pattern)
--   - wms_stock_count_sessions   (new table; hard-block freeze support)
--
-- Tightens
--   - Every child FK to wms_catalog(id) from ON DELETE CASCADE to
--     ON DELETE RESTRICT. Org-scoped cascades to organizations(id)
--     are intentional and kept.
--
-- Naming convention
--   VAT columns use tax_rate/tax_amount to match POS layer
--   (migrations 033, 064).
--
-- Idempotent. Safe to re-run.
--
-- After applying via Supabase SQL Editor, record with:
--   node node_modules/supabase/dist/supabase.js migration repair \
--     --status applied 083
-- ============================================================

-- ------------------------------------------------------------
-- 1. wms_catalog.barcode
-- ------------------------------------------------------------
ALTER TABLE wms_catalog
  ADD COLUMN IF NOT EXISTS barcode TEXT;

-- Partial unique index: only enforce when barcode is set.
CREATE UNIQUE INDEX IF NOT EXISTS uq_wms_catalog_barcode_per_org
  ON wms_catalog (org_id, barcode)
  WHERE barcode IS NOT NULL;

-- ------------------------------------------------------------
-- 2. wms_receipt_items: damage_qty + VAT
-- ------------------------------------------------------------
ALTER TABLE wms_receipt_items
  ADD COLUMN IF NOT EXISTS damage_qty INTEGER NOT NULL DEFAULT 0
    CHECK (damage_qty >= 0),
  ADD COLUMN IF NOT EXISTS tax_rate   NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(12,2);

-- ------------------------------------------------------------
-- 3. wms_po_items: VAT
-- ------------------------------------------------------------
ALTER TABLE wms_po_items
  ADD COLUMN IF NOT EXISTS tax_rate   NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(12,2);

-- ------------------------------------------------------------
-- 4. wms_adjustments: optional cost_price
-- ------------------------------------------------------------
ALTER TABLE wms_adjustments
  ADD COLUMN IF NOT EXISTS cost_price NUMERIC(12,2);

-- ------------------------------------------------------------
-- 5. wms_stock_count_sessions (freeze-during-count support)
-- ------------------------------------------------------------
-- One row per count session; wms_stock_counts.session_id references this
-- loosely (no FK — existing sessions predate the table). New sessions
-- created via UI/RPC must insert here first.
CREATE TABLE IF NOT EXISTS wms_stock_count_sessions (
  id         UUID PRIMARY KEY,
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  label      TEXT NOT NULL DEFAULT 'Stock Count',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at  TIMESTAMPTZ,
  is_frozen  BOOLEAN NOT NULL DEFAULT FALSE,
  frozen_at  TIMESTAMPTZ,
  created_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_wms_scs_org        ON wms_stock_count_sessions(org_id);
CREATE INDEX IF NOT EXISTS idx_wms_scs_org_active ON wms_stock_count_sessions(org_id) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_wms_scs_frozen     ON wms_stock_count_sessions(org_id) WHERE is_frozen = TRUE AND closed_at IS NULL;

ALTER TABLE wms_stock_count_sessions
  ALTER COLUMN org_id SET DEFAULT default_user_org_id();

ALTER TABLE wms_stock_count_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wms_scs_org_isolation" ON wms_stock_count_sessions;
CREATE POLICY "wms_scs_org_isolation" ON wms_stock_count_sessions FOR ALL
  USING      (org_id IN (SELECT current_user_org_ids()))
  WITH CHECK (org_id IN (SELECT current_user_org_ids()));

-- Backfill: create a session row for every historical distinct session_id.
-- Idempotent via ON CONFLICT.
INSERT INTO wms_stock_count_sessions (id, org_id, label, started_at, closed_at, is_frozen)
SELECT DISTINCT
       sc.session_id                              AS id,
       sc.org_id                                  AS org_id,
       COALESCE(MAX(sc.session_label), 'Stock Count') AS label,
       MIN(sc.counted_at)                         AS started_at,
       MAX(sc.counted_at)                         AS closed_at,   -- treat historical sessions as closed
       FALSE                                      AS is_frozen
  FROM wms_stock_counts sc
 GROUP BY sc.session_id, sc.org_id
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------
-- 6. FK cascade tightening
--    All foreign keys that reference wms_catalog(id) change from
--    ON DELETE CASCADE to ON DELETE RESTRICT.
--    Default Postgres naming: <table>_<column>_fkey.
-- ------------------------------------------------------------
DO $$
DECLARE
  fk RECORD;
  drop_sql TEXT;
  add_sql  TEXT;
BEGIN
  FOR fk IN
    SELECT conname   AS constraint_name,
           conrelid::regclass::text AS table_name,
           pg_get_constraintdef(oid)  AS def
      FROM pg_constraint
     WHERE contype = 'f'
       AND confrelid = 'public.wms_catalog'::regclass
       AND conrelid IN (
         'public.wms_receipt_items'::regclass,
         'public.wms_dispatch_items'::regclass,
         'public.wms_adjustments'::regclass,
         'public.wms_po_items'::regclass,
         'public.wms_stock_counts'::regclass,
         'public.wms_stock_count_audit'::regclass,
         'public.wms_inventory'::regclass
       )
       AND position('ON DELETE CASCADE' IN pg_get_constraintdef(oid)) > 0
  LOOP
    drop_sql := format('ALTER TABLE %s DROP CONSTRAINT %I',
                       fk.table_name, fk.constraint_name);
    add_sql  := format(
      'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (wms_item_id) '
      'REFERENCES wms_catalog(id) ON DELETE RESTRICT',
      fk.table_name, fk.constraint_name
    );
    EXECUTE drop_sql;
    EXECUTE add_sql;
    RAISE NOTICE 'Tightened FK % on % to RESTRICT', fk.constraint_name, fk.table_name;
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 7. Drop superseded RPC (backend agent finding, Medium severity)
--    adjust_wms_inventory was replaced by record_wms_adjustment in
--    migration 044 but never dropped. It writes no audit row.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.adjust_wms_inventory(UUID, BIGINT, INT, TEXT);

-- ============================================================
-- Verification (run manually in SQL Editor after applying)
-- ============================================================
-- -- New columns present:
-- SELECT column_name, data_type FROM information_schema.columns
--  WHERE table_schema='public'
--    AND (table_name, column_name) IN (
--      ('wms_catalog','barcode'),
--      ('wms_receipt_items','damage_qty'),
--      ('wms_receipt_items','tax_rate'),
--      ('wms_receipt_items','tax_amount'),
--      ('wms_po_items','tax_rate'),
--      ('wms_po_items','tax_amount'),
--      ('wms_adjustments','cost_price')
--    );
-- -- Expect 7 rows.
--
-- -- FK cascade sweep:
-- SELECT conrelid::regclass, conname,
--        position('ON DELETE RESTRICT' IN pg_get_constraintdef(oid)) > 0 AS restricted
--   FROM pg_constraint
--  WHERE contype='f'
--    AND confrelid='public.wms_catalog'::regclass;
-- -- Every restricted must be TRUE.
--
-- -- Session backfill sanity:
-- SELECT COUNT(*) FROM wms_stock_count_sessions;
-- SELECT COUNT(DISTINCT session_id) FROM wms_stock_counts;
-- -- The two counts must be equal.
