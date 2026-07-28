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
number, never reuse a prefix. Latest applied: **070**.

**`default_user_org_id()` returns NULL under the service role**, so any table
whose `org_id` defaults to it (e.g. `stock_counts`, `product_location_prices`)
will fail its `NOT NULL` constraint when written by a script using
`SUPABASE_SERVICE_ROLE_KEY` — the function resolves the caller through
`auth.uid()`, which is null for the service key. Set `org_id` explicitly in any
server-side or admin-API insert. The same applies to any column defaulting to a
`current_user_*()` helper. (Surfaced writing `scripts/record-opening-count.mjs`,
which failed on exactly this until it passed `org_id` on every row.)

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

Settings → Plan & Billing shows the current plan, renewal date, a "Change plan" button
(opens `PricingModal`), and — for active subscribers — a "Manage subscription" button
that opens Paystack's customer portal (card updates, cancellation) via
`/api/billing/manage`.

**Manage subscription** (`/api/billing/manage`, `src/app/api/billing/manage/route.ts`):
looks up the org's `billing_subscription_id`, calls Paystack's
`/subscription/{id}/manage/link` to mint a single-use portal URL, and returns it for the
client to open (card updates, cancellation). Returns 404 if no active subscription, 503
if Paystack is unconfigured. The "Manage subscription" button in Settings → Plan &
Billing is visible only to owners with an active subscription.

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
- **`ReceiptViewer`** (`src/components/ui/receipt-viewer.tsx`) — opens an attachment
  from the row's paperclip. The bucket is private, so each open mints a fresh
  5-minute signed URL; there is no permanent link. The loaded URL is stored
  alongside the path it belongs to and compared on render, so switching receipts
  shows "Loading…" rather than briefly showing the previous one.
- **A delivery's receipt is copied onto the "Stock Purchases" expense it
  auto-creates**, so it opens from either screen. Not finding it under Expenses
  invites recording the delivery twice — which inflates Total Outflows, though
  profit is safe (the category is held out of operating expenses).
- **One file therefore has two owners, so deletion is reference-counted.**
  `deleteReceiptIfUnreferenced()` (`src/lib/receipt-storage.ts`) counts rows in both
  tables *after* the row is gone and removes the object only when nothing points at
  it. It bails if either count query errors — an orphan wastes a little storage,
  deleting a referenced file destroys a receipt.
- **Uploads happen on file-pick, before save**, so abandoning a form strands an
  object. The expense modal discards it on cancel. **Known gap:** navigating away
  from Receive Stock mid-entry still orphans one; the upload widget's X is the
  clean exit. `scripts/cleanup-orphaned-receipts.mjs` reconciles the bucket
  (dry-run by default, skips objects under an hour old so it cannot race an
  in-flight upload).
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

## Stock can't go negative — three different mechanisms

Worth knowing which, because only one is a real guarantee:

- **Sale (POS)** — `deduct_stock_at_location` clamps: `GREATEST(quantity - n, 0)`.
- **Transfer** — checks availability and raises `Insufficient stock at source`.
- **Warehouse (WMS)** — a true DB constraint, `wms_inventory_qty_nonneg` (043).

`product_stock.quantity` is plain `INTEGER NOT NULL DEFAULT 0` with **no CHECK**, so
shop stock is protected by application logic alone; a direct UPDATE could write -5.

