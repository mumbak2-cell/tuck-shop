-- ============================================================
-- 082_wms_drop_legacy_receive_overload.sql
--
-- P0 security hotfix.
--
-- Problem
-- -------
-- Migration 0231 defined:
--   receive_wms_stock(p_org_id UUID, p_items JSONB)
-- Migration 036 introduced a DIFFERENT signature via CREATE OR REPLACE:
--   receive_wms_stock(TEXT, TEXT, TEXT, INTEGER[], INTEGER[], INTEGER[], NUMERIC[])
-- Postgres treats these as DISTINCT overloads. Migration 040 rewrote only
-- the 7-arg form. Migration 080 revoked EXECUTE from anon on the 7-arg form.
-- No migration ever dropped or revoked the original 2-arg form, so it is
-- still resident and — since Postgres grants EXECUTE to PUBLIC by default
-- for SECURITY DEFINER functions — still callable by an anonymous client.
--
-- The 2-arg version has no auth.uid() check, no assert_org_writable,
-- accepts p_org_id from the caller, and writes no wms_receipts row.
-- Any internet caller can inflate any org's wms_inventory.physical_qty
-- with zero audit trail.
--
-- Fix
-- ---
-- Drop the legacy overload. Belt-and-braces REVOKE on the modern overload
-- to cover the historical PUBLIC default. Idempotent; safe to re-run.
--
-- After applying via the Supabase SQL Editor, record with:
--   node node_modules/supabase/dist/supabase.js migration repair \
--     --status applied 082
-- ============================================================

-- 1. Drop the vulnerable overload.
DROP FUNCTION IF EXISTS public.receive_wms_stock(UUID, JSONB);

-- 2. Belt-and-braces: revoke from PUBLIC + anon on the current overload.
--    Migration 080 revoked from anon; PUBLIC was never explicitly revoked.
REVOKE EXECUTE ON FUNCTION public.receive_wms_stock(
  TEXT, TEXT, TEXT, INTEGER[], INTEGER[], INTEGER[], NUMERIC[]
) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION public.receive_wms_stock(
  TEXT, TEXT, TEXT, INTEGER[], INTEGER[], INTEGER[], NUMERIC[]
) FROM anon;

-- 3. Belt-and-braces sweep across every WMS-family function that migration
--    080 already listed. Re-revoking PUBLIC + anon is idempotent and closes
--    the gap for any function whose grants have drifted since 080.
DO $$
DECLARE
  fn TEXT;
  fn_list TEXT[] := ARRAY[
    'adjust_wms_inventory(UUID, BIGINT, INT, TEXT)',
    'apply_wms_stock_count(UUID)',
    'create_wms_dispatch(TEXT, TEXT, TEXT, TEXT, UUID, INTEGER[], INTEGER[], INTEGER[], NUMERIC[])',
    'receive_wms_purchase_order(BIGINT, INTEGER[], INTEGER[], NUMERIC[], TEXT)',
    'record_wms_adjustment(BIGINT, INT, TEXT, TEXT, NUMERIC)'
  ];
BEGIN
  FOREACH fn IN ARRAY fn_list LOOP
    BEGIN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC', fn);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM anon',   fn);
    EXCEPTION WHEN undefined_function THEN
      -- Function not present in this environment; skip.
      NULL;
    END;
  END LOOP;
END $$;

-- ============================================================
-- Verification (run manually in SQL Editor after applying; not part of tx)
-- ============================================================
-- -- Confirm the vulnerable overload is gone:
-- SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public' AND p.proname = 'receive_wms_stock';
-- -- Expect exactly one row, args = 'p_supplier text, p_notes text, ...'
--
-- -- Confirm anon holds no EXECUTE on any WMS function:
-- SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
--        has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public'
--    AND p.proname IN (
--      'receive_wms_stock','adjust_wms_inventory','apply_wms_stock_count',
--      'create_wms_dispatch','receive_wms_purchase_order','record_wms_adjustment'
--    );
-- -- Every anon_can_execute must be FALSE.
