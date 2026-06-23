-- ============================================================
-- Migration 026: Stock counts per-location (Slice 5 Phase 5c-2)
--
-- A stock count now belongs to a specific location. Without this,
-- counting a product at Main Shop and Branch 2 in the same session
-- collides on the (session_id, product_id) unique constraint.
--
-- Architecture:
--   - stock_counts gains location_id (NOT NULL after backfill)
--   - stock_count_audit gains location_id for trace fidelity
--   - Unique constraint moves to (session_id, product_id, location_id)
--   - Existing rows are backfilled to each org's Main Shop
--   - RLS scopes reads/writes to locations the user can see
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Add columns (nullable for now to allow backfill)
-- ------------------------------------------------------------

ALTER TABLE stock_counts
  ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id) ON DELETE RESTRICT;

ALTER TABLE stock_count_audit
  ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id) ON DELETE RESTRICT;

-- ------------------------------------------------------------
-- 2. Backfill: every existing stock_count row gets the Main Shop
--    location for its org. Inherits via the product's org_id.
-- ------------------------------------------------------------

UPDATE stock_counts sc
SET location_id = l.id
FROM products p
JOIN locations l ON l.org_id = p.org_id AND l.name = 'Main Shop'
WHERE sc.product_id = p.id AND sc.location_id IS NULL;

-- Same for audit rows
UPDATE stock_count_audit sca
SET location_id = sc.location_id
FROM stock_counts sc
WHERE sca.stock_count_id = sc.id AND sca.location_id IS NULL;

-- ------------------------------------------------------------
-- 3. Lock the columns down: NOT NULL after backfill
-- ------------------------------------------------------------

ALTER TABLE stock_counts ALTER COLUMN location_id SET NOT NULL;
-- audit rows from before this migration may have no parent location (rare);
-- leave audit.location_id nullable for forward safety.

-- ------------------------------------------------------------
-- 4. Replace the unique constraint to include location_id
-- ------------------------------------------------------------

ALTER TABLE stock_counts
  DROP CONSTRAINT IF EXISTS stock_counts_session_product_unique;

ALTER TABLE stock_counts
  ADD CONSTRAINT stock_counts_session_product_location_unique
  UNIQUE (session_id, product_id, location_id);

CREATE INDEX IF NOT EXISTS idx_stock_counts_location ON stock_counts(location_id);
CREATE INDEX IF NOT EXISTS idx_stock_count_audit_location ON stock_count_audit(location_id);

-- ------------------------------------------------------------
-- 5. Tighten RLS so counts only show for locations the user can see.
--    The existing org-scoped policies stay in place; this adds a
--    location-level filter on top.
-- ------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'current_user_location_ids'
  ) THEN
    DROP POLICY IF EXISTS "stock_counts_read_location" ON stock_counts;
    CREATE POLICY "stock_counts_read_location" ON stock_counts
      FOR SELECT USING (
        location_id IN (SELECT current_user_location_ids())
      );

    DROP POLICY IF EXISTS "stock_counts_write_location" ON stock_counts;
    CREATE POLICY "stock_counts_write_location" ON stock_counts
      FOR ALL USING (
        location_id IN (SELECT current_user_location_ids())
      ) WITH CHECK (
        location_id IN (SELECT current_user_location_ids())
      );
  END IF;
END $$;

COMMIT;
