# Tilify — Claude Code guide

Tilify (repo/remote name `tuck-shop`) is MK Global SA's multi-tenant POS / inventory /
Revenue-Assurance PWA for SADC retailers. Next.js (App Router) + Supabase + Tailwind.

Setup, migration numbering, and the Supabase CLI baseline caveats live in `README.md` —
read it before running anything that writes to the database.

## Health Stack

- typecheck: `node node_modules/typescript/bin/tsc --noEmit`
- lint: `node node_modules/eslint/bin/eslint.js .`
- The `node_modules/.bin` shims fail in some environments — call the JS entrypoints
  directly (as above, and `node node_modules/supabase/dist/supabase.js …` for the CLI).
- `next build` / `next dev` can be unreliable in constrained sandboxes (SIGBUS); rely on
  `tsc` + `eslint` locally and let Vercel build the PR.

## Deployment

Production is `https://tilify.mkglobal.co.za`, served by the Vercel project
**`tilify-jimmy`** (account `mumba-kunda-s-projects`). That mapping is recorded only in
the gitignored `.vercel/repo.json`, so it is invisible from a fresh clone — hence this
note. A second project, `tuck-shop`, also built this repo and was deleted 2026-07-24;
it held no custom domain, but it *did* deploy `vercel.json`, so the
`/api/cron/daily-reports` cron was firing twice each morning until then.

**"It's pushed but the site is unchanged" is usually a missing deploy, not stale cache.**
Vercel silently produced no build for one commit (`ea26e89`) — no deployment record, no
commit status, no check run — while every neighbouring commit deployed within a minute.
Check before touching code, and note that an empty commit re-fires the webhook:

```
gh api repos/mumbak2-cell/tuck-shop/deployments --jq '.[0:3][] | "\(.sha[0:7])  \(.created_at)  \(.environment)"'
```

**The Vercel CLI's `--non-interactive` does not suppress every prompt.**
`vercel project remove` still asked "Are you sure?", took EOF as `N`, deleted nothing —
and **exited 0**. Never read a zero exit from that CLI as proof the action happened; the
`--yes` flag does not exist on that subcommand. Pipe the answer (`printf 'y\n' | …`) and
verify the result independently.

## Local dev server — check this BEFORE debugging "my changes aren't showing"

**This project is `C:\26June\Dev\tilify`.** A stale duplicate checkout exists at
`C:\26June\Dev\Dev\tilify` (note the doubled `Dev\Dev`, alongside the TripPulse folder).
It sits on an old `main` from around PR #13 and is **not** this project. A dev server
started from there serves months-old code, so edits never appear — and it has been found
hung, with `localhost:3000` timing out entirely.

- Start the server from the `tilify-dev` entry in `.claude/launch.json` (via `preview_start`),
  never by running `next dev` from whatever directory happens to be current.
- If localhost hangs, or edits don't show up, **verify what is actually serving the port
  before touching the code**:
  `netstat -ano | grep :3000`, then check that PID's command line — the path must be
  `C:\26June\Dev\tilify`, not `...\Dev\Dev\tilify`. Kill the stale process and restart from
  the correct folder.
- Symptom seen in practice: code typechecks clean, the branch has the new commits, yet the
  browser shows old UI or nothing at all. That is this problem, not a code bug.

## Load-bearing invariants (don't break these)

- **One org per user.** `create_organization_for_user` rejects a second membership, and
  `default_user_org_id()` resolves a user's org with `SELECT … LIMIT 1` (no `ORDER BY`).
  A user with two `org_members` rows gets a nondeterministic active org and their POS
  rows can leak into the wrong tenant. Never attach an existing user to a second org.
- **RLS helpers** used across policies: `current_user_org_ids()` (all memberships),
  `current_user_writable_org_ids()` (subscription/trial gate — writes only), and
  `current_user_location_ids()` (owners/admins → every location; cashiers → their
  assigned one). New org+location-scoped tables should mirror the `product_stock`
  policy set (read: org+location; write: writable-org+location).
- **Sales snapshot price.** `sales.unit_price` and `sales.cost_price` are captured at
  sale time (via `submit_sale_batch`), so reporting must read those, never recompute
  revenue from `products.selling_price`.
