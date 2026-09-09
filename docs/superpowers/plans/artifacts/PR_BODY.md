# Security Phase 2: role-scoped write RLS (migration 119)

## Status: migration 119 ALREADY APPLIED to production 2026-09-08

The owner applied `supabase/migrations/119_role_scoped_write_rls.sql` in the
Supabase SQL Editor (project `pkufxpyrvcygobrgneep`) on 2026-09-08. It
committed clean. This PR is the **code review + record** — the migration
file, the two client guards, and the full verification/rollback artifact
set. It is not a "please apply" PR.

**Still outstanding:** `supabase migration repair --status applied 119` was
not run (the npm `supabase` CLI is broken on the build host — `uv_spawn`).
The prod `supabase_migrations.schema_migrations` ledger does not list `119`.
Record it via the working Go binary
(`node_modules/@supabase/cli-windows-x64/bin/supabase-go.exe migration repair --status applied 119`)
or a direct `INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('119')`.

## What it does

`017_multitenant_foundation.sql` gave every tenant table RLS policies gated
only on `org_id` — no role predicate. A signed-in `org_members.role =
'member'` (cashier) account could INSERT/UPDATE/DELETE any row in its org
via PostgREST directly (products, prices, promotions, suppliers,
reconciliation, WMS inventory, report recipients), despite every such
screen being manager-only in the UI.

119 adds `public.current_user_manager_org_ids()` (set-returning, `STABLE
SECURITY DEFINER`, `search_path = ''`) and appends
`AND org_id IN (SELECT current_user_manager_org_ids())` to the
INSERT/UPDATE/DELETE policies of ~46 tables. SELECT policies are unchanged.

### Deployment models

- **Model 1** (MK's own shops): one shared device on an owner/admin Supabase
  account, operators separated by a till PIN. RLS always sees owner/admin —
  **nothing changes**.
- **Model 2** (a built feature: cashier invited via Settings → Team,
  `role='member'`, own login): this is what 119 protects. The frozen
  member-write whitelist (Bucket B) keeps every cashier hot path working:
  open/close shift, take a credit payment, add a customer at the till, save
  the daily reconciliation, take/edit a stock count.

## Scope

| Bucket | Tables | Action |
|---|---|---|
| A canonical | `app_settings, categories, expense_categories, ingredients, locations, payment_methods, production_log, products, purchases, ra_notes, recipes, stock_receipt_items, stock_receipts, suppliers` | gate i/u/d |
| A `_loc_*` / bare / `plp_*` | `balance_adjustments, stock_adjustments, sales` (gate INSERT, **drop** UPDATE+DELETE), `combos, promotions, purchase_orders` (update is USING-only), `location_settings` (read untouched — keeps the mig-100 PIN clause), `report_subscriptions, product_location_prices` | gate i/u/d |
| A FOR-ALL decompose | 12 `wms_*` `org_isolation` + `wms_stock_count_sessions`; `wms_locations`, `wms_org_settings`, `zra_config`, `zra_invoices` `_write` | split `FOR ALL` → ungated `_org_read` + gated `_org_insert/update/delete` |
| A child (no `org_id`) | `combo_items, promotion_items, purchase_order_items` | gate the parent subquery (`insert`+`delete` only; no `update` policy exists) |
| B (member keeps some writes) | `customer_payments` INSERT · `customers` INSERT · `shifts` INSERT+UPDATE · `daily_reconciliation` INSERT+UPDATE · `stock_count_audit` INSERT · `stock_counts` (all — unchanged) | keep those verbatim; gate the rest |
| C (untouched) | platform tables, `organizations`/`org_members`, `period_locks`, `product_stock` (053), `expenses` (046), and append-only ledgers `stock_movements`/`stock_oversells`/`stock_transfers`/`wms_transfers`/`wms_transfer_items` (no write policy — 119 must not add one) | none |

~140 policies touched.

## Client guards (this PR)

Two manager-only controls sat in the cashier navigation and now throw a raw
403 for a real member account; guarded to hide the control:
- `src/app/(dashboard)/customers/page.tsx` — Edit button hidden when `role === 'member'`.
- `src/app/(dashboard)/expenses/page.tsx` — "Manage Categories" button behind `can('manage_expenses')` (matches the sibling panel in that file).

**Deferred (not in this PR):** ~20 admin-only screens with gated writes have
no client guard — a cashier typing one of those URLs directly gets a 403
toast. RLS is the boundary; guards are UX for the expected cashier surface.
Add later if it matters. Also deferred: the `insert_customer` offline-replay
`upsert` can park (not jam) on a partial-replay edge — a one-line
`existing`-id short-circuit, separate change.

## Verification

Built + verified on a synthetic policy-layer DB (bare `postgres:16`, schema
generated from the prod `pg_policy` dump — the Tilify migration series does
not replay from zero, see below). All green:
- helper attributes correct; migration idempotent (2nd apply clean).
- **Q2 coverage = 0 rows** — every gated policy references the helper in the
  right clause (INSERT→WITH CHECK, UPDATE→both, DELETE→USING).
- **Q4 = 16/16** FOR-ALL tables decomposed to 1 ungated read + 3 gated writes.
- **Q5 = 0 rows** — no write policy added to an append-only ledger.
- **exprdiff = 0 violations** — every touched policy differs from pre-119 by
  exactly the appended gate, nothing else.
- **rollback dry-run = 141/141 policies byte-identical to pre-119.**

**Confirmed on prod** by the owner post-apply: Q1 (helper `provolatile=s`,
`prosecdef=t`, `proconfig=["search_path=\"\""]`) and **Q2 = 0 rows**.

Runtime leg (owner, in-app): manager writes still work; a `role='member'`
account keeps its hot paths and gets a permission error (not a crash) on a
gated action.

## Rollback

`docs/superpowers/plans/artifacts/rollback_119.sql` — generated from the
pre-119 dump; restores every touched policy to its exact prior name and
expression and drops the helper. Dry-run confirmed byte-identical
restoration. One transaction, `lock_timeout` guarded.

## Known repo issues surfaced (out of scope — file separately)

- The migration series does not replay from zero: `066`/`067` are
  tenant-specific one-shot data fixes with `RAISE EXCEPTION` guards; `080`
  REVOKEs on `restock_at_location`, a function no migration creates; `097`
  is a duplicated numeric prefix (`schema_migrations_pkey` collision).
- `080` REVOKEs `restock_at_location(uuid,uuid,integer)` but call sites pass
  `(uuid,integer,uuid)` — signature mismatch.
- The npm `supabase` CLI (`uv_spawn`) is broken on the build host.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01XAfmhEs4uWFrfLSV66pPcF
