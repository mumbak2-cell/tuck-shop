# Design — billing gate repair (migration 035 was never applied)

**Status:** Approved by Mumba 2026-09-11, not yet built.
**Relates to:** [[tilify-security-review]] Phase 2. Supersedes the never-built
`.agents/briefs/migration-118-repair-035.md` (local, gitignored — not present in a fresh clone or worktree) (2026-09-07, branch
`security/118-repair-035` — abandoned, no longer exists; migration number 118
was independently claimed by `70e0955`'s `customer_payments.payment_method`
migration). That brief's analysis and Part 1 are still correct and are
reused here verbatim; its Part 2 and Part 3 are superseded by what migration
119 actually shipped in the meantime (see §2).

---

## 1. Problem

Migration 035 (`subscription_gate_hardening`) was drafted to fix two things
and was **never applied to production**. Confirmed against live prod on
2026-09-07 (original brief) and re-confirmed 2026-09-11 (this session):

```sql
select
  (select count(*) from pg_policies where schemaname='public' and tablename='wms_catalog') as wms_catalog_policies,
  (select prosrc like '%current_period_end%' from pg_proc where proname='current_user_writable_org_ids') as helper_has_period_check;
```
```
wms_catalog_policies = 4  |  helper_has_period_check = false
```

`wms_catalog_policies = 4` shows migration 119's later, independent role-split
did apply. `helper_has_period_check = false` shows the specific fix 035 was
for — `current_user_writable_org_ids()` still runs the **migration 018**
version:

```sql
WHERE om.user_id = auth.uid()
  AND (
    o.subscription_status = 'active'
    OR (o.subscription_status = 'trialing' AND o.trial_ends_at > NOW())
  );
```

No `current_period_end` check on the `active` branch. **Consequence:** a
paid org whose billing period has ended keeps full write access
indefinitely, on every table this helper gates — not a tenancy breach, a
billing leak (org keeps trading without paying).

**A second, related gap, not part of 035's original scope:** migration 119
split the 12 WMS tables' single `org_isolation` policy into per-operation
policies, but gated writes on `current_user_org_ids() AND
current_user_manager_org_ids()` — tenant + role, **no subscription check at
all**. `current_user_manager_org_ids()` itself has no billing clause either.
So even a fully lapsed or cancelled org's own owner/admin can still write to
every WMS table. Per Mumba's decision (2026-09-11), this design closes both
gaps in one migration, not just 035's original scope.

## 2. Design

### 2.1 Part 1 — repair the helper (reused from the 118-repair brief, one fix)

```sql
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
```

Identical to 035's draft and the 118-repair brief's Part 1 — do not soften
the `current_period_end` predicate. `current_period_end IS NULL` stays
permissive for legacy rows with no billing period recorded.

**Fix over the original brief:** it specified `REVOKE ALL ... FROM PUBLIC`
only. Per this repo's own documented lesson (CLAUDE.md: *"`REVOKE …FROM
PUBLIC` does not lock down a function on Supabase"* — Supabase grants
`anon`/`authenticated`/`service_role` by name, `PUBLIC` is a different
grantee) and exactly the bug migration 114 fixed today for the DEFINER RPCs,
this migration instead does:

```sql
REVOKE ALL ON FUNCTION current_user_writable_org_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION current_user_writable_org_ids() TO authenticated;
```

### 2.2 Part 2 — add the subscription gate to WMS writes

The original brief's Part 2 (a fresh 7-table split) is stale — migration 119
already split these tables' policies (plus 5 more, 12 total) with a
different, already-live shape. This part instead **layers the writable gate
onto 119's existing policies**, not replaces them:

Tables (119's `forall_tables` array, `119_role_scoped_write_rls.sql:195-199`):
`wms_adjustments`, `wms_catalog`, `wms_dispatch_items`, `wms_dispatches`,
`wms_inventory`, `wms_po_items`, `wms_purchase_orders`, `wms_receipt_items`,
`wms_receipts`, `wms_stock_count_audit`, `wms_stock_counts`,
`wms_stock_count_sessions`.

For each table, `DROP POLICY IF EXISTS` + `CREATE POLICY` for
`<t>_org_insert`, `<t>_org_update`, `<t>_org_delete` (leave `<t>_org_read`
untouched — reads stay tenant-only, matching every other table in this
codebase: a lapsed org can still see its data, just not write to it):

```sql
-- insert
WITH CHECK (org_id IN (SELECT current_user_writable_org_ids())
            AND org_id IN (SELECT current_user_manager_org_ids()))

-- update
USING      (org_id IN (SELECT current_user_org_ids())
            AND org_id IN (SELECT current_user_manager_org_ids()))
WITH CHECK (org_id IN (SELECT current_user_writable_org_ids())
            AND org_id IN (SELECT current_user_manager_org_ids()))

