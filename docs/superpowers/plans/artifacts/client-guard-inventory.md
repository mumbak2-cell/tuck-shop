# Migration 119 — client guard inventory

Task 10 of `2026-09-08-role-scoped-write-rls`. Consumes `table-classification.md`.

**Question answered:** after migration 119 gates INSERT/UPDATE/DELETE on the Bucket A
tables (and the GATEd commands of Bucket B) to `org_members.role IN ('owner','admin')`,
which `src/` write paths does a **Model‑2 `role='member'` (real cashier account)**
session still reach with **no client‑side role guard**, so the write returns a raw 403
(or jams the offline queue) instead of a clean "not allowed"?

---

## Role model (how member vs manager is distinguished)

Two independent role signals exist:

| Signal | Source | Values | What it gates | Seen by RLS? |
|---|---|---|---|---|
| `useOrg().role` | `org_members.role` for the signed‑in Supabase user (`src/lib/org-context.tsx:278`) | `owner` \| `admin` \| `member` | `useOrg().can(key)` — returns `true` for owner, `permissions[key] !== false` for admin, **always `false` for `member`** (`org-context.tsx:423‑427`) | **Yes** — this is exactly what `current_user_manager_org_ids()` resolves (`owner`/`admin` ⇒ manager) |
| `useAuth().role` | till‑PIN session from `create_till_session` / `match_location_pin` (`src/lib/auth-context.tsx`) | `admin` \| `cashier` | the sidebar `roles: [...]` arrays (`src/components/layout/sidebar.tsx:63‑96`) and a few in‑page `tillRole === "cashier"` view tweaks | No |

Key facts:

- **`migration 119` keys off `useOrg().role` only.** A Model‑2 member has
  `org_members.role = 'member'`, so `current_user_manager_org_ids()` returns `{}` for
  them regardless of which till PIN they typed.
- **The sidebar gates on `useAuth().role` (the till PIN), not `useOrg().role`.** A
  Model‑2 member who is handed the branch **admin** PIN gets `useAuth().role === 'admin'`
  and sees every admin nav item — but RLS still sees them as `member`.
- **`src/app/(dashboard)/layout.tsx` has no route‑level role guard.** It requires a
  Supabase session + a till‑PIN session and then renders `children` for any role. So
  every dashboard route is URL‑reachable by a member; the sidebar is the only
  navigational gate.
- The `(wms)` layout **does** gate: `if (!org.can("manage_warehouse")) …` (`src/app/(wms)/layout.tsx:76`) — members are bounced out of the whole warehouse module.

**"Member‑reachable" in the table below** = reached through the normal cashier
workflow (an item in the sidebar whose `roles` array includes `cashier`). Admin‑only
screens are marked **URL‑only**: a member can still force them by typing the path or
with the shared admin PIN, but that is outside the Model‑2 cashier workflow and the
119 spec treats the resulting 403 as intended hardening.

---

## Inventory — every `src/` write to a 119‑gated command

Gated commands (from `table-classification.md`): **all of** insert/update/delete on
every Bucket A table; plus Bucket B **UPDATE+DELETE** on `customer_payments` &
`customers`, **DELETE** on `shifts` & `daily_reconciliation`, **UPDATE+DELETE** on
`stock_count_audit`. Member‑allowed (no guard ever needed): `customer_payments` INSERT,
`customers` INSERT, `shifts` INSERT/UPDATE, `daily_reconciliation` INSERT/UPDATE,
`stock_count_audit` INSERT, all of `stock_counts`, and `sales` mutation via the
`submit_sale_batch` / `void_sale_lines` DEFINER RPCs.

### A. Cashier‑workflow screens (sidebar `roles` includes `cashier`)

