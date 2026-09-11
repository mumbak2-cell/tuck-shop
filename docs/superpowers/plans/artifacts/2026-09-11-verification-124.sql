-- Verification for migration 124 — billing gate repair.
-- Two of these steps are NOT optional pre-checks — they gate whether you
-- apply the migration at all.

-- ============================================================
-- STEP A — PRE-APPLY GATE. Run this FIRST, immediately before applying.
-- A result from an earlier day is not valid; billing states change daily.
-- ============================================================
select id, name, subscription_status, current_period_end, trial_ends_at
from organizations
where subscription_status = 'active'
  and current_period_end is not null
  and current_period_end <= now();
-- Must return 0 rows. Any row is a real customer who will be instantly
-- locked out of writing the moment this migration applies — fix their
-- billing record first (correct current_period_end), re-run until this
-- returns 0. Do not proceed to apply the migration until it does. Never
-- edit the migration's predicate to make a row disappear instead.

-- ============================================================
-- STEP B — apply the migration (124_billing_gate_repair.sql) now, in the
-- SQL Editor, closed hours only. Then run the checks below.
-- ============================================================

-- 1. Helper hardened — must be true
select prosrc like '%current_period_end%' as helper_has_period_check
from pg_proc where proname = 'current_user_writable_org_ids';

-- 2. WMS writes now billing-gated — writable_gated must be 3, total_policies must be 4, for every row (12 rows expected)
select tablename,
       count(*) filter (where coalesce(qual,'') || coalesce(with_check,'') like '%writable%') as writable_gated,
       count(*) as total_policies
from pg_policies
where schemaname = 'public'
  and tablename in ('wms_adjustments','wms_catalog','wms_dispatch_items','wms_dispatches',
                    'wms_inventory','wms_po_items','wms_purchase_orders','wms_receipt_items',
                    'wms_receipts','wms_stock_count_audit','wms_stock_counts',
                    'wms_stock_count_sessions')
group by tablename order by tablename;

-- 3. No org lost write access unexpectedly — must match Step A's result (0)
select count(*) as orgs_now_blocked from organizations
where subscription_status = 'active'
  and current_period_end is not null and current_period_end <= now();

-- ============================================================
-- STEP C — OWNER MUST VERIFY, at a real till / real org:
--   1. A till sale completes end to end after applying.
--   2. A WMS receipt or adjustment still saves for a warehouse-enabled org.
--   3. /admin/customers dashboard's "writable" column now matches reality
--      (it already computed this predicate correctly in code — this just
--      confirms the database now enforces what the dashboard reports).
-- ============================================================
