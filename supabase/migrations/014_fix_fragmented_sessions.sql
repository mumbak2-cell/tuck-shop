-- ============================================================
-- Migration 014: Fix fragmented stock count sessions
--
-- Problem: After migration 013 added session_id with DEFAULT gen_random_uuid(),
-- stock counts saved before the updated code was deployed got individual
-- session_ids per product row instead of sharing one per count event.
--
-- Fix: For each count_date, consolidate all rows into a single session_id.
-- Then drop the DEFAULT so session_id must always be provided by the app.
-- ============================================================

-- 1. Consolidate: for each count_date, set all rows to share one session_id
-- (pick the session_id from the row with the most products — that's the "real" session)
DO $$
DECLARE
  d DATE;
  winning_session UUID;
BEGIN
  FOR d IN SELECT DISTINCT count_date FROM stock_counts ORDER BY count_date
  LOOP
    -- Find the session_id that has the most products for this date
    SELECT session_id INTO winning_session
    FROM stock_counts
    WHERE count_date = d
    GROUP BY session_id
    ORDER BY COUNT(*) DESC
    LIMIT 1;

    -- Update all rows for this date to use that session_id
    UPDATE stock_counts
    SET session_id = winning_session
    WHERE count_date = d AND session_id != winning_session;
  END LOOP;
END $$;

-- 2. Now there might be duplicate (session_id, product_id) rows from the merge.
-- Keep the most recent one (by counted_at), delete the rest.
DELETE FROM stock_counts a
USING stock_counts b
WHERE a.session_id = b.session_id
  AND a.product_id = b.product_id
  AND a.id != b.id
  AND (a.counted_at < b.counted_at OR (a.counted_at = b.counted_at AND a.id < b.id));

-- 3. Remove the DEFAULT on session_id so the app must always provide it
ALTER TABLE stock_counts ALTER COLUMN session_id DROP DEFAULT;
