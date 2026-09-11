# Billing gate repair — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the missing `current_period_end` check to `current_user_writable_org_ids()` (migration 035, never applied) and add the same subscription check to the 12 WMS tables' write policies (migration 119 gated them on tenant+role only, no billing).

**Architecture:** One migration file (`124_billing_gate_repair.sql`): a `CREATE OR REPLACE FUNCTION` for the helper, then 12 `DROP POLICY IF EXISTS` + `CREATE POLICY` pairs × 3 write operations (insert/update/delete) layering the writable-gate onto policies migration 119 already created. No new tables, no application code.

**Tech Stack:** PostgreSQL (Supabase), applied by hand via SQL Editor. No ORM, no migration-runner CI.

**Spec:** `docs/superpowers/specs/2026-09-11-billing-gate-repair-design.md`

## Global Constraints

- Never `supabase db push` — apply by hand in the SQL Editor, then `npx supabase migration repair --status applied 124`.
- Never apply while shops are trading — this changes a write gate; a mistake locks tills out mid-sale.
- The builder (implementer) writes the file and opens the PR. **The builder does not apply the migration.** Mumba applies.
- Do not soften the `current_period_end` predicate for any reason, in the migration file or in the pre-flight query.
- Re-verify migration 124 is still the next free number against `supabase/migrations/` immediately before creating the file — migration 118 already collided once between two branches.
- No test runner exists in this repo — verification is SQL queries, run by hand by Mumba after applying (this session/any implementer has no live DB connection).
- `CREATE OR REPLACE FUNCTION current_user_writable_org_ids()`'s body must match exactly what's specified in the spec §2.1 — this function is read by RLS policies across dozens of tables; any unintended difference is a tenant-wide blast radius, not a single-table one.

---

## File structure

- Create: `supabase/migrations/124_billing_gate_repair.sql` — the whole fix, one file.
- Create: `docs/superpowers/plans/artifacts/2026-09-11-verification-124.sql` — the pre-apply gate query, the post-apply verification queries, and the OWNER MUST VERIFY checklist, as a standalone copy-pasteable artifact (mirrors the pattern from the DEFINER RPC work's `verification-122.sql`/`-123.sql`).

---

### Task 1: Write migration 124

**Files:**
- Create: `supabase/migrations/124_billing_gate_repair.sql`

**Interfaces:**
- Produces: `current_user_writable_org_ids()` (redefined, same name/signature/return type as before — `RETURNS SETOF UUID`). Nothing in this codebase needs to change to keep consuming it; every caller (RLS policies across ~30+ tables, `assert_org_writable()`, the app's `org-context.tsx` writability computation) already calls it by name and gets the new, stricter behavior automatically.

- [ ] **Step 1: Confirm the migration number is still free**

```bash
ls supabase/migrations | grep -E "^[0-9]+_" | sed -E 's/^([0-9]+)_.*/\1/' | sort -n | tail -5
```
Expected: highest is `123_sale_rpc_integrity_guards.sql`, so `124` is free. If a `124_*` file already exists, stop and report BLOCKED — do not silently pick a different number.

- [ ] **Step 2: Write the file — header, then Part 1 (helper repair)**

```sql
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
```

- [ ] **Step 3: Append Part 2 — layer the writable-gate onto the 12 WMS tables' write policies**

Append this exact block (a single `DO $$ ... $$` loop, matching the style of migration 119's own `forall_tables` construct):

```sql
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
```

- [ ] **Step 4: Append the verification block as a trailing comment**

```sql
-- ============================================================
-- Verification (run manually in SQL Editor after applying):
--
-- 1. Helper hardened — must be true
-- select prosrc like '%current_period_end%' as helper_has_period_check
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
```

- [ ] **Step 5: Sanity-check the file**

```bash
grep -c "current_period_end" supabase/migrations/124_billing_gate_repair.sql
```
Expected: at least 6 (1 in the header's pre-apply query, 2 in the helper body, 3 in the trailing verification comment's queries 1 and 3 — exact count isn't the point, confirm it's not 0).

```bash
grep -c "t||'_org_insert'" supabase/migrations/124_billing_gate_repair.sql
```
Expected: `1` (one occurrence in the DO block's EXECUTE — the loop applies it to all 12 tables at runtime, not 12 separate lines in the file).

- [ ] **Step 6: Self-review**

Read the whole file back. Confirm: the helper's body matches spec §2.1 exactly (own the risk here — this function is read by every writable-gated table in the codebase, not just WMS). Confirm the WMS loop's array has exactly 12 table names, matching the spec's list verbatim. Confirm `_org_read` is never mentioned/touched anywhere in the file.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/124_billing_gate_repair.sql
git commit -m "security: repair billing gate (current_period_end check + WMS write policies)"
```

---

### Task 2: Verification artifact + PR

**Files:**
- Create: `docs/superpowers/plans/artifacts/2026-09-11-verification-124.sql`

**Interfaces:**
- Consumes: the migration's own trailing verification comment (Task 1, Step 4) — this artifact restates those same queries as a standalone, run-independently file, plus the pre-apply gate and the OWNER MUST VERIFY checklist, so Mumba has one file to work from rather than needing to open the migration file itself.

- [ ] **Step 1: Write the verification script**

```sql
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
```

- [ ] **Step 2: Commit the verification artifact**

```bash
git add docs/superpowers/plans/artifacts/2026-09-11-verification-124.sql
git commit -m "docs: verification script for migration 124"
```

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin security/billing-gate-repair
gh pr create --base main --title "Security: billing gate repair (migration 035 was never applied)" --body "$(cat <<'EOF'
Restores current_user_writable_org_ids()'s missing current_period_end
check (migration 035, drafted 2026-07, never applied) and adds the same
subscription check to the 12 WMS tables' write policies (migration 119
gated them on tenant+role only, no billing check).

Spec: docs/superpowers/specs/2026-09-11-billing-gate-repair-design.md
Plan: docs/superpowers/plans/2026-09-11-billing-gate-repair.md
Verification: docs/superpowers/plans/artifacts/2026-09-11-verification-124.sql

**Consequence being fixed:** a paid org whose billing period has ended
has kept full write access indefinitely, on every canonical writable-
gated table plus (separately) every WMS table regardless of subscription
status at all.

**PRE-APPLY GATE — do not apply without running this first, fresh, same
day:**
```sql
select id, name, subscription_status, current_period_end, trial_ends_at
from organizations
where subscription_status = 'active'
  and current_period_end is not null and current_period_end <= now();
```
Must return 0 rows. A prior run of this (2026-09-07, found and corrected
one org — Chichi's Bakes) is stale and must not be relied on; billing
states change daily.

**No frontend change** — /admin/customers already computes its
`writable` column from this exact predicate in code; this migration
makes the database enforce what the dashboard already reports.

Apply outside trading hours only — this changes a live write gate.
Builder does not apply; Mumba applies, then:
```
npx supabase migration repair --status applied 124
```

**OWNER MUST VERIFY** (no DB connection in the building session): run
the verification script above end to end, including the real-till and
real-WMS-action checks in Step C.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01BwHWzhe8SyYrmZJsami17B
EOF
)"
```

Do not merge — per repo guardrails, PRs stay open for Mumba to merge.