- **`REVOKE … FROM PUBLIC` does not lock down a function on Supabase.** Supabase's
  default privileges grant EXECUTE on every new function to `anon`, `authenticated` and
  `service_role` **by name**. `PUBLIC` is a different grantee, so revoking it leaves all
  three untouched. Migration 040 revoked `PUBLIC` from twelve SECURITY DEFINER functions
  and reads as though it closed them; verified 2026-07-24, every one still shows
  `anon=X`. Closing a function properly means `REVOKE EXECUTE … FROM anon` explicitly.
  **What actually protects these is the in-function guard, not the grant** — they call
  `assert_org_writable()`, which resolves the caller through `auth.uid()` and so rejects
  an anonymous caller before touching data. Never drop that guard on the assumption the
  grant covers it. Check an ACL with:
  `SELECT proname, array_to_string(proacl,' ') FROM pg_proc WHERE proname = '…';`
- **PostgREST `.upsert({ onConflict })` cannot target a PARTIAL unique index.** It can't
  emit the index's `WHERE` predicate, so Postgres raises `42P10` — and if the error is
  destructured away (`const { data } = await …`), the write silently no-ops.
  `invoice_events(provider, provider_reference) WHERE provider_reference IS NOT NULL`
  (migration 037) is one such index: log with a plain INSERT and treat the `23505`
  unique-violation as the duplicate signal. This exact bug left the Paystack webhook
  inert in production for weeks — every delivery "succeeded" while reconciling nothing.

## Migrations

Applied by hand (SQL Editor or the Management API query endpoint), **then** recorded:
`node node_modules/supabase/dist/supabase.js migration repair --status applied <NNN>`.
History is baselined, so never `db push` without repairing first. One migration per
number, never reuse a prefix. Latest applied: **057**.

**The SQL Editor runs a whole script as ONE transaction.** If any statement fails,
*everything before it rolls back* — including `ALTER TABLE`s that appeared to succeed.
Do not then re-run "just the failing part": the earlier statements are gone. Re-run the
whole script from the top, which means **migrations must be idempotent**
(`ADD COLUMN IF NOT EXISTS`, `DROP POLICY IF EXISTS` before `CREATE POLICY`,
`ON CONFLICT DO NOTHING`). 057 was not, and a rolled-back failure left production with
its storage policies but neither `receipt_path` column nor the bucket — while
`migration repair` had already recorded 057 as applied, so the history said otherwise.

**Verify DDL landed before repairing**, and fold the checks into ONE result set — the
SQL Editor only displays the *last* statement's output, so a multi-query verification
silently hides the first checks:
`SELECT 'column: ' || table_name FROM information_schema.columns WHERE … UNION ALL SELECT …`

**A missing column surfaces as a useless error.** PostgREST returns `PGRST204` as a plain
object, not an `Error`, so `err instanceof Error ? err.message : "Unknown error"` prints
**"Unknown error"** and hides the cause. Read `.message` off the object in catch blocks.

## Billing (Paystack subscriptions)

All Tilify subscriptions bill in **ZAR via Paystack**, whatever the operator's POS
currency (`BILLING_CURRENCY` in `src/lib/plans.ts`; `providerForCurrency()` always
returns paystack — the MWK price block was deleted as dead code). Three tiers × three
cycles, in minor units: Starter R299 / R849 / R2,990, Growth R599 / R1,699 / R5,990,
Pro R999 / R2,799 / R9,990 (monthly / quarterly / annual — quarterly ~6% off, annual two
months free).

**Recurring Plan codes live in env, never in source.** `src/lib/paystack-plans.ts`
resolves one per (tier, cycle) from `PAYSTACK_PLAN_<TIER>_<CYCLE>` — nine variables,
`STARTER|GROWTH|PRO` × `MONTHLY|QUARTERLY|ANNUAL`. Test-mode and live-mode codes are
**different strings**, so they belong to the deployment, and `plans.ts` is imported
client-side so codes must never be put there. A missing code degrades that cycle to a
one-time charge instead of failing.

Paystack behaviours that cost a full debugging session — don't "simplify" these away:

- `transaction/initialize` **requires `amount` even when `plan` is supplied** (omitting it
  returns "Invalid amount"). Send both; Paystack overrides the amount with the Plan's.