**The POS deliberately does not block overselling** (`pos/cart.tsx`: "stock warning,
not a block") — a wrong count must not stop a real sale at the till. So the clamp is
reached in normal trade, and **selling 10 against 6 leaves stock at 0 with the
4-unit shortfall discarded.** Keep the clamp: negative stock would break assumptions
the POS, reporting and reorder logic all rely on. What changed is that the number is
now written down before being clamped away.

**`stock_oversells` (migration 058)** records `requested` / `available` / `shortfall`
at the moment of the deduction, because it is unrecoverable afterwards — once the
quantity is 0 there is no telling "landed on zero" from "went four under".

- **`deduct_stock_at_location` takes a 4th arg, `p_source` (`'sale'` | `'adjustment'`).**
  Stock adjustments call the same RPC, so without it a breakage write-off that
  exceeded stock would be reported as a till oversell. Adding it required dropping
  the 3-arg form (a 3-arg call would otherwise be ambiguous) — **and that drop
  silently restores `PUBLIC EXECUTE`**, so 058 re-applies 040's REVOKE/GRANT pair.
  Any future redefinition must do the same.
- **`SELECT … FOR UPDATE`** locks the row so concurrent tills cannot each
  independently miss the shortfall.
- **No write policy on the table** — only the SECURITY DEFINER function inserts, so a
  client can neither fabricate an oversell nor delete an inconvenient one.

## Revenue Assurance reports BOTH directions

`unrecordedUnits` was `Math.max(unitsSold - recordedSales, 0)`, which reported only
units leaving the shelf unrecorded. The reverse — more rung up than stock movement
explains, i.e. exactly what an oversell produces — collapsed to 0 and **rendered as a
green tick**. On live data that was 307 units across 18 of 34 products being
certified as reconciled.

Movement is now kept signed and split: `unrecordedUnits` and `oversoldUnits`, exactly
one ever non-zero. Three places independently asserted "all clear" and all three had
to change or the fix leaks — the row cell, the **discrepancies filter** (which would
otherwise hide the very rows it exists to surface), and the **summary card**, which
keyed its green off missing revenue, a figure an oversell never touches.

- **Oversells get no rand figure.** The money came in; the stock figure was
  understated. Putting a number in "missing revenue" would misstate it as a loss.
- **Write-off stays gated on the unrecorded direction.** It decreases stock, which on
  an oversold row deepens the error. Those rows get the comment button instead.
- The recorded-shortfall panel renders **only when there are records** — an empty one
  would read as "no problems" when it means "no data yet", since nothing before 058
  was captured. The inferred column remains the answer for historic periods.

**Replenishment is scoped by branch (migration 059).** RA filters counts, sales and
oversells by location, but `stock_receipts` had no `location_id`, so its
replenishment query was org-wide — every delivery was credited to **every** branch,
inflating expected stock where nothing arrived and rendering the gap as shrinkage that
never happened. 059 adds a nullable `stock_receipts.location_id`; Receive Stock writes
`currentLocationId` (the branch it already deducts stock at), and RA now filters on it.
**`location_id IS NULL` means "recorded before 059, branch unknown" and is still
counted org-wide** — dropping those rows would rewrite historic figures rather than fix
them, so the 29 pre-059 receipts stay unattributed by design (a receipt's branch is
unrecoverable once its units merge into `product_stock`). Both sides tolerate either
deploy order: Receive Stock retries without the column on `PGRST204`, and RA's filtered
read falls back to org-wide if the column is missing (that query previously **discarded
its error**, which would have zeroed replenishment). This is why
`scripts/record-opening-count.mjs` writes a stock count, not a receipt — see that
script's header. RLS is unchanged: `stock_receipts` stays org-scoped, not
org+location, so an owner still sees every branch's deliveries.

## POS grid/list view toggle

`ProductGrid` (`src/components/pos/product-grid.tsx`) has a toggle button next to the
search bar that switches between the tile grid and a single-row list view. Built for
operators with long product names (e.g. Chichi's "Artificial Flower Arrangement …")
where `line-clamp-2` truncates to uselessness.

- **Grid** (default) — compact tiles, 2–5 columns depending on breakpoint, names
  clamped to two lines.
- **List** — full product name on the left, price on the right, one row per item.
  No truncation.

Both views share the same RENDER_CAP (200), discount/low-stock badge logic, and
`onAddToCart` handler. `viewMode` is component state (not persisted across page loads).

## POS typeable cart quantity

The +/− stepper in `src/components/pos/cart.tsx` wraps a native
`<input type="number" min={1} inputMode="numeric">`. The `onFocus` handler
auto-selects the text for quick overwrite. Invalid or blank input is ignored — the
line keeps its previous quantity until the user types a valid integer ≥ 1. Setting
quantity to zero is not possible via the input; the trash button is the only way to
remove a line. The parent POS page implements both `onUpdateQty` (delta) and
`onSetQty` (absolute) callbacks.

## Partial returns and credit notes

Returns are modelled as **negative-quantity rows in `sales`** (migration **064**), so
every existing SUM-based report (revenue, COGS, VAT, cash intake) nets out
automatically with no changes to reporting queries.

- **`sales.return_of_sale_id`** — FK to the original sale being returned.
- **`sales.credit_note_number`** — format `CN-YYMMDD-HHMM-XXXX`.
- **`record_sale_return` RPC** enforces: qty > 0, original must not be voided or itself
  a return, cumulative returned qty cannot exceed original. Atomically inserts the
  negative row, restocks the branch via `restock_at_location`, and for credit sales
  reduces the customer balance via `adjust_customer_balance`.
- **`src/components/pos/credit-note.tsx`** renders a printable credit note. Handles
  both `refundMode: "cash"` and `"account"`.

## P&L ex-VAT

`src/app/(dashboard)/profit-loss/page.tsx` reads `vatPercent` from `useOrg()`. When
the org is VAT-registered (`vatPercent > 0`), every revenue and COGS figure is divided
by `(1 + vatPercent/100)` via the `exVat()` helper. Section headers annotate
"(ex-VAT)" and a separate VAT Summary card shows output VAT (collected), input VAT
(on stock purchases), and net payable. Non-VAT-registered orgs see raw figures with
no VAT card. The extraction assumes all prices are VAT-inclusive, which is the
standard for the SADC market.

## POS low-stock warning

Tiles show an amber "N left" badge at **5 units or fewer** (`LOW_STOCK_AT` in
`pos/product-grid.tsx`). The POS overwrites `opening_stock` with the current
location's quantity before rendering, so this is the branch figure. It covers 5 down
to 1 — the grid already filters to stock above zero, so at zero the item leaves the
grid, which is its own signal. `products.reorder_level` exists and could drive a
per-product threshold; a flat 5 was chosen deliberately.

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

## Timezone-safe date utility

`src/lib/date-utils.ts` exports `toLocalDateStr(d)`, `localToday()`,
`localYesterday()`, `localMonthStart()`, `localWeekStart()` — all returning
`YYYY-MM-DD` in the browser's local timezone. **Every client-side "today" must use
these**, not `new Date().toISOString().split("T")[0]` (which returns UTC — a SAST user
at 01:30 local sees yesterday's date). ~40 call sites were migrated.

`daily-report.ts` intentionally uses UTC — it's a server-side cron running at 04:30 UTC
(06:30 SAST), well clear of the midnight boundary.

## Shrinkage on P&L (migration 068)

`stock_adjustments.cost_price` (migration **068**) snapshots `products.cost_per_unit`
at adjustment time. The P&L page queries decrease adjustments for loss reasons
(Breakage, Expired, Theft, Damaged, Samples — not Correction or Other) and shows a
**"Shrinkage & Losses"** line inside the COGS section. Gross profit =
`revenue - COGS - shrinkage`. Pre-068 rows have NULL `cost_price` and are counted
separately with a warning ("N older adjustments not costed").

`daily-report.ts` was updated to value adjustments at cost (snapshot `cost_price` →
product `cost_per_unit` → `selling_price` fallback), not selling price.

## Inventory valuation card

The P&L page shows an **"Inventory on Hand"** card (indigo theme) — point-in-time
snapshot of current stock × `cost_per_unit`. Not period-dependent, always shows current
stock. Products with NULL `cost_per_unit` are counted separately with a warning.

## Shift opening (simplified)

Shift opening (`src/app/(dashboard)/shift/page.tsx`) now shows only the opening float
input and Open Shift button. No stock count info or prompts — operators open immediately.
Stock count is still required for **closing** (if `requiresStockCountToClose` org setting
is enabled). The previous day's closing stock carries forward automatically via
`product_stock.quantity`.

## Daily reconciliation (migration 070)

Migration **070** changed `daily_reconciliation`'s unique constraint from `recon_date`
(single-tenant legacy) to `(org_id, recon_date)`. The Sales page upsert now includes
`org_id` explicitly and uses the composite `onConflict: "org_id,recon_date"`. Without
this, multi-tenant orgs got RLS errors — the old constraint matched another org's row,
then RLS blocked the update.

## Period lock (migration 069)

`period_locks` (migration **069**) — one row per org, `locked_through DATE`,
`UNIQUE(org_id)`, RLS owner-only write / any org member read.

- **Settings UI** (`src/components/settings/period-lock-section.tsx`): owner-only, date
  picker max=yesterday, can only advance forward.
- **`src/lib/use-period-lock.ts`**: reusable hook, exposes `isLocked(date)`.
- **Guards**: sale void (`sales/page.tsx`), expense delete (`expenses/page.tsx`), stock
  adjustment (`stock-adjustments/page.tsx`) — all check `isLocked(date)` and refuse with
  a clear message. Sale returns are blocked when the original sale's date is locked.
- Client-side guard only (no DB trigger). A determined user with SQL access can bypass
  it — acceptable for management accounts.

## Admin scripts (`scripts/`)

All scripts use `--env-file=.env.local` and require `SUPABASE_SERVICE_ROLE_KEY`. Dry-run
by default; add `--apply` to execute.

- **`set-reorder-levels.mjs`** — bulk update `reorder_level` for all products in an org,
  excluding "Ingredients" category. Usage: `--org "Shop Name" --level 5 [--apply]`
- **`seed-branch-stock.mjs`** — set flat stock qty at a branch (new location bootstrap).
- **`record-opening-count.mjs`** — write stock count rows for a branch.
- **`cleanup-orphaned-receipts.mjs`** — remove storage objects with no DB reference.
- **`add-cashiers.mjs`**, **`rename-inventory-prefix.mjs`** — one-off data migrations.
