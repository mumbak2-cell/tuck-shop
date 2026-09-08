# Role-scoped write RLS (Security Phase 2) — design

**Date:** 2026-09-08
**Status:** approved design, pending implementation plan
**Scope:** one Supabase migration + spec/plan docs. No application code changes.

## Problem

`017_multitenant_foundation.sql` gave every tenant table four RLS policies
(SELECT / INSERT / UPDATE / DELETE), each gated **only** on
`org_id IN (SELECT current_user_org_ids())`. There is no role predicate.

A signed-in `org_members.role = 'member'` (cashier) account can therefore
INSERT / UPDATE / DELETE any row in its own org — products, prices,
promotions, suppliers, reconciliation, WMS inventory — by calling PostgREST
directly, even though every such screen is manager-only in the UI. The UI
restriction is the only control.

A handful of tables were retrofitted with an inline role check since:
`product_stock` (053), `expenses` (046), `location_settings` **reads** (100),
and `sales` had its UPDATE/DELETE policies dropped entirely (078). Each
inlined `EXISTS (SELECT 1 FROM org_members … role IN ('owner','admin'))`;
053 and 100 both noted the absence of a shared helper.

## Goal

**Write-lockdown only.** Add a role predicate to the INSERT / UPDATE / DELETE
policies across every table that still has the org-only shape, so a
`member` account cannot write them directly. SELECT policies are left
untouched (the POS and the offline cache read them). This extends the
mig-053 pattern to the whole schema.

Out of scope for this phase: per-role SELECT restrictions; honouring the
`org_members.permissions` JSONB (077) in RLS; adding `user_id` columns for
row-owner scoping.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Shared helper vs inline | Add `current_user_is_org_manager(uuid)` helper |
| Honour `permissions` JSONB | No — role only this phase |
| Member direct-write whitelist | `customer_payments` INSERT, `customers` INSERT, `stock_counts` INSERT/UPDATE (already so) |
| `shifts` (no `location_id` / `user_id` column) | Manager-only (option b2) — the till open/close already runs on the shared manager account |
| RPC-only tables (`sales` …) | Keep a manager INSERT policy as a fallback; do not drop INSERT entirely |
| Rollout structure | One helper + one sweep migration, `DO $$` loop for canonical tables + explicit blocks for the rest |
| Table scope | Every table with an org-only policy set, including `wms_*` |

## Components

### 1. Helper function

```sql
CREATE OR REPLACE FUNCTION current_user_is_org_manager(p_org_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM org_members m
    WHERE m.org_id = p_org_id
      AND m.user_id = auth.uid()
      AND m.role IN ('owner','admin')
  );
$$;
REVOKE EXECUTE ON FUNCTION current_user_is_org_manager(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION current_user_is_org_manager(uuid) TO authenticated;
```

`STABLE`, `SECURITY DEFINER`, pinned `search_path` — matches the
`current_user_org_ids()` / `current_user_location_ids()` precedent. Takes
`p_org_id` so a policy can pass the row's own `org_id`, the same call style
as the inlined blocks in 053/100.

### 2. Migration `NNN_role_scoped_write_rls.sql`

One file, one `BEGIN/COMMIT`, three parts:

- **Part 1** — the function above.
- **Part 2** — a `DO $$` loop over an explicit `canonical_tables[]` array.
  For each table: `DROP POLICY IF EXISTS` then `CREATE POLICY` for
  `_org_insert` / `_org_update` / `_org_delete`, expression = the 017
  canonical clause **`AND current_user_is_org_manager(org_id)`**. SELECT
  policies are never referenced.
- **Part 3** — explicit hand-written `DROP`+`CREATE` blocks for:
  - non-canonical Bucket A tables (existing policy carries extra clauses),
    expression = *current expression* `AND current_user_is_org_manager(org_id)`;
  - the Bucket B whitelist (`customer_payments`, `customers`).

Re-runnable: `DROP POLICY IF EXISTS` before every `CREATE`,
`CREATE OR REPLACE FUNCTION`.

### 3. No application code changes

Reads are unchanged. Every current cashier write path is one of: a
manager-account action on a shared device, a Bucket B whitelist write, or a
`SECURITY DEFINER` RPC (which bypasses RLS). Implementation confirms this
per table.

## Table classification

### Bucket A — manager-gate sweep

Loop appends `AND current_user_is_org_manager(org_id)` to INSERT / UPDATE /
DELETE.

Provisional list (pinned against a live `pg_policy` dump at implementation):