- A valid `plan` code *always* creates a Subscription. If a charge succeeds but no
  subscription appears, the code is wrong or from the other mode — not a webhook bug.
- Re-checking out the same plan for an already-subscribed customer creates **no** new
  subscription and emits no `subscription.create`.
- Cancelling emits **`subscription.not_renew`**, not `subscription.disable`; our handler
  treats it as a no-op, so the org keeps access until `current_period_end`.

**Webhook org resolution** (`src/app/api/billing/webhook/paystack/route.ts`,
`resolveOrgId`): only `charge.success` carries `metadata.org_id`. Subscription-lifecycle
events carry none **and can arrive before** the charge that stores the customer code, so
resolution falls through metadata → `billing_customer_id` → `billing_subscription_id` →
**customer email** (`auth.users` → `org_members`, deterministic under one-org-per-user).
Drop the email fallback and subscription events are silently lost with `org_id` NULL.

Access is gated by `current_user_writable_org_ids()` as redefined in migration 035:
active **with a future `current_period_end`**, or trialing with a future `trial_ends_at`.

**Known gap:** `PricingModal` is only reachable from `TrialBanner`, which renders solely
when `subscription_status = 'trialing'`. An active paying customer has **no way to
upgrade, downgrade, or change cycle** in the app — worth a "manage plan" entry in
Settings.

**Temporary:** `src/app/api/billing/plan-check/route.ts` is a token-gated diagnostic
(plan-code validity + key mode) kept for the live cutover. **Delete it once live billing
is verified.**

## Suppliers (master list)

`suppliers` (migration **050**) — org-scoped list (name, phone, email, notes, active),
`UNIQUE(org_id, lower(trim(name)))` so one supplier can't exist in several spellings.
RLS mirrors `products` (read: org; writes: writable-org). Managed at `/suppliers`;
`SupplierSelect` (with inline "add new") feeds Receive Stock and WMS Purchase Orders.

**The four tables that record a supplier (`stock_receipts`, `purchases`,
`wms_purchase_orders`, `wms_receipts`) still store the supplier NAME in their existing
`supplier` TEXT column — deliberately not FKs**, since they hold historical rows read by
several reports. The list is the source of the dropdown, not a join. Trade-off: renaming
a supplier does not rewrite past deliveries.

## Recipe costing (prepared food)

**The whole area is gated behind the `prepares_food` app setting.** It hides the
Ingredients page (`foodOnly` in `sidebar.tsx`), the "prepared food item" checkbox on
the product form, and therefore the Recipe section — which only renders once that box
is ticked. If Ingredients or recipes appear to be "missing", check this setting before
the code: until PR #51 it was writable only during first-time setup, so shops created
without it had no way to switch it on. It now lives in Settings → Prepared Food, and
`handleSave` calls `refreshOrg()` so the sidebar updates without a reload.

Before migration **055**, every prepared item sold at **zero cost**:
`products.cost_per_unit` was generated as `package_price / qty_in_pack`, a prepared
item has neither, so it computed to NULL and the POS fell back to `?? 0`. Nothing
reached COGS while the ingredients were logged as expenses.

- **`cost_per_unit` is still generated, but now
  `COALESCE(recipe_cost_per_unit, package_price / qty_in_pack)`.** Every reader (POS
  cart, dashboard, products list) is unchanged — don't "simplify" the COALESCE away.
- **`products.recipe_cost_per_unit` is trigger-maintained. Never write it from the
  app.** `recalc_recipe_cost(product_id)` fires from `recipes`, from
  `ingredients.purchase_price`/`purchase_qty`, and from `products.units_per_batch`.
  Recalculating only on save would leave costs stale the moment a price changed.
- **The two inputs that make a recipe costable are nullable on purpose.**
  `ingredients.purchase_qty` (how many `unit`s `purchase_price` buys — `purchase_size`
  is free text like "2.5kg bag" and must never be parsed) and
  `products.units_per_batch` (batch yield). NULL = not costed yet, behaving exactly as
  pre-055. A guessed pack size produces a confidently wrong cost that feeds profit.
- **An incomplete recipe must return NULL, not a partial sum.** SQL `SUM()` skips NULL
  rows silently, which would understate cost, so `recalc_recipe_cost` counts missing
  inputs explicitly and bails.