-- delete
USING (org_id IN (SELECT current_user_writable_org_ids())
       AND org_id IN (SELECT current_user_manager_org_ids()))
```

This is the same `USING`-tenant / `WITH CHECK`-writable split this repo's
canonical Bucket A tables already use (`119_role_scoped_write_rls.sql:62-65`)
— a manager can still locate a row belonging to a lapsed org to look at it,
but cannot successfully write to it.

**Not touched, already correct:** `zra_config`/`zra_invoices` — confirmed
(`119:260-274`) already gated on `current_user_writable_org_ids() AND
current_user_manager_org_ids()` for writes. `wms_locations`,
`wms_org_settings` — confirmed already using `current_user_writable_org_ids()`
for writes (`094:56-63`, `119:224-247`), no change needed.

**Known remaining gap, NOT closed by this migration** (found during final
review, correcting an earlier — wrong — claim that these were already
gated): `promotions`, `promotion_items`, `combos`, `combo_items`,
`purchase_orders`, `purchase_order_items` (`119:117-148`, `119:281-303`)
are still gated on `current_user_org_ids() AND current_user_manager_org_ids()`
— tenant + role, no subscription check. Same gap class as the WMS tables
this migration fixes. `promotions`/`promotion_items` were originally in
scope for 035 (its section 2) but 119's rewrite dropped the writable gate
when it added the role gate; `combos`/`combo_items`/`purchase_orders`/
`purchase_order_items` were never in 035's scope at all. Deliberately left
out of migration 124 — it already passed full line-by-line review, and
widening its scope now would mean shipping unreviewed changes. Tracked as
a follow-up (candidate migration 125), alongside a possible hardening pass
on `current_user_writable_org_ids()`, `current_user_org_ids()`,
`current_user_location_ids()`, and `default_user_org_id()` to the
`SET search_path = ''` + schema-qualified pattern `current_user_manager_org_ids()`
already uses (migration 119's own comment explains why: prevents a
`CREATE TEMP TABLE org_members` shadow inside a SECURITY DEFINER function).

### 2.3 No application code change

`src/app/api/admin/orgs/route.ts` already computes its `writable` column by
mirroring this exact predicate (confirmed present, `route.ts:8-16`), so
restoring the helper in the database makes the founder dashboard correct
without any code change — it was already reporting the intended gate,
production just wasn't enforcing it.

## 3. Mandatory pre-apply gate

Restoring `current_period_end` removes write access from any org whose paid
period has already lapsed — those shops stop trading the moment this
applies. The original brief's pre-flight (2026-09-07) found one such org
(Chichi's Bakes, corrected) and returned 0 after the fix. That result is
**four days stale** and must not be reused — per Mumba's decision
(2026-09-11), this gate is re-run fresh, immediately before applying, every
time:

```sql
select id, name, subscription_status, current_period_end, trial_ends_at
from organizations
where subscription_status = 'active'
  and current_period_end is not null
  and current_period_end <= now();
```

Must return **0 rows** immediately before applying. Any row is a real
customer who will be instantly locked out — fix their billing record first
(same as Chichi's), re-run until clean. Never soften the predicate to make a
row disappear instead.

## 4. Rollout

One migration, one PR — next free number is **124** (confirmed clear against
`supabase/migrations/` and open branches as of 2026-09-11; re-verify
immediately before creating the file, per the 118 collision precedent).
Unlike today's DEFINER-RPC work, this doesn't need a two-PR split: it's one
cohesive fix (the helper plus the one place still depending on its old
behavior).

**Verification, commented into the migration file and run by Mumba after
applying** (adapted from the 118-repair brief):

```sql
-- 1. Helper hardened — must be true
select prosrc like '%current_period_end%' as helper_has_period_check
from pg_proc where proname = 'current_user_writable_org_ids';

-- 2. WMS writes now billing-gated — must show 'writable' in every row
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
-- Expect: writable_gated = 3 for every table (insert/update/delete), total_policies = 4.

-- 3. No org lost write access unexpectedly — compare to the pre-flight result
select count(*) as orgs_now_blocked from organizations
where subscription_status = 'active'
  and current_period_end is not null and current_period_end <= now();
-- Expect: 0, matching the pre-apply gate run immediately before this migration.
```

**OWNER MUST VERIFY** (Mumba, at a real till — no DB connection in the
building session, same limitation as the DEFINER RPC work):
1. A till sale completes end to end after applying.
2. A WMS receipt or adjustment still saves for a warehouse-enabled org.
3. `/admin/customers` dashboard's `writable` column now matches reality.

**Guardrails, unchanged:** never `supabase db push`; never apply while shops
are trading — this changes a write gate, a mistake locks tills out mid-sale;
builder writes the file and opens the PR, does not apply it; Mumba applies
by hand then `npx supabase migration repair --status applied 124`.
