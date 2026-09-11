-- ============================================================
-- Migration 124: Billing gate repair (migration 035 was never applied)
-- Spec: docs/superpowers/specs/2026-09-11-billing-gate-repair-design.md
--
-- current_user_writable_org_ids() has run the migration-018 shape in
-- production since launch — no current_period_end check — because
-- migration 035 (subscription_gate_hardening) was drafted but never
-- applied. Confirmed live 2026-09-11:
--   wms_catalog_policies = 4 | helper_has_period_check = false
-- A paid org whose billing period has ended has kept full write access
-- indefinitely. Separately, migration 119's WMS write-policy split
-- (12 tables) checks tenant+role but never subscription status either —
-- this migration closes both in one pass.
--
-- PRE-APPLY GATE — mandatory, run fresh immediately before applying,
-- every time (a result from an earlier day is not valid — billing
-- states change daily):
--   select id, name, subscription_status, current_period_end, trial_ends_at
--   from organizations
--   where subscription_status = 'active'
--     and current_period_end is not null
--     and current_period_end <= now();
-- Must return 0 rows. Any row is a real customer who will be instantly
-- locked out of writing the moment this applies — fix their billing
-- record first, re-run until clean. Never soften the predicate below to
-- make a row disappear instead.
--
-- Idempotent. Safe to re-run.
--
-- Apply: Supabase SQL Editor (project pkufxpyrvcygobrgneep), CLOSED
--   HOURS ONLY — this changes a live write gate.
-- Record with:
--   node node_modules/supabase/dist/supabase.js migration repair \
--     --status applied 124
-- ============================================================

-- STATEMENT 1: repair the helper — restore the current_period_end check
-- migration 035 drafted but was never applied.
CREATE OR REPLACE FUNCTION current_user_writable_org_ids()
RETURNS SETOF UUID
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT om.org_id
  FROM org_members om
  JOIN organizations o ON o.id = om.org_id
  WHERE om.user_id = auth.uid()
    AND (
      (o.subscription_status = 'active'
        AND (o.current_period_end IS NULL OR o.current_period_end > NOW()))
      OR (o.subscription_status = 'trialing' AND o.trial_ends_at > NOW())
    );
$$;

REVOKE ALL ON FUNCTION current_user_writable_org_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION current_user_writable_org_ids() TO authenticated;

-- STATEMENT 2: WMS writes — add the subscription check migration 119's
-- split never had. Reads (<t>_org_read) are untouched — a lapsed org can
-- still see its data, just not write to it, matching every other
-- writable-gated table in this codebase.
DO $$
DECLARE
  t text;
  wms_tables text[] := ARRAY[
    'wms_adjustments','wms_catalog','wms_dispatch_items','wms_dispatches',
    'wms_inventory','wms_po_items','wms_purchase_orders','wms_receipt_items',
    'wms_receipts','wms_stock_count_audit','wms_stock_counts',
    'wms_stock_count_sessions'
  ];
BEGIN
  SET LOCAL lock_timeout = '5s';
  FOREACH t IN ARRAY wms_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_org_insert', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (org_id IN (SELECT current_user_writable_org_ids()) AND org_id IN (SELECT current_user_manager_org_ids()))',
      t||'_org_insert', t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_org_update', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE USING (org_id IN (SELECT current_user_org_ids()) AND org_id IN (SELECT current_user_manager_org_ids())) WITH CHECK (org_id IN (SELECT current_user_writable_org_ids()) AND org_id IN (SELECT current_user_manager_org_ids()))',
      t||'_org_update', t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_org_delete', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE USING (org_id IN (SELECT current_user_writable_org_ids()) AND org_id IN (SELECT current_user_manager_org_ids()))',
      t||'_org_delete', t);
  END LOOP;
END $$;

-- ============================================================
-- Verification (run manually in SQL Editor after applying):
--
-- 1. Helper hardened — must be true (checks the actual clause shape, not
-- just that the column name appears somewhere in the function body)
-- select prosrc like '%current_period_end IS NULL OR o.current_period_end > NOW()%' as helper_has_period_check
-- from pg_proc where proname = 'current_user_writable_org_ids';
--
-- 2. WMS writes now billing-gated — writable_gated must be 3, total_policies must be 4, for every row
-- select tablename,
--        count(*) filter (where coalesce(qual,'') || coalesce(with_check,'') like '%writable%') as writable_gated,
--        count(*) as total_policies
-- from pg_policies
-- where schemaname = 'public'
--   and tablename in ('wms_adjustments','wms_catalog','wms_dispatch_items','wms_dispatches',
--                     'wms_inventory','wms_po_items','wms_purchase_orders','wms_receipt_items',
--                     'wms_receipts','wms_stock_count_audit','wms_stock_counts',
--                     'wms_stock_count_sessions')
-- group by tablename order by tablename;
--
-- 3. No org lost write access unexpectedly — must match the pre-apply gate (0)
-- select count(*) as orgs_now_blocked from organizations
-- where subscription_status = 'active'
--   and current_period_end is not null and current_period_end <= now();
-- ============================================================