| file:line | screen | table + command | member‑reachable | guard exists | verdict |
|---|---|---|---|---|---|
| `src/lib/shift-context.tsx:178` (`deleteShift`) | `/shift` "Shift Closed" → Admin actions → Delete Shift | `shifts` DELETE — **gated** | Y (nav item `roles: ["admin","cashier"]`) | **Y** — button only renders under `canManageShift = can("manage_shift_admin")` (`src/app/(dashboard)/shift/page.tsx:81,448`); `can()` is `false` for `member` | **no guard needed** |
| `src/lib/shift-context.tsx:190` (`reopenShift`) | `/shift` → Admin actions → Reopen Shift | `shifts` UPDATE — member‑allowed | Y | Y (same `canManageShift`) | no guard needed (command is member‑allowed anyway) |
| `src/lib/shift-context.tsx:119,151,208` (`openShift`/`closeShift`/`markStockCountDone`) | `/shift`, `/stock` | `shifts` INSERT/UPDATE (direct + `insertOrQueue`/`enqueueOp`) — member‑allowed | Y | n/a | no guard needed |
| `src/app/(dashboard)/customers/page.tsx:493` (`CustomerFormModal.handleSave`, edit branch) | `/customers` → Edit (pencil) button → save | **`customers` UPDATE — gated** | **Y** (nav item `roles: ["admin","cashier"]`, `cashierGated` on `cashier_credit_sales`) | **N** — Edit button (`customers/page.tsx:352‑358`) and `openEdit` (`:113`) have no role check; page has no role guard | **GUARD NEEDED** (see below) |
| `src/components/expenses/manage-expense-categories-modal.tsx:80,100,125` (`handleAdd`/`handleRename`/`handleRemove`) | `/expenses` → **Manage Categories** button (`src/app/(dashboard)/expenses/page.tsx:233`) → modal | **`expense_categories` INSERT + UPDATE — gated** (Bucket A canonical) | **Y** (nav item `roles: ["admin","cashier"]`, **not** `cashierGated` — every till‑cashier sees `/expenses`) | **N** — the "Manage Categories" button at `expenses/page.tsx:233` has no `can()`/`role` check (unlike the sibling manager panel at `:294`); the modal has no internal guard | **GUARD NEEDED** (see below) |
| `src/components/expenses/manage-expense-categories-modal.tsx:102` (`handleRename`) | `/expenses` → Manage Categories → rename | `expenses` bulk UPDATE `.eq("category", old)` — Bucket C, `_loc_*` row/role‑scoped | Y | N (same trigger) | no guard needed for this line specifically — RLS silently limits a member to their own rows; the `expense_categories` writes above are the blocker |
| `src/app/(dashboard)/customers/page.tsx:507` (`insertOrQueue` `customers`) | `/customers` → Add Customer | `customers` INSERT — member‑allowed | Y | n/a | no guard needed |
| `src/app/(dashboard)/customers/page.tsx:682` (`insertOrQueue` `customer_payments`) + `:711` `db.rpc("adjust_customer_balance")` | `/customers` → Record payment | `customer_payments` INSERT — member‑allowed; balance via DEFINER RPC | Y | n/a | no guard needed / RPC‑only |
| `src/app/(dashboard)/sales/page.tsx:314` (`saveRecon`, update branch) | `/sales` → Till Reconciliation panel | `daily_reconciliation` UPDATE — member‑allowed | Y (`roles: ["admin","cashier"]`) | N (panel has no role gate — confirmed) | **no guard needed** — `daily_reconciliation` INSERT+UPDATE are in the frozen whitelist (only DELETE is gated, and no DELETE call exists) |
| `src/app/(dashboard)/sales/page.tsx:319` (`saveRecon`, insert branch) | `/sales` → Till Reconciliation panel | `daily_reconciliation` INSERT — member‑allowed | Y | N | no guard needed (same reason) |
| `src/app/(dashboard)/stock/page.tsx:263` (`saveCounts`) | `/stock` | `stock_counts` UPSERT — member‑allowed (all of `stock_counts`) | Y (`roles: ["admin","cashier"]`) | n/a | no guard needed |
| `src/app/(dashboard)/stock/page.tsx:288` (`saveCounts`) | `/stock` | `stock_count_audit` INSERT — member‑allowed | Y | n/a | no guard needed |
| `src/app/(dashboard)/stock/page.tsx:330,349` (`confirmSession`) | `/stock` → Confirm pending session | `product_stock` UPSERT (Bucket C, not in 119) + `stock_counts` UPDATE (member‑allowed) | N — `canConfirmSession` requires `canConfirm = role === "owner" && tillRole === "admin"` (`stock/page.tsx:57,385`) | Y | no guard needed (not member‑reachable; command not gated) |
| `src/app/(dashboard)/expenses/page.tsx:136` (`insertOrQueue` `expenses`), `:174` (`delete`) | `/expenses` | `expenses` INSERT/DELETE — **Bucket C** (`expenses_loc_*` already row/role‑scoped `role IN ('owner','admin') OR recorded_by_user_id = auth.uid()`, mig 046) | Y (`roles: ["admin","cashier"]`) | pre‑existing RLS row scope | no guard needed — not touched by 119; member insert/delete of *own* expense is by design |
| `src/components/pos/payment-modal.tsx:453` (`submitSaleBatch`) | `/pos` | `sales` etc. via `submit_sale_batch` DEFINER RPC | Y | n/a | RPC‑only |

