-- ============================================================
-- Migration 013: Stock Count Sessions
-- Allows multiple stock counts per day (opening, closing, recount)
-- Each count event gets a session_id so Revenue Assurance
-- can compare any two count sessions by timestamp.
-- ============================================================

-- 1. Add session columns
ALTER TABLE stock_counts
  ADD COLUMN IF NOT EXISTS session_id UUID,
  ADD COLUMN IF NOT EXISTS session_label TEXT DEFAULT 'Stock Count';

-- 2. Backfill: assign one session_id per existing count_date
DO $$
DECLARE
  d DATE;
  sid UUID;
BEGIN
  FOR d IN SELECT DISTINCT count_date FROM stock_counts ORDER BY count_date
  LOOP
    sid := gen_random_uuid();
    UPDATE stock_counts SET session_id = sid WHERE count_date = d;
  END LOOP;
END $$;

-- 3. Make session_id NOT NULL now that all rows are backfilled
ALTER TABLE stock_counts
  ALTER COLUMN session_id SET NOT NULL,
  ALTER COLUMN session_id SET DEFAULT gen_random_uuid();

-- 4. Drop old unique constraint and add new one
ALTER TABLE stock_counts
  DROP CONSTRAINT IF EXISTS stock_counts_date_product_unique;

ALTER TABLE stock_counts
  ADD CONSTRAINT stock_counts_session_product_unique
  UNIQUE (session_id, product_id);

-- 5. Index for fast lookups by session
CREATE INDEX IF NOT EXISTS idx_stock_counts_session ON stock_counts(session_id);
CREATE INDEX IF NOT EXISTS idx_stock_counts_date ON stock_counts(count_date);
