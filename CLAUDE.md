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
number, never reuse a prefix. Latest applied: **051**.

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