`/credit-ledger` (cashier nav, `cashierGated`) contains **no writes**.

### B. Admin‑only screens (sidebar `roles: ["admin"]` — URL‑only for a member)

Every row below writes a **gated** Bucket A command, has **no** in‑page `role`/`can()`
guard, and is **not** in the cashier nav. After 119 a member who forces the URL gets a
403 — the intended server‑side enforcement. **Verdict for all: no guard needed** (the
119 spec accepts this; adding client guards to ~20 admin screens is out of scope for
this migration). Listed for completeness / future hardening.

| file:line | screen | table + command |
|---|---|---|
| `src/app/(dashboard)/products/page.tsx:151,265,284,650,673` | `/products` | `products` UPDATE |
| `src/app/(dashboard)/products/page.tsx:628,648` | `/products` | `categories` INSERT/UPDATE |
| `src/components/products/product-form.tsx:182,187` | `/products` (form) | `products` INSERT/UPDATE |
| `src/components/products/product-form.tsx:229‑244` | `/products` (form) | `product_location_prices` DELETE/UPSERT |
| `src/components/products/product-form.tsx:266,268,286` | `/products` (form) | `recipes` DELETE/INSERT |
| `src/components/products/csv-upload.tsx:198,244,282` | `/products` CSV import | `products` INSERT/UPDATE, `app_settings` UPSERT |
| `src/app/(dashboard)/ingredients/page.tsx:95,96` | `/ingredients` | `ingredients` INSERT/UPDATE |
| `src/app/(dashboard)/suppliers/page.tsx:84,85,101,112` | `/suppliers` | `suppliers` INSERT/UPDATE/DELETE |
| `src/components/suppliers/supplier-select.tsx:57` | supplier picker (receive‑stock, reorder — admin screens) | `suppliers` INSERT |
| `src/app/(dashboard)/locations/page.tsx:79,83,103,116` | `/locations` | `locations` INSERT/UPDATE/DELETE |
| `src/app/(dashboard)/settings/page.tsx:348` | `/settings` | `app_settings` UPSERT |
| `src/app/(dashboard)/settings/page.tsx:389‑512` | `/settings` | `location_settings` UPSERT |
| `src/app/(setup)/setup/page.tsx:121,134,157` | `/setup` (owner/admin onboarding) | `categories` / `payment_methods` INSERT, `app_settings` UPSERT |
| `src/components/settings/payment-methods-section.tsx:97,98,110,127` | `/settings` | `payment_methods` INSERT/UPDATE/DELETE |
| `src/components/settings/daily-digest-section.tsx:47,59,78,93` | `/settings` | `report_subscriptions` UPDATE/INSERT/DELETE |
| `src/app/(dashboard)/stock-adjustments/page.tsx:195` | `/stock-adjustments` | `stock_adjustments` INSERT |
| `src/app/(dashboard)/revenue-assurance/page.tsx:425,453,465,471` | `/revenue-assurance` | `ra_notes` INSERT, `stock_adjustments` INSERT, `products` UPDATE |
| `src/app/(dashboard)/receive-stock/page.tsx:282‑306,320,386,450,455,476` | `/receive-stock` | `stock_receipts` INSERT/UPDATE, `stock_receipt_items` INSERT/UPDATE, `purchase_orders` UPDATE, `expenses` INSERT |
| `src/app/(dashboard)/reorder/page.tsx:205,223` | `/reorder` | `purchase_orders` INSERT, `purchase_order_items` INSERT |
| `src/app/(dashboard)/promotions/page.tsx:260‑304` | `/promotions` | `promotions` INSERT/UPDATE, `promotion_items` INSERT/DELETE |
| `src/app/(dashboard)/promotions/page.tsx:352‑390` | `/promotions` | `combos` INSERT/UPDATE/DELETE, `combo_items` INSERT/DELETE |
| `src/app/(dashboard)/stockpilot-import/page.tsx:179,199` | `/stockpilot-import` | `product_stock` UPSERT (Bucket C), `stock_counts` UPSERT (member‑allowed) |

*Note: `manage-expense-categories-modal.tsx` is opened from the `/expenses` page (which
**is** in the cashier nav) via an **un‑gated** button — moved to section A as
guard‑needed item #2.*

### C. `(wms)/warehouse/**` — blocked at the layout

