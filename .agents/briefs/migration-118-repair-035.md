# Implementation brief — migration 118: repair migration 035

**Author:** Opus planning session, 2026-09-07
**Builder:** Sonnet session
**Branch:** `security/118-repair-035`
**Scope:** one migration file, one PR. No application code.
**Phase 2 step:** 1 of 8. See `.agents/briefs/phase2-role-rls-design.md`.

---

## Why

Migration 035 (`subscription_gate_hardening`) was **never applied to production**.
Confirmed 2026-09-07:

```
wms_catalog_policies = 1 | promotions_writable_policies = 0 | helper_has_period_check = false
```

035 is wrapped in a single `BEGIN;`/`COMMIT;` (lines 24, 141), so it went in whole or not
at all. Not at all.

Production therefore runs:

- `current_user_writable_org_ids()` as defined in **migration 018** — membership plus
  `subscription_status = 'active' OR (trialing AND trial_ends_at > NOW())`, with **no
  `current_period_end` check**. A paid org whose billing period ended keeps writing
  forever.
- The 7 WMS tables carrying a single `org_isolation` `FOR ALL` policy on
  `current_user_org_ids()` — tenant-scoped, **no subscription gate at all**.
- `promotions` / `promotion_items` on migration 031's policies.

**Do not simply re-run 035.** Two reasons, both below.

---

## Pre-flight — DONE, cleared 2026-09-07

Restoring the `current_period_end > NOW()` clause **removes write access from any org
whose paid period has already lapsed**. Those shops would stop being able to trade the
moment the migration applies.

**Mumba ran this on 2026-09-07. It returned 1 row — Chichi's Bakes and Accessories, period
ended 2026-08-01 — a real customer who had paid quarterly by bank transfer while the
Paystack keys were broken. Her `current_period_end` was corrected. The check was re-run and
now returns 0. Nothing is locked out by this migration.**

The builder does not need to run this. It is recorded here so the PR description can cite
it. Quote this paragraph in the PR body.

The query, for the record:

```sql
select id, name, subscription_status, current_period_end, trial_ends_at
from organizations
where subscription_status = 'active'
  and current_period_end is not null
  and current_period_end <= now();
```

Result on 2026-09-07 after the correction: **0 rows. Cleared.**

Do not soften the `current_period_end` predicate for any reason. If a future run of this
query returns rows, that is a billing problem to fix in the data, not a reason to weaken
the gate.

---

## What migration 118 must do

Re-apply 035's substance, idempotently. Model the file on 113/114/115 — header comment
explaining the finding, `BEGIN;`/`COMMIT;`, a verification block commented out at the
bottom, and the `migration repair` command in the header.

### Part 1 — restore the hardened helper

`CREATE OR REPLACE FUNCTION current_user_writable_org_ids()` exactly as 035 lines 28-42
defines it: add the `current_period_end IS NULL OR current_period_end > NOW()` condition
to the `active` branch. Keep `SECURITY DEFINER`, `STABLE`, `SET search_path = public`.

After the replace, re-assert the grants explicitly:

```sql
REVOKE ALL ON FUNCTION current_user_writable_org_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_user_writable_org_ids() TO authenticated;
```

`CREATE OR REPLACE` preserves the existing ACL, so this is belt-and-braces — but 114/115
exist precisely because grants on this codebase decay silently. Assert them.

### Part 2 — split the WMS `FOR ALL` policies

Same seven tables as 035 section 3:

```
wms_catalog, wms_inventory, wms_dispatches, wms_dispatch_items,
wms_receipts, wms_receipt_items, wms_adjustments
```

Same four split policies per table (read on `current_user_org_ids()`, insert/update/delete
on `current_user_writable_org_ids()`), same `DO $$ ... FOREACH` shape.

**The fix 035 was missing:** section 3 loops
`DROP POLICY IF EXISTS "org_isolation" ON %I` with no check that the table exists.
`IF EXISTS` covers the *policy*, not the *relation* — so one absent table aborts the whole
transaction. Section 4's ZRA block in the same file gets this right:

```sql
IF NOT EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema = 'public' AND table_name = t) THEN
  CONTINUE;
END IF;
```

Add that guard to the WMS loop. Also `DROP POLICY IF EXISTS` each of the four new policy
names before creating them, so the migration is re-runnable.

### Part 3 — promotions and promotion_items

Re-apply 035 section 2 as written (lines 44-79). Straight copy; it needs no guard, both
tables exist.

### Not in this migration

- No role checks. That is migration 119 onward.
- Do not touch `wms_stock_count_sessions`, `wms_stock_counts`, `wms_stock_count_audit`,
  `wms_locations`, `wms_org_settings`, `wms_po_items`, `wms_purchase_orders`,
  `wms_transfers`, `wms_transfer_items`. They were added after 035 and are handled in
  step 7.
- No application code. `src/app/api/admin/orgs/route.ts` already mirrors the 035
  predicate — restoring it in the database makes that route correct, so leave it alone.

---

## Verification

Commented into the bottom of the migration file, and **run by Mumba in the SQL Editor
after applying** — the builder cannot reach production.

```sql
-- 1. Helper hardened — must be true
select prosrc like '%current_period_end%' as helper_has_period_check
from pg_proc where proname = 'current_user_writable_org_ids';

-- 2. WMS split — must be 4 for every row, 7 rows
select tablename, count(*) as policies
from pg_policies
where schemaname = 'public'
  and tablename in ('wms_catalog','wms_inventory','wms_dispatches','wms_dispatch_items',
                    'wms_receipts','wms_receipt_items','wms_adjustments')
group by tablename order by tablename;

-- 3. Promotions gated — must be 4
select count(*) from pg_policies
where schemaname='public' and tablename='promotions'
  and coalesce(qual,'') || coalesce(with_check,'') like '%writable%';

-- 4. No org lost write access unexpectedly — compare to the pre-flight result
select count(*) as orgs_now_blocked from organizations
where subscription_status = 'active'
  and current_period_end is not null and current_period_end <= now();
```

### OWNER MUST VERIFY (Mumba, at a real till)

1. A till sale completes end to end after applying.
2. A WMS receipt or adjustment still saves for a warehouse-enabled org.
3. The `/admin/customers` dashboard's `writable` column now matches reality.

---

## Constraints

- **Migrations are applied by hand in the Supabase SQL Editor.** Never `db push`. Record
  afterwards with `npx supabase migration repair --status applied 118`.
- **Never apply while shops are trading.** This one changes a write gate — a mistake locks
  tills out mid-sale.
- The builder writes the file and opens the PR. **The builder does not apply it.** Mumba
  applies.
- Do not modify migrations 018 or 035. They are historical record; 118 supersedes.

## PR

- Branch `security/118-repair-035`, one PR, do not merge.
- Title: `security: migration 118 — repair 035 subscription gate (never applied)`
- Body must include the pre-flight query result from the top of this brief.
- State explicitly that the migration has not been applied, and that Mumba applies it
  outside trading hours.
