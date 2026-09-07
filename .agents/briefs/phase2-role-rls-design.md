# Phase 2 design — role-scoped RLS

**Author:** Opus planning session, 2026-09-07
**Status:** Confirmed against production 2026-09-07. Unblocked. No code written yet.
**P2-0: RESOLVED — migration 035 was never applied.** See §2.
**§4: CONFIRMED by Mumba** — proposed cashier split accepted as drafted.

---

## 0. What changed since the Phase 1 handoff

The Phase 1 close-out recorded that the two deferred findings — the adjustments PIN
bypass and `record_wms_adjustment` having no role check — were latent "only because the
Destiny org has no `org_members.role = 'member'` accounts."

That framing is now false. Confirmed against production 2026-09-07:

| role | accounts |
|---|---|
| owner | 25 |
| admin | 3 |
| **member** | **9** |

25 orgs, **7 with sales rows** — trading, not just signed up. 46 auth users, 40 monthly
active.

**There are nine cashier accounts. Both deferred Phase 1 findings are live, not latent** —
the adjustments PIN bypass and `record_wms_adjustment` having no role check. So is the
Phase 2 gap at large: each of those 9 accounts holds owner-equivalent write rights on
catalogue, pricing, stock movement and the ledger across their orgs.

Phase 2 is no longer hardening ahead of a hypothetical cashier. It is the control
separating seven trading businesses' books. Any RLS regression from here is a real breach
with real disclosure, not a near miss.

---

## 1. Verified current state

Source: `.agents/p2-summary.csv`, captured from the live DB. 69 tables.

| Category | Count | Meaning |
|---|---|---|
| A — writes gated by `current_user_writable_org_ids()`, **no role check** | 30 | The main Phase 2 target |
| B — writes with **neither** the writable helper **nor** a role check | 23 | Weaker still — see §2 |
| C — already role-scoped | 5 | `expenses`, `org_members`, `organizations`, `period_locks`, `product_stock` |
| D — read-only policies (SELECT only) | 8 | No write path to scope |
| E — RLS on, zero policies (deny-all) | 3 | `till_sessions`, `till_pin_attempts`, `wms_rpc_idempotency` — correct by design, reachable only via SECURITY DEFINER RPCs |

The hole is exactly where the handoff said it was. `current_user_writable_org_ids()`
(migration 035 lines 28-42) resolves to:

```sql
SELECT om.org_id FROM org_members om JOIN organizations o ON o.id = om.org_id
WHERE om.user_id = auth.uid()
  AND ( (o.subscription_status = 'active' AND (o.current_period_end IS NULL OR o.current_period_end > NOW()))
     OR (o.subscription_status = 'trialing' AND o.trial_ends_at > NOW()) );
```

Membership and subscription. **`om.role` is never read.** Every one of the 30 category-A
tables therefore grants a cashier the same write rights as the owner.

---

## 2. P2-0 — RESOLVED: migration 035 was never applied

Query run against production 2026-09-07. Result:

```
wms_catalog_policies = 1 | promotions_writable_policies = 0 | helper_has_period_check = false
```

Predicted values for "035 missing" were `1, 0, false`. All three match.

### What production actually runs

- `current_user_writable_org_ids()` is the **migration 018 version**: membership plus
  `subscription_status = 'active' OR (trialing AND trial_ends_at > NOW())`.
  **No `current_period_end` check.** A paid org whose billing period has ended keeps full
  write access indefinitely. Billing leak, not a tenancy breach.
- The 7 WMS tables still carry one `org_isolation` `FOR ALL` policy on
  `current_user_org_ids()` — tenant-scoped only, **no subscription gate at all**.
- `promotions` / `promotion_items` run migration 031's policies.
- `src/app/api/admin/orgs/route.ts:8-13` computes `writable` from the 035 predicate
  including `current_period_end`, so the founder dashboard reports a gate production does
  not enforce. Fix alongside, or it keeps lying.

The original reasoning that led here is kept below.

---

### How it was diagnosed

Migration 035 has three relevant sections. Section 3 replaces the single `org_isolation`
`FOR ALL` policy on seven WMS tables with four split per-operation policies, the writes
gated by the writable helper:

```
wms_catalog, wms_inventory, wms_dispatches, wms_dispatch_items,
wms_receipts, wms_receipt_items, wms_adjustments
```

The live DB shows **all seven** of those tables at `n_policies = 1`, `cmds = ALL`,
`writes_use_writable_helper = false`. Not one of them. That is a perfect match with
section 3 never having taken effect.

Section 2 splits `promotions` and `promotion_items` the same way. The live DB shows
`promotions` at `DISU` but `writes_use_writable_helper = false` — split policies, but not
the helper. Migration 031 would produce exactly that shape.

