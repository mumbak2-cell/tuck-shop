-- ============================================================
-- Migration 014: Fix fragmented stock count sessions
--
-- Problem: Each product got its own session_id instead of sharing one.
-- Fix: Drop constraint, merge, deduplicate, re-add constraint.
-- ============================================================

-- 1. Drop the unique constraint so we can merge freely
ALTER TABLE stock_counts DROP CONSTRAINT IF EXISTS stock_counts_session_product_unique;

-- 2. For each count_date, assign ALL rows to one shared session_id
DO $$
DECLARE
  d DATE;
  new_sid UUID;
BEGIN
  FOR d IN SELECT DISTINCT count_date FROM stock_counts ORDER BY count_date
  LOOP
    new_sid := gen_random_uuid();
    UPDATE stock_counts SET session_id = new_sid WHERE count_date = d;
  END LOOP;
END $$;

-- 3. Delete duplicates — keep the row with the latest counted_at per (session_id, product_id)
DELETE FROM stock_counts a
USING stock_counts b
WHERE a.session_id = b.session_id
  AND a.product_id = b.product_id
  AND a.id != b.id
  AND (
    a.counted_at < b.counted_at
    OR (a.counted_at = b.counted_at AND a.id < b.id)
  );

-- 4. Re-add the unique constraint
ALTER TABLE stock_counts
  ADD CONSTRAINT stock_counts_session_product_unique
  UNIQUE (session_id, product_id);

-- 5. Drop the DEFAULT so app must always provide session_id
ALTER TABLE stock_counts ALTER COLUMN session_id DROP DEFAULT;