`wms_catalog`, `wms_inventory`, `wms_stock_counts`, `wms_stock_count_audit`,
`wms_locations`, `wms_purchase_orders` writes in
`src/app/(wms)/warehouse/{page,locations,stock-count,purchase-orders}.tsx` and
`src/components/wms/csv-catalog-upload.tsx` are all **not member‑reachable** —
`src/app/(wms)/layout.tsx:76` redirects any session where `can("manage_warehouse")` is
false, which includes every `member`. **No guard needed.**

### D. `src/app/api/**` route handlers

`zra_invoices`, `zra_config`, `report_subscriptions`, `org_members`, `organizations`,
`partners*`, `commission_payouts`, `admin_org_overrides`, `invoice_events` writes live
in API routes that run with the **service‑role key** (`admin.from(...)`) or a
server‑side user client behind their own `is_platform_admin()` / cron‑secret / org‑admin
checks. They do not use the browser `db` client and are unaffected by 119's
`auth.uid()`‑based policies. **Out of scope.**

---

## Offline write queue (`offline-store.ts` / `offline-sync.ts` / `offline-ops.ts`)

`replayOp` (`src/lib/offline-ops.ts:182`) replays exactly these op kinds:

| op kind | replay write | table + command | 119 verdict |
|---|---|---|---|
| `submit_sale_batch` | `db.rpc("submit_sale_batch", …)` | DEFINER RPC | RPC‑only — safe |
| `insert_expense` | `db.from("expenses").upsert(row, {onConflict:"id"})` | `expenses` INSERT (UPDATE on id‑collision) | Bucket C, `recorded_by_user_id = auth.uid()` covers a member's own row — safe |
| `insert_customer` | `db.from("customers").upsert(row, {onConflict:"id", ignoreDuplicates:false})` | `customers` INSERT (UPDATE on id‑collision) | INSERT is member‑allowed. **Residual:** a *second* replay after a partially‑succeeded first would take the UPDATE branch → 403 post‑119 → op fails, retries ×8, parks. Low probability, non‑destructive (row already saved). See note. |
| `insert_customer_payment` | existence check, then `db.from("customer_payments").insert(row)`, then `db.rpc("adjust_customer_balance")` | `customer_payments` INSERT + DEFINER RPC | INSERT member‑allowed; explicit `existing` check prevents any UPDATE — safe |
| `upsert_stock_count` | `db.from("stock_counts").upsert(row, {onConflict:"id"})` | all of `stock_counts` | member‑allowed — safe |
| `open_shift` / `close_shift` | `db.from("shifts").upsert(row, {onConflict:"id"})` | `shifts` INSERT/UPDATE | both member‑allowed — safe |

`refreshCache` (`offline-sync.ts:35`) is **read‑only** (`.select`).

**Offline‑queue conclusion:** no queued op replay‑writes a 119‑gated command on the
happy path. One low‑risk edge (`insert_customer` double‑replay hitting upsert's UPDATE
branch) is worth a one‑line hardening later (add an `existing`‑id short‑circuit like
`insert_customer_payment` already has) but is **not** a Task 11 blocker and **not** a
client‑guard item.

---

## Summary

**The "guard needed" list is NOT empty. It has two entries**, both on screens a
Model‑2 cashier uses in the normal workflow, both writing a Bucket A command that 119
newly gates, both with a manager‑only control that was left un‑gated on the client.

### 1. `/customers` → Edit Customer → `customers` UPDATE

- **Where:** Edit (pencil) button `src/app/(dashboard)/customers/page.tsx:352‑358` →
  `openEdit` `:113` → `CustomerFormModal` `:446` → `handleSave` update branch
  `src/app/(dashboard)/customers/page.tsx:493`.
- **Why it breaks:** `/customers` is in the cashier nav (`sidebar.tsx:76`,
  `roles: ["admin","cashier"]`, shown to a till‑`cashier` when `cashier_credit_sales`
  is on). `migration 119` GATEs `customers_loc_update`. A Model‑2 `member` who edits a
  customer's name / phone / credit limit gets a raw RLS 403 surfaced as
  `setError(dbError.message)` — a live `.update()`, so no queue jam, just a broken
  action that worked before 119. (Consistent with the stated intent in
  `org-context.tsx:82‑84`: cashier credit access "Never grants edit/delete" — the Edit
  button showing to cashiers is a pre‑existing oversight.)