035 is wrapped in a single `BEGIN;`/`COMMIT;` (lines 24 and 141), so it applied whole or
not at all. The consistent reading of both observations is that **035 was never applied**.

Two independent corroborations:

- Migration 088 line 172, written well after 035, asserts "wms_inventory already has
  org_isolation policy". If 035 had run, that policy would have been dropped.
- Migration 083 line 89 creates `wms_scs_org_isolation` as `FOR ALL` using
  `current_user_org_ids()` — tenant-only, no subscription gate — on a table added after
  035, and nothing since has split it.

### Why this matters beyond tidiness

If 035 is absent, then `current_user_writable_org_ids()` in production is the **migration
018 version**, not the hardened one. The `current_period_end > NOW()` clause — the thing
that stops a lapsed paid org from continuing to write — may not exist at all.
`src/app/api/admin/orgs/route.ts:8-13` computes its `writable` column by mirroring the
035 predicate, so the founder dashboard would be reporting a gate that production does
not enforce.

### The query — one row, answers all of it

```sql
select
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'wms_catalog')            as wms_catalog_policies,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'promotions'
      and coalesce(qual, '') || coalesce(with_check, '') like '%writable%') as promotions_writable_policies,
  (select prosrc like '%current_period_end%' from pg_proc
    where proname = 'current_user_writable_org_ids')                      as helper_has_period_check;
```

Expected if 035 **is** applied: `4`, `4`, `true`.
If it returns `1`, `0`, `false` — 035 is missing and re-applying it is the first Phase 2
migration, ahead of any role work.

**Do not re-apply 035 blind.** Section 3's `DROP POLICY IF EXISTS ... ON %I` has no
table-existence guard, unlike section 4's ZRA block which checks `information_schema`
first. Re-running it needs that guard added, and it needs to run outside trading hours.

---

## 3. Proposed design

### 3.1 One helper, not 200 policies

Add a sibling to the existing helper, same shape, plus the role predicate:

```sql
CREATE OR REPLACE FUNCTION current_user_admin_org_ids()
RETURNS SETOF UUID
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT om.org_id
  FROM org_members om
  JOIN organizations o ON o.id = om.org_id
  WHERE om.user_id = auth.uid()
    AND om.role IN ('owner', 'admin')
    AND ( (o.subscription_status = 'active'
            AND (o.current_period_end IS NULL OR o.current_period_end > NOW()))
       OR (o.subscription_status = 'trialing' AND o.trial_ends_at > NOW()) );
$$;

REVOKE ALL ON FUNCTION current_user_admin_org_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_user_admin_org_ids() TO authenticated;
```

Then admin-only write policies become a one-token swap:

```sql
-- before
WITH CHECK (org_id IN (SELECT current_user_writable_org_ids()))
-- after
WITH CHECK (org_id IN (SELECT current_user_admin_org_ids()))
```

This beats the inline `EXISTS (SELECT 1 FROM org_members ... role IN (...))` copy-paste
used by 046, 053 and 0230. Those three stay as they are — they also carry per-location
and own-row logic that does not generalise. Do not rewrite them in this phase.

The `REVOKE ... FROM PUBLIC` plus explicit `GRANT ... TO authenticated` is deliberate:
migration 115 set `ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`,
so a new function gets no grant by default and RLS evaluation would fail for the app
without the explicit grant.

### 3.2 What this does *not* cover

**SECURITY DEFINER RPCs bypass RLS entirely.** There are 54 of them
(`.agents/p2-functions.csv`). Role-scoped policies do nothing to a caller who reaches the
data through an RPC instead of the table.

Two already-catalogued findings sit exactly here and are **not** fixed by this phase:

- `record_wms_adjustment` — SECURITY DEFINER, no role check. The client-side admin-PIN
  gate in front of it is bypassable directly over PostgREST.
- `submit_sale_batch` — `assert_org_writable` was restored by migration 114, but there is
  still no role check.

Each SECURITY DEFINER function that performs a privileged write needs its own in-function
role assertion. That is a **separate work item** — list it, scope it, do not fold it into
the policy work, or the migration becomes unreviewable.

### 3.3 The `permissions` JSONB is fail-open

Migration 077: `org_members.permissions` defaults to `'{}'`, and absence of a key means
**granted**. Only an explicit `false` revokes. So every new permission key is retroactively
granted to every existing admin the moment it ships.

That is a real design flaw, but flipping it to fail-closed silently revokes access for
every current manager on deploy. It needs its own migration with a backfill that writes
the currently-implied `true` values explicitly first. **Out of scope for this phase** —
raised here so it is not forgotten. Phase 2 keys off `role`, not `permissions`.

---

## 4. CONFIRMED — which tables a cashier may write

`role = 'member'` is the cashier. Mumba confirmed the split below as drafted, 2026-09-07.
This is now the specification the migrations implement.