`products, ingredients, recipes, categories, combos, combo_items,
promotions, promotion_items, suppliers, payment_methods, locations,
location_settings, app_settings, product_location_prices, purchases,
purchase_orders, purchase_order_items, stock_receipts, stock_receipt_items,
stock_adjustments, stock_movements, stock_oversells, stock_transfers,
production_log, daily_reconciliation, balance_adjustments, ra_notes,
stock_count_audit, zra_config, zra_invoices, shifts`
plus the `wms_*` data tables:
`wms_catalog, wms_inventory, wms_locations, wms_org_settings,
wms_adjustments, wms_dispatches, wms_dispatch_items, wms_receipts,
wms_receipt_items, wms_transfers, wms_transfer_items, wms_purchase_orders,
wms_po_items, wms_stock_counts, wms_stock_count_sessions,
wms_stock_count_audit`.

`sales`: INSERT gets the manager gate; no UPDATE/DELETE policy exists since
078.

### Bucket B — member-write whitelist (explicit blocks)

| Table | Member may | Scope | Note |
|---|---|---|---|
| `customer_payments` | INSERT | `org_id` in writable orgs | no location/user column; the offline queue writes it |
| `customers` | INSERT | `org_id` in writable orgs | UPDATE/DELETE manager-gated |
| `stock_counts` | INSERT / UPDATE | `current_user_location_ids()` | **already** so (052); restated for clarity, no behaviour change |

### Bucket C — untouched

Every `FOR SELECT` policy; `product_stock` (053); `expenses` (046);
`organizations` / `org_members` (role-scoped in 017);
`till_sessions` / `till_pin_attempts` (109/110 own model);
`period_locks` (069); platform tables (`platform_admins, partners,
referrals, commission_payouts, admin_org_overrides, invoice_events,
audit_logs, wms_rpc_idempotency`).

## Policy SQL shapes

### Canonical table (loop)

```sql
DO $$
DECLARE t text;
  canonical_tables text[] := ARRAY[ /* pinned list */ ];
BEGIN
  FOREACH t IN ARRAY canonical_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t||'_org_insert', t);
    EXECUTE format($f$CREATE POLICY %I ON %I FOR INSERT WITH CHECK (
        org_id IN (SELECT current_user_writable_org_ids())
        AND current_user_is_org_manager(org_id))$f$, t||'_org_insert', t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t||'_org_update', t);
    EXECUTE format($f$CREATE POLICY %I ON %I FOR UPDATE
        USING (org_id IN (SELECT current_user_org_ids())
               AND current_user_is_org_manager(org_id))
        WITH CHECK (org_id IN (SELECT current_user_writable_org_ids())
               AND current_user_is_org_manager(org_id))$f$,
        t||'_org_update', t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t||'_org_delete', t);
    EXECUTE format($f$CREATE POLICY %I ON %I FOR DELETE
        USING (org_id IN (SELECT current_user_org_ids())
               AND current_user_is_org_manager(org_id))$f$,
        t||'_org_delete', t);
  END LOOP;
END $$;
```

### Non-canonical tables

Existing policies carry extra clauses (`location_settings` PIN-row hiding in
100, `stock_receipts` 054/099, `sales` 101, the `wms_*` set, anything with a
`location_id` or period-lock filter). Each gets an explicit DROP+CREATE
whose expression is **the current expression**
`AND current_user_is_org_manager(org_id)` — nothing else changed.
Implementation dumps `pg_get_expr(polqual…)` / `polwithcheck` for every
Bucket A table first and splits canonical vs non-canonical from that dump.

### Bucket B blocks

```sql
-- customer_payments: members may take a credit payment at the till.
DROP POLICY IF EXISTS "customer_payments_org_insert" ON customer_payments;
CREATE POLICY "customer_payments_org_insert" ON customer_payments FOR INSERT
  WITH CHECK (org_id IN (SELECT current_user_writable_org_ids()));
DROP POLICY IF EXISTS "customer_payments_org_update" ON customer_payments;
CREATE POLICY "customer_payments_org_update" ON customer_payments FOR UPDATE
  USING (org_id IN (SELECT current_user_org_ids())
         AND current_user_is_org_manager(org_id))
  WITH CHECK (org_id IN (SELECT current_user_writable_org_ids())
         AND current_user_is_org_manager(org_id));
DROP POLICY IF EXISTS "customer_payments_org_delete" ON customer_payments;
CREATE POLICY "customer_payments_org_delete" ON customer_payments FOR DELETE
  USING (org_id IN (SELECT current_user_org_ids())
         AND current_user_is_org_manager(org_id));
```

Same three-block shape for `customers` (INSERT open to members,
UPDATE/DELETE manager-gated). `stock_counts` — no statements.

## Rollout

**No code phase.** Nothing to deploy before or after. Sequence:

