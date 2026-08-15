-- ============================================================
-- 086_wms_stock_count_session_autocreate.sql
--
-- Tier 1.5 — auto-create wms_stock_count_sessions rows.
--
-- Problem
-- -------
-- Migration 083 introduced wms_stock_count_sessions and backfilled one row
-- per historical session_id. New count sessions started client-side after
-- 083 shipped never got a corresponding row — nothing on the write path
-- inserts one. Symptoms:
--   - freeze_wms_count_session(session_id) raises "Count session % not found".
--   - The Frozen badge (Wave B6) silently reads FALSE because the query
--     joins to a row that doesn't exist.
--
-- Fix
-- ---
-- Trigger on wms_stock_counts. Every INSERT auto-creates the sessions
-- row if missing. Impossible to bypass — no code path can start a count
-- session and skip session-row creation.
--
-- Also re-runs the 083 backfill to cover sessions started between 083
-- and 086.
--
-- Idempotent. Safe to re-run.
--
-- Depends on 083 (wms_stock_count_sessions table).
--
-- Record with:
--   node node_modules/supabase/dist/supabase.js migration repair \
--     --status applied 086
-- ============================================================

-- ------------------------------------------------------------
-- 1. Re-run backfill for sessions started between 083 and 086.
-- ------------------------------------------------------------
INSERT INTO wms_stock_count_sessions (id, org_id, label, started_at, closed_at, is_frozen)
SELECT sc.session_id,
       sc.org_id,
       COALESCE(MAX(sc.session_label), 'Stock Count'),
       MIN(sc.counted_at),
       NULL::TIMESTAMPTZ,      -- do NOT auto-close; treat as active
       FALSE
  FROM wms_stock_counts sc
  LEFT JOIN wms_stock_count_sessions s ON s.id = sc.session_id
 WHERE s.id IS NULL
 GROUP BY sc.session_id, sc.org_id
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------
-- 2. Trigger function: create the session row on first insert for it.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION ensure_wms_stock_count_session()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.session_id IS NULL THEN
    RAISE EXCEPTION 'wms_stock_counts.session_id cannot be NULL' USING ERRCODE = '23502';
  END IF;

  INSERT INTO wms_stock_count_sessions (id, org_id, label, started_at)
  VALUES (
    NEW.session_id,
    NEW.org_id,
    COALESCE(NULLIF(TRIM(NEW.session_label), ''), 'Stock Count'),
    COALESCE(NEW.counted_at, NOW())
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION ensure_wms_stock_count_session() FROM PUBLIC, anon;
-- Trigger execution does not require EXECUTE on the function; no GRANT needed.

-- ------------------------------------------------------------
-- 3. Attach the trigger. BEFORE INSERT so the session row exists
--    before any downstream logic (RLS, other triggers) reads it.
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_wms_stock_counts_ensure_session ON wms_stock_counts;

CREATE TRIGGER trg_wms_stock_counts_ensure_session
  BEFORE INSERT ON wms_stock_counts
  FOR EACH ROW
  EXECUTE FUNCTION ensure_wms_stock_count_session();

-- ============================================================
-- Verification (run manually in SQL Editor after applying)
-- ============================================================
-- -- 1. No orphaned sessions remain after backfill:
-- SELECT COUNT(*) AS orphaned
--   FROM wms_stock_counts sc
--   LEFT JOIN wms_stock_count_sessions s ON s.id = sc.session_id
--  WHERE s.id IS NULL;
-- -- Expect: 0
--
-- -- 2. Trigger is attached:
-- SELECT tgname, tgenabled
--   FROM pg_trigger
--  WHERE tgname = 'trg_wms_stock_counts_ensure_session';
-- -- Expect: one row, tgenabled = 'O' (enabled origin)
--
-- -- 3. Behaviour test (pick any wms_item_id owned by your org for <ITEM>):
-- DO $$
-- DECLARE v_item BIGINT := <ITEM>;   -- edit
--         v_org  UUID   := (SELECT org_id FROM wms_catalog WHERE id = v_item);
--         v_sess UUID   := gen_random_uuid();
-- BEGIN
--   -- Session row should NOT exist yet.
--   IF EXISTS (SELECT 1 FROM wms_stock_count_sessions WHERE id = v_sess) THEN
--     RAISE EXCEPTION 'FAIL: fresh UUID somehow already has a session row';
--   END IF;
--
--   -- Insert a count row.
--   INSERT INTO wms_stock_counts (session_id, org_id, wms_item_id, session_label)
--   VALUES (v_sess, v_org, v_item, 'autocreate-test');
--
--   -- Session row must now exist, unclosed, not frozen.
--   IF NOT EXISTS (
--     SELECT 1 FROM wms_stock_count_sessions
--      WHERE id = v_sess AND closed_at IS NULL AND is_frozen = FALSE
--   ) THEN
--     RAISE EXCEPTION 'FAIL: trigger did not create the session row';
--   END IF;
--
--   -- Freeze should now succeed instead of raising "not found".
--   PERFORM freeze_wms_count_session(v_sess);
--   IF NOT (SELECT is_frozen FROM wms_stock_count_sessions WHERE id = v_sess) THEN
--     RAISE EXCEPTION 'FAIL: freeze did not flip flag';
--   END IF;
--
--   -- Clean up.
--   DELETE FROM wms_stock_counts        WHERE session_id = v_sess;
--   DELETE FROM wms_stock_count_sessions WHERE id = v_sess;
--
--   RAISE NOTICE 'PASS: autocreate + freeze round-trip clean';
-- END $$;