### Cashier writes ALLOWED (stays on `current_user_writable_org_ids()`)

| Table | Why |
|---|---|
| `sales` | Ringing up. Also goes via `submit_sale_batch`. |
| `shifts` | Opening and closing their own shift. |
| `customers` | Adding a walk-in at the till. |
| `customer_payments` | Gated separately by the `cashierCreditSales` setting. |
| `daily_reconciliation` | Cash-up at close. |
| `stock_counts` | Closing count when `requiresStockCountToClose` is on. |
| `expenses` | Already role-scoped by 046 — cashier may write own rows only. Leave alone. |

### Cashier writes DENIED (moves to `current_user_admin_org_ids()`)

Catalogue and pricing: `products`, `categories`, `product_location_prices`, `suppliers`,
`ingredients`, `recipes`, `production_log`, `combos`, `combo_items`, `promotions`,
`promotion_items`

Stock movement: `stock_adjustments`, `stock_receipts`, `stock_receipt_items`,
`purchases`, `purchase_orders`, `purchase_order_items`, `stock_count_audit`

Money and ledger: `balance_adjustments`, `expense_categories`, `ra_notes`

Configuration: `app_settings`, `location_settings`, `locations`, `payment_methods`,
`report_subscriptions`, `zra_config`

Warehouse: every `wms_*` table with a write path

`product_stock`, `period_locks`, `org_members`, `organizations` are already role-scoped —
leave them.

### Open question

`stock_counts` shows six policies (`ALLDISU`) — a leftover `FOR ALL` alongside the split
set. Two overlapping policies on one command are OR-ed, so the broader one wins and the
narrow one is decorative. Needs reading before it is touched.

---

## 5. Rollout

One task, one PR, as with Phase 1. Sequence matters:

**Order revised 2026-09-07.** The original draft put configuration first for the smallest
blast radius. That was right for a hypothetical cashier. With **9 live cashier accounts**,
sequence by abuse value instead — close what an actual cashier could exploit today, first.

1. **Migration 118 — repair 035.** Re-apply its substance *with the table-existence guard
   added*. Restores the `current_period_end` check to the writable helper and splits the
   7 WMS `FOR ALL` policies. Own migration, own PR. No app change needed —
   `api/admin/orgs/route.ts` already mirrors the 035 predicate, so restoring it in the DB
   makes the dashboard correct rather than requiring a code fix.
   **Carries a lockout risk — see the pre-flight check in the 118 brief.**
2. **Migration 119 — helper only.** Add `current_user_admin_org_ids()`, grant it, change
   no policy. Verifiable in isolation: returns the right org ids for an owner, an admin
   and a member.
3. **Migration 120 — money and ledger.** `balance_adjustments`, `ra_notes`,
   `expense_categories`. Highest abuse value: a cashier editing the credit ledger.
4. **Migration 121 — pricing.** `products`, `product_location_prices`, `categories`,
   `combos`, `combo_items`, `promotions`, `promotion_items`.
5. **Migration 122 — stock movement.** `stock_adjustments`, `stock_receipts`,
   `stock_receipt_items`, `purchases`, `purchase_orders`, `purchase_order_items`,
   `stock_count_audit`, `suppliers`, `ingredients`, `recipes`, `production_log`.
6. **Migration 123 — configuration.** `app_settings`, `location_settings`, `locations`,
   `payment_methods`, `report_subscriptions`, `zra_config`.
7. **Migration 124 — WMS.** Every `wms_*` table with a write path.
8. **RPC role assertions** — separate work item, separate design. Note this is what
   actually closes `record_wms_adjustment`; steps 1-7 do not touch it.

One migration per step, each independently revertible, each its own PR.

### Verification per migration

Role-scoped RLS cannot be verified by reading policy text. Each PR needs, against a
non-production org, with real logins for all three roles:

- Owner: write succeeds on every table in the group.
- Admin: write succeeds on every table in the group.
- Member: write is **rejected** on every table in the group, tested **directly over
  PostgREST**, not through the UI. The UI hides the button; that is not the control.
- A till sale still completes end to end after each migration.

Per the standing rule in `tilify-no-live-pin-extraction`: do not read PIN or credential
values out of the DB to build these tests. Anything needing a real credential becomes an
OWNER MUST VERIFY item for Mumba.

### Timing

No migration, GRANT or policy change while shops are trading. PRs and reviews any time.

---

## 6. Status

| # | Item | State |
|---|---|---|
| P2-0 | Is 035 in production? | **Resolved** — it is not. Becomes migration 118. |
| §4 | Cashier-writable table split | **Confirmed** by Mumba as drafted |
| — | `org_members.role` breakdown | **Resolved** — 25 owner, 3 admin, **9 member** |

Nothing is blocked. Migration 118 is the next build task.