**Inventory is not an operating expense.** `INVENTORY_EXPENSE_CATEGORIES` in
`src/types/database.ts` lists the categories that buy stock rather than consume it —
`Stock Purchases` and `Ingredient Purchases` (migration **056**). Profit & Loss holds
both out of operating expenses, because their cost reaches the books through COGS when
the item sells; counting them in both places charges the same goods twice (PR #48 for
stock, #52 for ingredients).

**Cash spent deliberately excludes only `Stock Purchases`, not both.** Receive Stock
writes that expense automatically beside its `stock_receipts` row, so it is a duplicate;
a hand-typed ingredient has no such row and the money really did leave the till. P&L is
accrual, Cash spent is cash basis — **do not "unify" the two lists.** Both call sites
carry this warning.

## Receipt attachments (Supabase Storage)

Migration **057** introduces Tilify's first use of Supabase Storage. A private
`receipts` bucket stores PDF/image attachments for expenses and stock receipts,
scoped by org via RLS on `storage.objects` (policies match
`(storage.foldername(name))[1]` against `current_user_org_ids()`).

- **`expenses.receipt_path`** and **`stock_receipts.receipt_path`** — nullable TEXT
  columns holding the storage path (`{orgId}/{uuid}.{ext}`). The app stores the
  path on insert; files are accessed via signed URLs (private bucket).
- **`ReceiptUpload`** (`src/components/ui/receipt-upload.tsx`) — reusable component
  used in both the Record Expense modal and the Receive Stock form. Accepts PDF,
  JPEG, PNG, WebP up to 5 MB. Shows a dashed upload area, switches to a file-name
  chip after upload, and cleans up storage on removal.
- **`current_user_org_ids()` returns `SETOF UUID`**, not an array — use it with
  `IN (SELECT current_user_org_ids())`, never with `unnest()`.

## Prepared-food stock toggle

Receive Stock has a **"Prepared food?"** toggle button. When active:

- `total_cost` is saved as 0 on the receipt (ingredient costs are already captured).
- The "How was this paid?" section and "Also record as Stock Purchases expense"
  checkbox are hidden — no expense entry is created.
- The save button shows "Save Receipt" without a cost amount.

This prevents double-counting: prepared items' costs flow through ingredient
purchases and COGS via the recipe costing system (see Recipe costing above).

## Multi-location model

- `locations` — branches. Users switch active location via `org-context.tsx`
  (`currentLocationId`, `switchLocation`); cashiers are pinned to `assigned_location_id`.
- `product_stock` (migration 024) — per-branch quantity, `UNIQUE(product_id, location_id)`.
  POS shows only items with stock > 0 at the current location.

## Branch pricing (per-location price overrides)

Chichi's-driven feature (multi-branch shops charging different prices for some items).
Model: **base price + overrides**.

- **`products.selling_price`** is the base price, org-wide.
- **`product_location_prices`** (migration **042**) holds optional per-branch overrides,
  keyed `(product_id, location_id)` `UNIQUE`, `selling_price >= 0`, `org_id DEFAULT
  default_user_org_id()`, RLS mirroring `product_stock`. **Absence of a row = use the
  base price**, so only genuine exceptions are stored.
- **Effective price = override for the current location, else `products.selling_price`.**
- **POS** (`src/app/(dashboard)/pos/page.tsx`, `fetchProducts`): overlays the current
  location's override onto each product's `selling_price` (online path + offline cache
  via `buildPriceMap`). Cart → promotions → `unit_price` sent to `submit_sale_batch` all
  flow from `selling_price`, so pricing is correct end to end and reporting is unaffected
  (unit_price is snapshotted). Override reads are wrapped so a failure degrades to base
  prices rather than breaking the POS.
- **Offline** (`src/lib/offline-sync.ts`, `src/lib/offline-store.ts`): overrides are
  cached under the `product_location_prices` cache kind alongside `product_stock`.
- **Product form** (`src/components/products/product-form.tsx`): a "Prices per branch
  (optional)" section shows **only for orgs with more than one location**. A blank field
  (or one equal to the base price) removes the override; a value upserts it. Overrides
  are validated before the product write and reconciled after.

To use it: add branches under Locations, distribute stock per branch (POS needs stock > 0
to show an item), then override prices only on the items/branches that differ.
