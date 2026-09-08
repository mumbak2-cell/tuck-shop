# Role-scoped write RLS (Security Phase 2) — design

**Date:** 2026-09-08
**Status:** approved design (v2, post-review), pending implementation plan
**Scope:** one Supabase migration (`119_role_scoped_write_rls.sql`) + optional
small client-side role guards. No change to any server RPC.

> v2 rewrite after three review passes. v1 assumed policy names/shapes from
> reading migration files; the live schema diverged (mig 0230 renamed a
> batch to `_loc_*`, WMS/`zra_*` use a single `FOR ALL` policy, child
> tables have no `org_id`, several ledgers are deliberately append-only).
> The governing principle of v2: **every table decision and every generated
> statement comes from a live `pg_policy` dump, never from migration-file
> reading.**

## Problem

`017_multitenant_foundation.sql` gave every tenant table RLS policies gated
**only** on `org_id IN (SELECT current_user_org_ids())` — no role predicate.
A signed-in `org_members.role = 'member'` (cashier) account can therefore
INSERT / UPDATE / DELETE any row in its own org via PostgREST directly —
products, prices, promotions, suppliers, reconciliation, WMS inventory,
report recipients — even though every such screen is manager-only in the UI.
The UI is the only control.

A few tables were retrofitted with an inline role check since:
`product_stock` (053), `expenses` (046, actually *row*-scoped not
role-scoped), `location_settings` **reads** (100). `sales` had a
`DROP POLICY` for its update/delete that was likely a no-op (name already
changed by 0230 — see Non-canonical handling).

## Goal

**Write-lockdown only.** Add a manager-role predicate to the
INSERT / UPDATE / DELETE policies of every table that a `member` can
currently write and shouldn't. SELECT policies are left functionally
unchanged (the POS and the offline cache read them). This extends the
mig-053 pattern to the whole schema, driven off the live policy catalogue.

Out of scope: per-role SELECT restrictions; honouring `org_members.permissions`
JSONB (077) in RLS; schema changes for row-owner scoping beyond what already
exists.

## Deployment models — what this defends

Two operator models exist in the product:

