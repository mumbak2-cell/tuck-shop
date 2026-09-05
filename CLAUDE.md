# Tilify — Claude Code guide

Tilify (repo/remote name `tuck-shop`) is MK Global SA's multi-tenant POS / inventory /
Revenue-Assurance PWA for SADC retailers. Next.js (App Router) + Supabase + Tailwind.

Setup, migration numbering, and the Supabase CLI baseline caveats live in `README.md` —
read it before running anything that writes to the database.

## Security headers

`next.config.ts` sets the static response headers on all routes:
`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`
disabling camera/mic/geo.

The Content-Security-Policy is NOT there — it's generated per-request in
`src/proxy.ts` (Next.js 16's middleware-rename), because it carries a fresh
nonce on every request that a static header can't express. script-src is
nonce + `'strict-dynamic'` (no `unsafe-inline`); style-src is `'self'
'unsafe-inline'` (see proxy.ts's header comment for why those two directives
are handled differently). If a new external origin is needed (e.g.
analytics, CDN), add it to the CSP `connect-src` or `script-src` directive
in `src/proxy.ts`, not `next.config.ts`. `src/app/layout.tsx` calls
`connection()` to force every route to render dynamically — required for
the nonce to work at all; do not remove it without understanding why
(proxy.ts's header comment explains).

## Health Stack

- typecheck: `node node_modules/typescript/bin/tsc --noEmit`
- lint: `node node_modules/eslint/bin/eslint.js .`
- The `node_modules/.bin` shims fail in some environments — call the JS entrypoints
  directly (as above, and `node node_modules/supabase/dist/supabase.js …` for the CLI).
- `next build` / `next dev` can be unreliable in constrained sandboxes (SIGBUS); rely on
  `tsc` + `eslint` locally and let Vercel build the PR.
- **`tsconfig.tsbuildinfo` (incremental cache, gitignored) can mask a real type error.**
  `tsc --noEmit` came back clean locally for a file that failed Vercel's build seconds
  after push — an implicit-`any` on a `.map()` callback that `strict: true` should
  have caught. The stale incremental cache from an earlier clean run was the reason.
  This shipped two broken production deploys (300b2b8, 571ac52) before being caught by
  checking deployment status, not by the local typecheck. `rm tsconfig.tsbuildinfo`
  before trusting a clean `tsc --noEmit` result on a file touched earlier in the same
  session — or just always delete it first, since it's gitignored and free to rebuild.

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
- **A `sales` row is one CART LINE, not a transaction.** One basket writes N rows.
  Anything transaction-level therefore needs care: `sales.cash_back` (073) is written
  **once, on the first line only**, and summed — writing it per line would multiply it
  by basket size. `sales.transaction_id` (074) groups a basket, generated inside
  `submit_sale_batch`. Count baskets, not rows, when reporting "transactions".
- **`submit_sale_batch` has two-phase idempotency (migration 101).** "Sale exists" and
  "stock was deducted" are tracked separately via `sales.stock_deducted_at`. On replay:
  (1) all rows exist + all deducted → return early; (2) all rows exist + some not
  deducted → deduct only, set flag; (3) new sale → insert + deduct + set flag. This
  closes the gap where a stock count overwrite could absorb a deduction with no audit
  trail. Returns and voided rows have NULL `stock_deducted_at` by design (returns
  restock, voids reverse).
- **Widening `submit_sale_batch` needs the old signature DROPPED first.** Adding an
  argument otherwise leaves two overloads and PostgREST cannot choose between them:
  *"Could not choose the best candidate function"*, and **every till stops selling**.
  This happened in production on migration 072. Give new arguments a DEFAULT so the
  migration can be applied ahead of the deploy, and always apply the migration
  **before** pushing the frontend that uses it — never the reverse.
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
- **Billing columns are trigger-protected (migration 078).** `trg_protect_billing`
  silently restores 10 billing columns (`subscription_plan`, `subscription_status`,
  `trial_ends_at`, `billing_*`, `last_charge_*`, `current_period_end`) to their
  OLD values when the caller is `authenticated`. Only service-role (webhooks) can
  write them. Do not remove or weaken this trigger.
- **Sales rows are immutable to clients (migration 078).** The `sales_org_update`
  and `sales_org_delete` RLS policies were dropped. No authenticated user can
  UPDATE or DELETE sales rows via PostgREST. All mutations go through SECURITY
  DEFINER RPCs (`void_sale_lines`, `record_sale_return`) which bypass RLS. Do
  not re-add UPDATE/DELETE policies on sales.
- **Audit log (migration 079).** `audit_logs` is append-only for org members
  (SELECT via RLS, no INSERT/UPDATE/DELETE policies). Writes come only from
  SECURITY DEFINER triggers (e.g. `trg_log_sale_void`) and service-role. Do not
  add client write policies.
- **Location limits are trigger-enforced (migration 079).** `trg_check_location_limit`
  fires BEFORE INSERT on `locations` and checks the org's `subscription_plan` against
  hardcoded limits: trial/starter = 1, growth = 3, pro = unlimited. Only active
  locations count. The limit map must stay in sync with `src/lib/plans.ts`.
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
number, never reuse a prefix. Latest applied: **102**.

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

**The Supabase SQL Editor may not run a pasted multi-statement script on one
connection.** Temp tables, `BEGIN/COMMIT` blocks, and session variables created in one
statement may be invisible to the next. Migration 096 hit this: `CREATE TEMP TABLE` in
statement A, `SELECT` from it in statement B, "relation does not exist". Write each
migration as a sequence of independently-runnable statements that communicate only
through committed real-table data — never through temp tables, session state, or
transaction scope. Mark the file with `-- STATEMENT N:` headers so the operator knows
to paste and run each block separately.

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

## Public legal pages (Paystack compliance)

Paystack business activation requires terms, a refund/cancellation policy, and a visible
pricing structure on the website. Three **public** routes live under the `(legal)` route
group — deliberately outside `(dashboard)`, so no auth is needed (there is no
`middleware.ts`; gating is client-side in the route-group layouts, so a top-level route
is public by default):

- `/pricing` — tiers × cycles rendered from `PLANS` (source of truth), ZAR.
- `/terms` — Terms of Service (South-Africa-governed, POPIA, names Paystack as processor).
- `/refund-policy` — cancellation + refund policy.

`src/app/(legal)/_company.tsx` holds the `COMPANY` constants (MK Global SA (Pty) Ltd
details) and the shared `PageShell`. The pages are linked from the `(auth)` layout footer
(login/signup/forgot) and the Settings page footer. **The legal copy is a working draft,
not lawyer-reviewed** — treat wording as provisional.

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

## Purchase Orders (Reorder List → Receive Stock, migration 099)

`purchase_orders` / `purchase_order_items` let a Reorder List selection be
persisted and pulled back into Receive Stock instead of retyped. Deliberately
a **separate system from WMS's `wms_purchase_orders`** (migration 030,
085's state machine) — that one is keyed to `wms_catalog` and has a real
partial-receive workflow (Draft → Sent → Partially Received → Received);
this one is keyed to `products`/`ingredients` and is **full-receive-only**
(Draft → Received or Cancelled, no partial state) on purpose — YAGNI until
a shop actually needs partial receiving.

- **Reorder List**: "Create PO" persists the current selection and shows the
  resulting number. `po_number` is derived the same way GRN and sales
  receipt numbers already are (`src/lib/receipt-code.ts`): `PO-` + last 6
  hex digits of the row's UUID, generated client-side alongside an explicit
  `id` on insert, not a separate round trip. Any change to the
  selection/qty after creating (toggling a row, select-all) clears the
  saved PO number, forcing a fresh "Create PO" rather than silently leaving
  a stale number that no longer matches what's on screen.
- **Receive Stock**: "Load from PO" (only shown when open POs exist) lists
  `status = 'Draft'` POs, and loading one replaces the current lines,
  supplier and (if blank) notes — confirmed first if the form already has
  manual lines, so in-progress work isn't silently discarded.
- **`stock_receipts.po_id`** links a logged delivery back to the PO it
  closed. Saving marks the PO `Received` **best-effort** — if that update
  fails, the receipt and stock increment (already committed) are not rolled
  back; the PO is just left showing Draft. Same fail-open reasoning as the
  `po_id` PGRST204 fallback on the insert itself: never let a PO-linkage
  problem block recording that stock actually arrived.

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

## "I received stock and it shows zero" — the Scones investigation (2026-08-27)

A client (Destiny) reported prepared-food items reading 0 stock right after being
received, "previously flagged, still persisting." Worth recording the full diagnosis
because the obvious-looking cause (a live receiving bug) was wrong, and re-deriving
this from scratch is expensive — `scripts/audit-stock-reconciliation.mjs` exists
because of this investigation, use it first next time.

**Two separate things were going on, and conflating them wasted the first hour:**

1. **A real historical bug, already fixed.** Before commit `9f9a72d` (2026-08-21),
   tapping "Complete Sale" twice while it was loading created two real sales for one
   real purchase — `React.useState`'s `processing` flag doesn't commit synchronously,
   so a fast second tap could slip through before the button actually disabled. Every
   duplicate silently deducted stock a second time. No error, no oversell log entry:
   `deduct_stock_at_location` only logs to `stock_oversells` when a single deduction
   exceeds *available* stock at that instant, and there was usually enough buffer for
   the phantom second deduction to clear cleanly. The debt only surfaced later as
   "why did we run out early" — which is why it looked like *stock disappearing*
   rather than a duplicate-sale bug, and why grep-ing for oversells found nothing.
   Fixed by a `useRef` reentrancy guard (refs update synchronously, no render gap
   for a second tap to exploit) — see the commit message for the full mechanism.

2. **A misread of normal, working behaviour.** Once (1) was fixed, the client still
   saw fresh-received stock read 0 within the hour. This is `deduct_stock_at_location`'s
   documented clamp (see above) doing exactly its job: receive 20, six *genuine,
   distinct* sales (own `transaction_id`s, one tied to a named credit customer,
   verified individually) total 21 within 30 minutes, stock clamps to 0. Nothing
   missing — receipts and sales fully explain it. The daily Stock Count *was* already
   correcting each day's residual drift (confirmed sessions, `product_stock` upsert on
   confirm all checked and correct) — the "still persisting" feeling was the normal gap
   between a fast-moving item selling through and the next count catching up, not a
   sign the fix hadn't landed.

**The diagnostic method that actually worked**, after wasted time hand-querying
individual products: reconcile received − sold + adjustments against actual stock
**since each product's last CONFIRMED count**, not all-time. All-time reconciliation
re-surfaces debt a count has already corrected and makes a healthy shop look broken —
exactly what happened here, and exactly what `audit-stock-reconciliation.mjs`
automates. A **MISSING** result (expected > actual, nothing explains the gap) is a
live bug. A **SURPLUS** result (actual > expected) is almost always an item that's
never been counted (the script has to assume opening stock was 0, understating it) —
not a bug, a data gap. Check `--org "<shop>"` before assuming either.

**Also found and fixed while investigating**: `stock/page.tsx`'s Stock Count input
accepted negative closing counts with no validation — one shipped to production on
2026-08-18 (`closing_units: -10`, confirmed as-is). A physical count can never be
negative; `updateCount()` now rejects any non-digit keystroke at entry.

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
  both `refundMode: "cash"` and `"account"`. It takes an **`items[]` array**: a return
  of several products from one sale is one refund event under one credit note number,
  not one note per product.

## Receipt-level sales, void and returns (migrations 074–075)

The Sales page works in **receipts, not line items**. `src/app/(dashboard)/sales/page.tsx`
groups rows by `transaction_id` into a `SaleGroup` showing time, method, item count and
**total**, expandable to its lines.

- **Receipt code** — `src/lib/receipt-code.ts` derives a six-hex-digit code
  (`3F9A2C`) from a UUID. Printed on the receipt and used to find the sale again.
  Deliberately **derived, not stored**, so no column or RPC argument was needed.
- **Numbered from the transaction where possible**, falling back to the first line's id
  for a receipt printed while offline (no transaction exists until the queued sale
  reaches the server). `find_sale_by_receipt_code` (075) matches **either**, and is
  SECURITY INVOKER so RLS scopes the search to the caller's own shop.
- Before this, `generateReceiptNumber()` was called inside `buildReceiptData` and
  **never persisted** — so no receipt could be looked up, and it minted a *fresh random
  number on every render*, meaning the printed receipt, the WhatsApp image and the ZRA
  submission each carried a different number for the same sale. It is now generated once
  into `receiptNo` state after the sale is recorded.
- **`void_sale_lines` RPC (074)** voids a selected set of lines in one call and restocks
  via `restock_at_location`. The old client-side void bumped `products.opening_stock`,
  the pre-per-location field, so **voids at multi-branch shops never restored branch
  stock** — historic branch counts may be understated by past voids.
- The date picker reaches back beyond today, so period-lock checks test the **sale's own
  date**, not today's. Till Reconciliation is hidden on past days: it records the drawer
  as it is now, and showing it against an earlier date invites saving to the wrong day.

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

## WMS catalog → POS product link (migrations 081, 096)

WMS dispatches to Internal Shop destinations credit `product_stock` via
`add_product_stock_at_location` — but **only when `wms_catalog.product_id` is set**.
If NULL, the RPC silently succeeds: warehouse stock falls, shop stock doesn't rise.
This silent failure hit production three times before migration 096 fixed it.

- **`products.inventory_id`** is auto-generated (`PRD0001` …) by a BEFORE INSERT
  trigger and read-only in the product form. **`wms_catalog.sku`** is user-entered.
  They never match organically, so the SKU-based auto-link from migration 081 missed
  every org that added products through the UI.
- **Migration 096** added a name-based fallback: `LOWER(TRIM(item_name)) =
  LOWER(TRIM(name))`, only when exactly one product matches (ambiguous = skip). Both
  triggers (`trg_wms_catalog_autolink`, `trg_products_autolink_wms`) now try SKU
  first, then name. They fire on INSERT and on UPDATE of `sku`/`item_name` (catalog)
  or `inventory_id`/`name` (products).
- **Reconciliation tracking**: `wms_dispatch_items.reconciled_at` records whether a
  dispatch item was credited at dispatch time (`'1970-01-01'` sentinel), reconciled
  by migration 096 (real timestamp), or not yet processed (NULL). Prevents double-
  crediting on re-run.
- **Dispatch page warning**: when dispatching to Internal Shop, unlinked items show
  an amber banner listing the items that won't credit shop stock, and the post-dispatch
  toast warns about uncredited items.
- **Still-unlinked items** (different names between catalog and products) need manual
  linking or a matching product created. No manual-link UI exists yet.

## Per-manager admin permissions (migration 077)

`org_members.permissions` (JSONB, default `{}`) lets an owner grant or withhold
individual admin functions from a manager (`role = 'admin'`), in Settings → Team
(`team-section.tsx`). **Absence of a key, or anything but `false`, means granted** —
so every existing manager kept full access the moment this shipped; only an explicit
`false` revokes one. Owners are unaffected (always full access); cashiers
(`role = 'member'`) are unaffected too (never had these functions).

- `org-context.tsx` exposes `can(key: PermissionKey)`: `true` for owner, checks the
  permissions object for manager, always `false` for cashier. Eleven keys:
  `manage_suppliers`, `manage_locations`, `manage_stock_transfers`, `manage_expenses`,
  `manage_payment_methods`, `view_reports`, `void_sales`, `manage_blind_cashup`,
  `manage_warehouse`, `manage_shift_admin`, plus role-switching (below) is a separate
  owner-only action, not a permission key.
- **`void_sales`, `manage_blind_cashup`, `manage_warehouse`, and `manage_shift_admin`
  were deliberately moved off the shared till PIN.** Before this, voiding a sale,
  seeing the full cash-up reconciliation, reaching the Warehouse (WMS) module, and
  Reopen/Delete Shift were all gated on `useAuth().role === "admin"` — the till's
  shared admin PIN, unrelated to which named person is logged in. Anyone who knew the
  branch PIN got in, regardless of their actual org role. All four are now gated on
  the named manager's own `can(...)` check instead. Every other admin-only screen was
  already gated on `useOrg().role`, not the till PIN, so those just swapped
  `role === "owner" || role === "admin"` for `can("...")`.
- Editing permissions is owner-only, enforced server-side in
  `PATCH /api/team/[id]` (`requireOrgOwner`, not `requireOrgManager` — a manager
  cannot grant themselves access). Branch reassignment on that same endpoint stays
  open to managers (`requireOrgManager`) since it's day-to-day floor management.
- **Role switching** (`PATCH /api/team/[id]` with `{ role }`) lets an owner flip
  someone between Cashier and Manager in place instead of remove-and-re-add.
  Promoting to Manager requires 2+ locations (same floor as adding one fresh) and
  clears `assigned_location_id` (managers are never location-locked). Demoting to
  Cashier does **not** guess a branch — the row shows "No branch — cannot sell"
  until the owner picks one from the existing per-cashier location dropdown. The
  owner's own role can never be changed via this endpoint.

## Stock Count requires owner approval — always, no auto-apply

`stock/page.tsx`'s Save button under NO CIRCUMSTANCES writes `product_stock`.
Every save records to `stock_counts` with `confirmed_at: null` and shows up
as a pending session. The only path from a count to a stock-level change is
the explicit "Confirm and apply to stock" button on a pending session. This
applies even to the owner's own count, even from an admin till PIN. The
`canConfirm` flag (`useOrg().role === "owner"` AND `useAuth().role === "admin"`)
gates who can press Confirm, not what the Save button does.

Two prior versions of this had subtle holes and both leaked in production:

1. **Original:** `canApplyToStock = role === "owner"` — owner's Save wrote
   product_stock straight through. If the owner was the Supabase account on a
   shared tablet and someone punched the CASHIER pin to count, the save still
   ran under the owner and stamped itself confirmed. Every "cashier" count
   auto-applied and the approval loop was dead. Observed at Destiny on
   2026-08-13: a 30-item cashier count auto-applied, deflating stock across
   most SKUs (some by 40+ units) with no manager review.

2. **First fix:** required both org role owner AND till PIN admin. That closed
   the shared-tablet case for the owner's own PIN but still left one
   circumstance where a save auto-applied. The owner asked for zero
   circumstances, so the auto-apply path is now removed entirely.

Enforced in the frontend only. Migration 053's DB-level check on
`product_stock` still allows owner and admin to UPDATE, so a direct PostgREST
call as owner (or as any admin) still succeeds — the guard is in the app, not
the database. Any new caller that writes `product_stock` directly needs its
own justification for bypassing the confirm step.

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

## Shifts

Shift opening (`src/app/(dashboard)/shift/page.tsx`) shows only the opening float
input and Open Shift button. No stock count info or prompts — operators open immediately.
Stock count is still required for **closing** (if `requiresStockCountToClose` org setting
is enabled). The previous day's closing stock carries forward automatically via
`product_stock.quantity`.

**One shift per location per day** — enforced by the UI, not by a DB constraint.
`fetchShift` in `src/lib/shift-context.tsx` queries the most recent shift for today at
the current location; if one exists (open or closed), the "Start Shift" form is hidden.

**Admin shift controls** (`shift/page.tsx`): when a closed shift exists, admins see two
buttons:

- **Reopen Shift** — clears closing data (`closed_at`, `closed_by`, `closing_cash`) and
  sets status back to `"open"`. The opening float is **not** reset — use this when the
  float was correct but the shift was closed prematurely.
- **Delete Shift** — removes the shift row entirely so a fresh one can be started with
  the correct opening float. Use this when the cashier entered the wrong float or opened
  by mistake.

Both are gated on `role === "admin"` (the `UserRole` type is `"admin" | "cashier"` —
there is no `"owner"` variant). Cashiers see only the closed-shift summary.

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
- **`audit-stock-reconciliation.mjs`** — read-only, no `--apply`. Per product+branch,
  sums everything that's moved stock since the last *confirmed* stock count (receipts,
  non-voided sales, adjustments) and compares to current `product_stock.quantity`.
  Reports only real discrepancies — a "MISSING" result (stock gone with nothing to
  explain it) is a live bug; "SURPLUS" usually just means an item has never been
  counted (baseline assumed 0) or moved through an event type the script doesn't
  track (transfers, WMS credits). Run this before concluding "the stock is wrong"
  is a new bug — see the Scones investigation below for why.
- **`add-cashiers.mjs`**, **`rename-inventory-prefix.mjs`** — one-off data migrations.
