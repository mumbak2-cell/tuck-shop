-- ============================================================
-- Migration 113: Turn on security_invoker for four WMS views
--
-- wms_inventory_by_item, wms_expiry_forecast, wms_inventory_in_transit
-- and wms_cycle_count_due (088, 090, 092, 0291) are all owned by
-- postgres with security_invoker unset (off, the default). A view
-- with security_invoker off executes as its OWNER, so postgres reads
-- straight through the org_isolation RLS policies on the underlying
-- tables (wms_inventory, wms_receipt_items, stock_movements) — the
-- policies never run. All four views are also SELECT-able by anon.
-- Combined, any caller holding the publishable anon key (it ships in
-- the browser bundle) can read every tenant's stock levels, weighted
-- average cost (COGS), expiry forecasts and in-transit transfers over
-- PostgREST, fully unauthenticated. This closes an unauthenticated
-- cross-tenant read.
--
-- Root cause, from 088 around line 171:
--   "-- The view inherits RLS through the underlying table (wms_inventory
--    already has org_isolation policy). No separate policy needed."
-- That assumption is false without security_invoker on — RLS is
-- evaluated against the view's owner, not the caller, so it never
-- inherits anything. 088, 090, 092 and 0291 are applied migrations
-- and are left untouched; this fix is additive, in a new file.
--
-- security_invoker is a Postgres 15+ view option. Requires Postgres 15+.
--
-- Zero references to any of these four views exist outside
-- supabase/migrations — nothing in the app reads them — so turning on
-- invoker semantics cannot break a code path.
--
-- Idempotent. Safe to re-run.
--
-- Record with:
--   node node_modules/supabase/dist/supabase.js migration repair \
--     --status applied 113
-- ============================================================

ALTER VIEW wms_inventory_by_item    SET (security_invoker = on);
ALTER VIEW wms_expiry_forecast      SET (security_invoker = on);
ALTER VIEW wms_inventory_in_transit SET (security_invoker = on);
ALTER VIEW wms_cycle_count_due      SET (security_invoker = on);

-- ============================================================
-- Verification (run manually in SQL Editor after applying)
-- ============================================================
-- BEGIN; SET LOCAL ROLE anon;
-- SELECT count(*) FROM wms_inventory_by_item;   -- must return 0
-- ROLLBACK;
-- SELECT relname, reloptions FROM pg_class
--  WHERE relname IN ('wms_inventory_by_item','wms_expiry_forecast',
--                    'wms_inventory_in_transit','wms_cycle_count_due');
-- ============================================================
