-- ============================================================
-- Migration 052: Stock count confirmation
--
-- Cashiers can now take a stock count, but their count deliberately does NOT
-- write product_stock — otherwise counting a shortage away would erase the very
-- variance the count exists to expose. That left counts with nothing to close
-- the loop: a manager could view the variance in Revenue Assurance but had no
-- way to accept it, so recorded stock drifted from the shelf until a manager
-- did their own count.
--
-- These columns record who applied a count to stock and when. A row with
-- confirmed_at IS NULL is a count that has been taken but not yet applied.
--
-- Owners/admins stamp their own counts at save time (their save already writes
-- product_stock), so unconfirmed sessions are exactly the cashier-recorded ones
-- awaiting review.
--
-- No RLS change here: stock_counts already scopes reads and writes by org and
-- by current_user_location_ids(), which pins a cashier to their assigned
-- branch. The manager-only restriction on applying a count to stock levels is
-- enforced in migration 053, which adds the missing role condition to
-- product_stock's write policies. Apply 052 and 053 together.
-- ============================================================

BEGIN;

ALTER TABLE stock_counts
  ADD COLUMN IF NOT EXISTS confirmed_by TEXT,
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;

-- Every count that pre-dates this migration was taken by an admin, and an
-- admin's save has always written straight through to product_stock. Backfill
-- them as confirmed by their counter so historical sessions don't surface as a
-- pile of pending work on day one.
UPDATE stock_counts
SET confirmed_by = counted_by,
    confirmed_at = COALESCE(counted_at, updated_at)
WHERE confirmed_at IS NULL;

-- Partial index: the confirm queue only ever asks for the unconfirmed rows.
CREATE INDEX IF NOT EXISTS idx_stock_counts_unconfirmed
  ON stock_counts (location_id, count_date)
  WHERE confirmed_at IS NULL;

COMMIT;