- **Exact guard to add (Task 11), following the repo's existing pattern**
  (`can()` returns false for members; mirrors `current_user_manager_org_ids()`):

  In `CustomersPage` (`src/app/(dashboard)/customers/page.tsx`), pull `role` from the
  existing `useOrg()` destructure (currently `const { currentLocationId,
  currentLocationName, currency } = useOrg();` at `:57`):

  ```tsx
  const { currentLocationId, currentLocationName, currency, role } = useOrg();
  const canEditCustomers = role !== "member";   // owner + admin (manager) only
  ```

  Then render the Edit button (`:352‑358`) only when `canEditCustomers`:

  ```tsx
  {canEditCustomers && (
    <button onClick={() => openEdit(customer)} … title="Edit"> … </button>
  )}
  ```

  Add/Record‑payment stay unguarded (those commands are member‑allowed). No new
  `PermissionKey` is required — `role !== "member"` is the right test because manager
  permission toggles do not subdivide customer editing, and it exactly matches what
  RLS will now enforce. Optionally also early‑return in `handleSave` when
  `customer && !canEditCustomers` for defence in depth, but hiding the trigger is
  sufficient and matches how `/shift` handles its admin‑only actions.

### 2. `/expenses` → Manage Categories → `expense_categories` INSERT/UPDATE

- **Where:** "Manage Categories" button `src/app/(dashboard)/expenses/page.tsx:233` →
  `ManageExpenseCategoriesModal` → `handleAdd` (`manage-expense-categories-modal.tsx:80`,
  `expense_categories` INSERT), `handleRename` (`:100`, `expense_categories` UPDATE +
  `:102` `expenses.category` bulk UPDATE), `handleRemove` (`:125`, `expense_categories`
  UPDATE `active:false`).
- **Why it breaks:** `/expenses` is in the cashier nav (`sidebar.tsx:77`,
  `roles: ["admin","cashier"]`, **not** `cashierGated`) — every Model‑2 cashier sees it.
  The button that mounts the modal has no role check, unlike the sibling "Expenses by
  cashier" panel on the same page which is already behind `can("manage_expenses")`
  (`expenses/page.tsx:294`). `expense_categories` is Bucket A canonical, so 119 GATEs
  INSERT/UPDATE/DELETE. Pre‑119 a cashier‑role member could add/rename/remove expense
  categories; post‑119 every one of those three actions returns a raw 403.
- **Exact guard to add (Task 11):** wrap the button in the check the same file already
  uses one screenful lower. `can` is already destructured from `useOrg()` at
  `expenses/page.tsx:23`:

  ```tsx
  {can("manage_expenses") && (
    <Button variant="secondary" onClick={() => setShowCategories(true)}>
      <Tag className="w-4 h-4 mr-2" /> Manage Categories
    </Button>
  )}
  ```

  `can("manage_expenses")` is `false` for `role === "member"`. This matches the
  existing pattern at `:294` and keeps the two manager controls on the page
  consistent. (An admin whose `manage_expenses` toggle is revoked also loses the
  button — slightly tighter than RLS, which allows any `admin`; if an exact RLS
  mirror is preferred use `role !== "member"` instead, but in‑file consistency
  argues for `can("manage_expenses")`.) No change to the modal itself is required,
  though an early‑return guard inside `handleAdd`/`handleRename`/`handleRemove` is a
  cheap defence‑in‑depth add.

### Everything else

- `shifts` DELETE (`/shift`) — already gated by `can("manage_shift_admin")`. No action.
- `daily_reconciliation` INSERT/UPDATE (`/sales` Till Reconciliation) — member‑allowed
  by the frozen whitelist. **No guard needed** (known lead re‑confirmed).
- All Bucket A writes on admin‑only screens — URL‑only for a member; 119's 403 is the
  intended enforcement; adding ~20 client guards is out of scope for this migration.
- WMS writes — blocked at `(wms)/layout.tsx`.
- API‑route writes — service‑role / platform‑admin, unaffected by 119.
- Offline queue — no gated‑command replay on the happy path; one low‑risk
  `insert_customer` double‑replay edge noted for later, not a blocker.

**Recommendation:** two small client guards (both above), each a one‑line render
condition using a helper the target file already imports (`can()` / `useOrg().role`),
following the repo's existing manager‑gating pattern. Per Task 10 step 4, the
reviewer/user approves this guard approach before Task 11 implements it. Both guards
touch only the control that mounts a manager action on a cashier screen — no new
`PermissionKey`, no route guards, no changes to member‑allowed paths (Add Customer,
Record Payment, Record Expense, shift open/close, stock counts, till reconciliation all
stay exactly as they are).