- **Model 1 (dominant in MK's own shops):** one shared device signed into
  Supabase as the owner/admin account; operators separated by a till PIN
  (`auth-context.tsx` → `create_till_session`). The PIN "cashier" role is an
  **app-layer** concept — RLS always sees `owner`/`admin`. **Nothing in this
  migration changes Model 1 behaviour.**
- **Model 2 (a built, supported feature):** a cashier is invited via
  Settings → Team with role "Cashier" (`api/team/route.ts` `desiredRole =
  "member"`), gets their own email + password login, signs in at `/login`.
  `assigned_location_id` + `current_user_location_ids()` exist specifically
  for this. Per-member PIN hashing (108) is for this. Seat limits are for
  this.

**This design defends Model 2.** An org that provisioned real cashier
logins is exactly who the direct-PostgREST hole exposes. Consequently the
member-write whitelist (Bucket B) must keep every write path a Model-2
cashier legitimately performs, or the migration bricks their POS.

## Decisions

| Question | Decision |
|---|---|
| Helper style | `current_user_manager_org_ids() RETURNS SETOF uuid`, gate `org_id IN (SELECT current_user_manager_org_ids())` — set-style, uniform with `current_user_org_ids()`, single InitPlan (not a per-row correlated `is_manager(org_id)` call) |
| Helper `search_path` | `SET search_path = ''`, all objects schema-qualified (`public.org_members`, `pg_catalog`…) — a bare `public` leaves `pg_temp` implicitly first, allowing a `CREATE TEMP TABLE org_members` shadow against a SECURITY DEFINER function |
| Honour `permissions` JSONB | No — role only this phase |
| Deployment model | Defend Model 2 (real member logins) |
| Member direct-write whitelist (Bucket B) | `customer_payments`, `customers`, `stock_counts`, `shifts`, `daily_reconciliation`, `stock_count_audit` — see table for per-command detail |
| Source of truth for the migration body | A full live `pg_policy` dump. Nothing decided from migration files. |
| Rollout structure | helper + one sweep migration; a `DO` loop **only** for tables proven canonical by the dump; explicit hand-written blocks for everything else |
| Migration number | `119` |

## Governing principle: pin everything to a live dump

Before any migration SQL is written, the owner runs this in the SQL Editor
and pastes the full result back:

```sql
SELECT c.relname                          AS tbl,
       p.polname,
       p.polcmd,                          -- 'r' select, 'a' insert, 'w' update, 'd' delete, '*' all
       p.polpermissive,
       (SELECT array_agg(r.rolname) FROM pg_roles r WHERE r.oid = ANY (p.polroles)) AS roles,
       pg_get_expr(p.polqual,      p.polrelid) AS using_expr,
       pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr
FROM pg_policy p
JOIN pg_class c ON c.oid = p.polrelid
WHERE c.relnamespace = 'public'::regnamespace
ORDER BY 1, 3, 2;
```

Also dump, for column checks:
```sql
SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'public' AND column_name IN ('org_id','location_id','recorded_by_user_id')
ORDER BY 1,2;
```

The implementation plan transcribes the migration from these two results.
No table is placed in a bucket, and no `DROP`/`CREATE` name is written,
except from this data.

## Components

### 1. Helper function

```sql
CREATE OR REPLACE FUNCTION public.current_user_manager_org_ids()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT m.org_id
  FROM public.org_members m
  WHERE m.user_id = auth.uid()
    AND m.role IN ('owner','admin');
$$;
REVOKE EXECUTE ON FUNCTION public.current_user_manager_org_ids() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.current_user_manager_org_ids() TO authenticated;
```

`STABLE`, `SECURITY DEFINER`, `search_path = ''` (pg_temp cannot shadow),
mirrors the `current_user_org_ids()` contract but hardened. `auth.uid()` is
resolved via `pg_catalog`/`auth` — qualify as `auth.uid()` (it already is
schema-qualified by the `auth` schema).

Note for the plan: the sibling helpers (`current_user_org_ids`,
`current_user_writable_org_ids`, `current_user_location_ids`,
`default_user_org_id`) all carry the same bare-`public` `search_path` and
the same latent `pg_temp` exposure. **Not fixed here** (out of scope, and
changing four load-bearing functions is its own risk) — filed as a
follow-up in the security backlog.

### 2. Migration `119_role_scoped_write_rls.sql`

One file. `SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '120s';`
at the top so a blocked run fails clean instead of wedging the DB. Structure:

- **Part 1** — the helper.
- **Part 2 — canonical loop.** A `DO $$` over an explicit
  `canonical_tables[]` array. A table is in this array **only if the dump
  proves** all of: (a) it has an `org_id` column; (b) it has exactly one
  permissive policy per write command and each is named `<t>_org_insert` /
  `<t>_org_update` / `<t>_org_delete`; (c) each policy's expression is
  *structurally* the plain org-scope shape with no extra clause; (d) it is
  not an append-only ledger. For each: `DROP POLICY IF EXISTS` the real
  name, `CREATE POLICY` with the **table's current expression verbatim**
  plus `AND org_id IN (SELECT current_user_manager_org_ids())`. The loop
  preserves whichever of `current_user_org_ids()` /
  `current_user_writable_org_ids()` the table already uses on each command
  — it does not normalise them (some 017-era tables still use
  `current_user_org_ids()` on INSERT; swapping that in silently adds
  trial-gating).
- **Part 3 — explicit blocks**, one per table, for everything not in the
  canonical array:
  - **`_loc_*` / bare-named / `plp_*` tables** — `DROP` the real policy
    name, `CREATE` with the current expression + the manager gate.
  - **`FOR ALL` single-policy tables** (WMS older set, `zra_*`) — `DROP`
    the `FOR ALL` policy, `CREATE` a `FOR SELECT` policy with the old
    expression (member read preserved) **and** `FOR INSERT/UPDATE/DELETE`
    policies with the old expression + the manager gate.
  - **child tables without `org_id`** (`combo_items`, `promotion_items`,
    `purchase_order_items`, WMS `*_items`) — gate via the parent:
    `<parent>_id IN (SELECT id FROM <parent> WHERE org_id IN (SELECT current_user_manager_org_ids()))`,
    against the real policy names.
  - **Bucket B tables** — see next section.

Re-runnable: `DROP POLICY IF EXISTS` before every `CREATE`,
`CREATE OR REPLACE FUNCTION`.

### 3. Client role guards (small, optional, ship in the same PR)

Model-2 cashier screens that write a now-manager-gated table need a
client-side `role`/`can()` check so a blocked action is a disabled control
or a clear message, not a raw `permission denied` from PostgREST. The plan
inventories these from the per-table audit; expected set is small
(e.g. the `/sales` reconciliation panel — `sales/page.tsx` — which today
renders with no role gate). Server RLS is the boundary; these are UX.

## Table classification

Provisional only — the dump is authoritative.

### Bucket A — manager-gated (canonical loop OR explicit block)

Every table with `org_id` and an org-only write policy set that a member
should not write. Includes, by name family:

- **canonical `_org_*`:** `products, ingredients, recipes, categories,
  expense_categories, suppliers, payment_methods, locations, app_settings,
  purchases, stock_receipts, stock_receipt_items, ra_notes, promotions`
  *(each pending dump confirmation of the `_org_*` name + plain shape)*
- **`_loc_*` (explicit block, keep any location clause):** `sales`
  (incl. restoring 078's intended full removal of member update/delete),
  `stock_adjustments`, `balance_adjustments`
- **bare-named (explicit block):** `combos`, `promotion_items`,
  `purchase_orders`, `purchase_order_items`, `location_settings`,
  `report_subscriptions`
- **`plp_*` (explicit block):** `product_location_prices`
- **`FOR ALL` decompose:** `zra_config`, `zra_invoices`, and every
  `wms_*` data table (`wms_catalog, wms_inventory, wms_locations,
  wms_org_settings, wms_adjustments, wms_dispatches, wms_dispatch_items,
  wms_receipts, wms_receipt_items, wms_transfers, wms_transfer_items,
  wms_purchase_orders, wms_po_items, wms_stock_counts,
  wms_stock_count_sessions, wms_stock_count_audit`)
- **child tables (parent-scoped):** `combo_items`, `promotion_items`
  (if no `org_id`), `purchase_order_items`, WMS `*_items`

### Bucket B — member may write (explicit blocks; keep existing scope, gate only the rest)

| Table | Member may (unchanged) | Gated to manager | Scope preserved |
|---|---|---|---|
| `customer_payments` | INSERT | UPDATE, DELETE | keep `customer_payments_loc_*` names + `location_id IN (SELECT current_user_location_ids())` |
| `customers` | INSERT | UPDATE, DELETE | keep `_loc_*` names + location clause |
| `stock_counts` | INSERT, UPDATE, DELETE | — (leave as-is) | already `FOR ALL` `stock_counts_write_location`, location-scoped (026). **No statements** unless the dump shows drift. |
| `shifts` | INSERT, UPDATE | DELETE | `shifts` has `location_id` (0230); keep `shifts_loc_*` names + location clause on the member-allowed commands |
| `daily_reconciliation` | INSERT, UPDATE | DELETE | org-scoped (no `location_id`; unique `(org_id, recon_date)`) |
| `stock_count_audit` | INSERT | UPDATE, DELETE | org-scoped; member INSERT is required — a cashier editing a saved count writes audit rows (`stock/page.tsx` `saveAllCounts`), and the row is lost silently if blocked |

For the member-allowed commands, the policy is the table's **current**
expression, unchanged (no manager gate added). For the gated commands,
current expression + `AND org_id IN (SELECT current_user_manager_org_ids())`.

`customer_payments` residual abuse surface (member can insert any
`customer_id`, any `amount`, backdated `payment_date`, no attribution):
**plan decides** whether to also add, in this migration,
`recorded_by_user_id uuid DEFAULT auth.uid()` + `WITH CHECK
(recorded_by_user_id = auth.uid())` + `CHECK (amount > 0)`, mirroring 046 —
or to document it as accepted residual risk. Not silently left unmentioned.

### Bucket C — untouched

- every `FOR SELECT` policy that is not part of a `FOR ALL` decompose
- `product_stock` (053, already manager-gated), `expenses` (046, row-scoped
  — members deliberately insert their own; note: "role-scoped" in v1 was
  wrong)
- **append-only ledgers — client has no write policy by design, writes are
  DEFINER-RPC only:** `stock_movements` (087), `stock_oversells` (058),
  `stock_transfers` (0280 — read-only client), `production_log` (no client
  writes — grep `src`). The sweep must **not** create write policies on
  these.
- `organizations`, `org_members` (role-scoped in 017)
- `till_sessions`, `till_pin_attempts` (109/110 own model)
- `period_locks` (069)
- platform tables: `platform_admins, partners, referrals,
  commission_payouts, admin_org_overrides, invoice_events, audit_logs,
  wms_rpc_idempotency, partner_applications` (104, service-role writes only)

## Policy SQL shapes

### Canonical loop

```sql
DO $$
DECLARE t text; ins_expr text; upd_using text; upd_check text; del_using text;
  canonical_tables text[] := ARRAY[ /* pinned from dump */ ];
BEGIN
  FOREACH t IN ARRAY canonical_tables LOOP
    -- current expressions captured in the plan from the dump, one CASE per table,
    -- OR: read them live here from pg_policy and re-append. Simplest: hard-code
    -- the verbatim current clause per table in the plan; the loop only appends.
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_org_insert', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (%s AND org_id IN (SELECT current_user_manager_org_ids()))',
                   t||'_org_insert', t, ins_expr);
    -- …_org_update (USING + WITH CHECK), …_org_delete (USING) likewise
  END LOOP;
END $$;
```

The plan will most likely **not** use a loop with per-table `CASE`
expressions — it is cleaner to emit ~15 explicit canonical blocks too, each
a 3-policy DROP+CREATE with the verbatim current clause + gate. The loop
stays only if the dump shows a genuinely uniform set. Either way: no
assumed names, no normalised helpers.

### `FOR ALL` decompose (example shape)

```sql
DROP POLICY IF EXISTS "org_isolation" ON public.wms_inventory;
CREATE POLICY "wms_inventory_org_read"   ON public.wms_inventory FOR SELECT
  USING (<old org_isolation USING expr>);
CREATE POLICY "wms_inventory_org_insert" ON public.wms_inventory FOR INSERT
  WITH CHECK (<old expr> AND org_id IN (SELECT current_user_manager_org_ids()));
CREATE POLICY "wms_inventory_org_update" ON public.wms_inventory FOR UPDATE
  USING (<old expr> AND org_id IN (SELECT current_user_manager_org_ids()))
  WITH CHECK (<old expr> AND org_id IN (SELECT current_user_manager_org_ids()));
CREATE POLICY "wms_inventory_org_delete" ON public.wms_inventory FOR DELETE
  USING (<old expr> AND org_id IN (SELECT current_user_manager_org_ids()));
```

### Bucket B (example — `customer_payments`)

```sql
-- INSERT: unchanged (member may take a credit payment at the till); keep name + location scope.
DROP POLICY IF EXISTS "customer_payments_loc_insert" ON public.customer_payments;
CREATE POLICY "customer_payments_loc_insert" ON public.customer_payments FOR INSERT
  WITH CHECK (<current customer_payments_loc_insert check_expr>);   -- verbatim, no gate

-- UPDATE / DELETE: manager only, location scope kept.
DROP POLICY IF EXISTS "customer_payments_loc_update" ON public.customer_payments;
CREATE POLICY "customer_payments_loc_update" ON public.customer_payments FOR UPDATE
  USING      (<current using_expr>  AND org_id IN (SELECT current_user_manager_org_ids()))
  WITH CHECK (<current check_expr>  AND org_id IN (SELECT current_user_manager_org_ids()));
DROP POLICY IF EXISTS "customer_payments_loc_delete" ON public.customer_payments;
CREATE POLICY "customer_payments_loc_delete" ON public.customer_payments FOR DELETE
  USING (<current using_expr> AND org_id IN (SELECT current_user_manager_org_ids()));
```

## Rollout

**Code:** the optional client guards ship in the PR and can deploy any time
(they only ever *add* a friendlier block; they never grant access). No
ordering constraint against the migration.

**Migration:**
1. Merge PR (migration + spec + plan + guards).
2. Owner runs the two dumps (above), pastes back; plan finalises the
   migration body against them; owner re-pulls if the migration changes.
3. Owner applies `119` in the Supabase SQL Editor (project
   `pkufxpyrvcygobrgneep`) **at the start of a full closed day** — not the
   night before a trading day — so a missed member path surfaces with a
   day of runway, not mid-shift.
4. Run post-apply verification (below) in the same session.
5. `npx supabase migration repair --status applied 119`.
6. First trading day: check PostgREST logs / `pg_stat_statements` for
   `42501` (`permission denied`) spikes.

**Transaction:** one `BEGIN/COMMIT` with `SET LOCAL lock_timeout` +
`statement_timeout`. Each policy change is independent and idempotent, so
the atomicity is convenience not correctness; the timeouts matter more than
the single-txn wrapper. If `lock_timeout` fires (realtime / pg_cron /
backup holding a conflicting lock), re-run — no partial state.

## Failure modes

| # | Risk | Mitigation |
|---|---|---|
| 1 | Legacy-named ungated policy left in place → OR semantics keep member write (v1's core bug) | Every `DROP` targets the real `polname` from the dump. Post-apply check 2 asserts **no** IUD policy on a Bucket A table lacks the gate — authoritative over "count ≥ 1" |
| 2 | Table mis-bucketed as canonical → loop overwrites its expression, drops an extra clause | Post-apply check 3 diffs **every** touched policy against the pre-apply dump: new expr must equal old expr `+ " AND org_id IN (SELECT current_user_manager_org_ids())"` and nothing else |
| 3 | Sweep *adds* a write policy to an append-only ledger (fail-open) | Append-only tables listed in Bucket C by name; the loop only touches tables with an existing `_org_*` write policy; check 4 asserts no new policy appeared on a Bucket C table |
| 4 | Member path missed → cashier 403 mid-shift, next trading day | Mandatory throwaway member-account runtime test (below); apply at start of a closed day; first-trading-day `42501` log check; rollback SQL pre-staged |
| 5 | `current_user_manager_org_ids()` returns nothing for a real manager → managers locked out of all writes | Verification 1 runs it for a known owner **and** a known admin id and asserts non-empty; closed-day window = owner testing live immediately |
| 6 | Child-table SQL references non-existent `org_id` → whole migration aborts | Column dump confirms `org_id` presence per table before bucketing; child tables always use the parent-scoped predicate |
| 7 | One txn's cross-table `AccessExclusive` locks wedge realtime/cron/backup | `SET LOCAL lock_timeout = '5s'` → clean failure + re-run |

## Rollback

**Generated from the pre-apply dump, not written ahead of it.** For every
policy the migration `DROP`s or `CREATE`s, the rollback `DROP`s the new one
and `CREATE`s the original with its exact captured `polname`, `using_expr`,
`check_expr`, and command. Then `DROP FUNCTION public.current_user_manager_org_ids()`.
One transaction, same `lock_timeout`. Shipped as a fenced block in the PR
body, produced once the dump is in hand. A static "restore the 017 shape"
block is **wrong** — the real baseline is 018/035 (`writable_org_ids`) for
canonical tables and table-specific for the rest, and a blind 017 restore
re-opens the trial gate and strips location/state clauses added by
054/078/098/099/100.

## Verification

No test suite in this repo — verification is manual, shipped as a PR-body
checklist.

### Pre-apply (implementation)

- Owner runs the two dumps; plan transcribes the migration from them.
- Claude: per-table write-path audit — every `.from("<table>").(insert|
  update|delete|upsert)` in `src/` (including calls split across lines and
  via `insertOrQueue` / `offline-ops.ts` replay), mapped to
  {screen, reachable by member?, Bucket}. Confirm every Bucket A write is
  manager-only in the UI or has a client guard added.
- Claude: confirm the only non-DEFINER functions writing Bucket A tables
  are the four known triggers (`sync_product_opening_stock`,
  `products_autolink_wms_catalog`, `create_wms_inventory_row`,
  `sync_referral_status`), all of which run in a manager/DEFINER context.

### Post-apply (owner, SQL Editor, closed day)

1. **Helper** — `SELECT current_user_manager_org_ids();` as the owner →
   non-empty; repeat impersonating a known `admin` (non-empty) and a known
   `member` (empty). `SELECT DISTINCT role FROM org_members` → exactly
   `{owner,admin,member}`.
2. **Coverage** — for every Bucket A table, assert: the gate substring
   appears in `polwithcheck` for the INSERT policy, in **both** `polqual`
   and `polwithcheck` for UPDATE, in `polqual` for DELETE. Output every
   `(table, polname, polcmd)` that fails. Zero failures expected. The
   exception list (Bucket B member-allowed commands, Bucket C) is frozen in
   this spec, not chosen at run time.
3. **Expr diff (all touched policies)** — new `using_expr`/`check_expr`
   equals old `+ " AND org_id IN (SELECT current_user_manager_org_ids())"`
   for gated commands, or equals old verbatim for Bucket B member-allowed
   commands. Any other delta = bug.
4. **No new surface** — no INSERT/UPDATE/DELETE policy exists on any
   Bucket C append-only table; no table gained a policy for a command it
   had none for pre-apply (unless a `FOR ALL` decompose, which is
   expected and enumerated).

### Runtime (owner, real app, closed day) — mandatory

- Create a **throwaway `role = 'member'` account** assigned to one
  location. Sign in as it in a separate browser.
- Cashier write paths that must still work: open a shift → close a shift;
  offline-queue a shift op then reconnect and confirm it drains and
  sign-out is clean; take a credit payment (`customer_payments`); add a
  customer at the till; take a stock count and edit a saved count row
  (`stock_counts` + `stock_count_audit`); save the `/sales` Till
  Reconciliation (`daily_reconciliation`).
- Cashier write paths that must now fail cleanly (client guard message,
  not raw error, where a guard was added): edit a product / price / promo;
  add a supplier; `PATCH /rest/v1/products` with the member JWT → **403**;
  `POST /rest/v1/report_subscriptions` with the member JWT → **403**.
- Manager account: add a product, edit a price, CSV bulk import, confirm a
  stock count, add a supplier, WMS receive → all succeed.
- A till sale via `submit_sale_batch` and an offline sale replay → succeed
  (DEFINER bypass intact).
- Delete the throwaway account after.

### Claude cannot run

Anything needing a live session/JWT, real PINs, the `pg_policy` dump, or
account creation — owner owns those. Standing rule: never read live PIN
values.

## Open items for the implementation plan

- Run the two dumps; freeze the exact Bucket A list and each table's bucket
  + real policy names + verbatim current expressions as a checked-in table.
- Per-table write-path audit across `src/` and `offline-ops.ts`.
- Decide `customer_payments` hardening (add `recorded_by_user_id` +
  `amount > 0` now, or document residual risk).
- Inventory the client role guards to add (expect: `/sales` recon panel;
  possibly others from the audit).
- Draft the rollback block from the dump.
- Write the PR-body verification checklist.
- Confirm `shifts.location_id` exists in the live schema (0230 header says
  it was added; not seen as a standalone `ALTER` — likely added in 0230's
  `DO` block).
- File the sibling-helper `search_path` hardening as a separate backlog
  item.