1. Merge PR (migration file + this spec + plan).
2. Owner applies the one file in the Supabase SQL Editor, project
   `pkufxpyrvcygobrgneep`, **during closed hours** (standing rule: no prod
   DB changes while tills trade).
3. Run post-apply verification (below) in the same session.
4. `npx supabase migration repair --status applied NNN` locally.
5. If verification fails — revert (below), then reopen.

**Transaction:** the whole migration in one `BEGIN/COMMIT` (matches 017's
atomic policy swap; a DROP-then-CREATE per policy leaves a sub-second
deny-all window per table — closed-hours + atomic makes it a non-issue).

## Failure modes

| # | Risk | Mitigation |
|---|---|---|
| 1 | `current_user_is_org_manager` returns false for a real manager → managers locked out of every write | Verification runs `SELECT current_user_is_org_manager('<real org>')` as the owner session **before** trusting the sweep; closed-hours window = owner testing live immediately after apply |
| 2 | A member write path we missed now 403s (fail-closed) | Pre-apply grep of every `.from("<A-table>").(insert\|update\|delete\|upsert)` and every non-DEFINER function writing an A-table → per-table audit in the plan; post-apply, revert if one surfaces |
| 3 | Non-canonical table misclassified as canonical → loop regenerates it and drops a needed clause (e.g. `location_settings` PIN hiding) | Canonical/non-canonical split comes from the live `pg_policy` dump, not guesswork; post-apply diff every regenerated expression against the dump |
| 4 | A `SECURITY INVOKER` (or unmarked) function writing an A-table as a member breaks | Grep for INVOKER/unmarked functions doing writes — plan item. `DEFINER` RPCs (`submit_sale_batch` …) bypass RLS, unaffected |

## Rollback

Ship as a fenced block in the PR body. Re-`CREATE` the affected tables'
INSERT/UPDATE/DELETE at the plain 017 shape
(`org_id IN (SELECT current_user_org_ids())` /
`current_user_writable_org_ids()`), drop the Bucket B whitelist policies
back to the same, `DROP FUNCTION current_user_is_org_manager(uuid)`. One
transaction; testable in the same closed-hours window.

## Verification

No test suite in this repo — verification is manual, shipped as a checklist
in the PR body.

### Pre-apply (implementation time)

- **Owner runs, pastes back:**
  ```sql
  SELECT polrelid::regclass AS tbl, polcmd,
         pg_get_expr(polqual, polrelid)      AS using_expr,
         pg_get_expr(polwithcheck, polrelid) AS check_expr
  FROM pg_policy ORDER BY 1, 2;
  ```
  Canonical vs non-canonical split derives from this real data.
- **Claude:** grep every `.from("<A-table>").(insert|update|delete|upsert)`
  in `src/`; grep every `SECURITY INVOKER` / unmarked function that writes
  an A-table. Every hit resolved (manager screen / whitelisted / DEFINER
  RPC) in the per-table audit.

### Post-apply (owner, SQL Editor, closed hours)

1. **Helper sanity** — `SELECT current_user_is_org_manager(id) FROM organizations;`
   as owner → all `true`.
2. **Coverage** — INSERT/UPDATE/DELETE policies on Bucket A tables whose
   `pg_get_expr` lacks `current_user_is_org_manager` → returns **nothing**
   outside the known exceptions (`customer_payments` insert, `customers`
   insert, `stock_counts`, `expenses`, `product_stock`).
3. **No policy dropped** — policy count per (table, command) ≥ 1 for every
   table; nothing fell to deny-all.
4. **Non-canonical diff** — each regenerated expression = pre-apply
   expression **+** the appended `AND current_user_is_org_manager(org_id)`,
   nothing else moved.

### Runtime (owner, real app, closed hours)

- Manager account: add a product, edit a price, confirm a stock count, add a
  supplier, record an expense → all succeed.
- Member path (a real member-role account if one exists, else shared device
  + cashier PIN): take a credit payment → succeeds; add a customer at the
  till → succeeds; raw `PATCH /rest/v1/products` with that token → **403**.
- A till sale through `submit_sale_batch` → succeeds (DEFINER bypass
  intact). Offline queue replay → succeeds.

### Claude cannot run

Anything needing a live session token, real PINs, or the `pg_policy` dump —
the owner owns those. Standing rule: never read live PIN values.

## Open items for the implementation plan

- Pin the exact Bucket A list and the canonical/non-canonical split from the
  owner's `pg_policy` dump.
- Per-table write-path audit (client `.from()` writes + non-DEFINER
  function writes).
- Assign the migration number (next free after 118 /
  `20260819000000_add_default_supplier.sql`).
- Draft the rollback block.
- Write the PR-body verification checklist.
