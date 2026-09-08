# Migration 119 — table classification

Source of truth: `pg_policy_pre119.csv` (228 policy rows) + `columns_pre119.csv`,
owner-provided from prod `pkufxpyrvcygobrgneep`, 2026-09-08.

**GATE** = append ` AND org_id IN (SELECT current_user_manager_org_ids())`
to the given expression (USING and/or WITH CHECK as noted). Reads are never
touched. `current_user_org_ids()` / `current_user_writable_org_ids()` are
preserved exactly as each policy currently uses them — never normalised.

Helper: `current_user_manager_org_ids() RETURNS SETOF uuid` (spec §Components).

---

## Bucket C — untouched (no statements in 119)

| Table(s) | Why |
|---|---|
| `admin_org_overrides`, `audit_logs`, `commission_payouts`, `partner_applications`, `partners`, `platform_admins`, `referrals`, `invoice_events` | platform-level; `is_platform_admin()` or read-only, no `current_user_*` gate |
| `organizations`, `org_members` | role-scoped in mig 017 |
| `period_locks` | `period_locks_write` FOR ALL already gated on `role = 'owner'` — tighter than manager |
| `product_stock` | already gated `role IN ('owner','admin')` on i/u/d (mig 053) |
| `expenses` | `expenses_loc_*` already row/role-scoped (`role IN ('owner','admin') OR recorded_by_user_id = auth.uid()`), members insert their own by design (mig 046) |
| `stock_movements`, `stock_oversells`, `stock_transfers`, `wms_transfers`, `wms_transfer_items` | **append-only** — only a `_read` policy exists; writes are SECURITY DEFINER RPC only. 119 must NOT create a write policy. |
| `till_sessions`, `till_pin_attempts`, `wms_rpc_idempotency`, `wms_cycle_count_due`, `wms_expiry_forecast`, `wms_inventory_by_item`, `wms_inventory_in_transit` | not in the policy dump (own model / views); nothing to do |

---

## Bucket B — member keeps some writes (explicit blocks; DROP+CREATE the named policy)

Member-allowed command → re-create verbatim, **no gate**. Other commands → GATE.

### `customer_payments` (`_loc_*` names; keep location clause)
- `customer_payments_loc_insert` (a) — **keep verbatim.** check: `((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND ((location_id IS NULL) OR (location_id IN ( SELECT current_user_location_ids() AS current_user_location_ids))))`
- `customer_payments_loc_update` (w) — GATE both. using: `((org_id IN ( SELECT current_user_org_ids() AS current_user_org_ids)) AND ((location_id IS NULL) OR (location_id IN ( SELECT current_user_location_ids() AS current_user_location_ids))))` ; check: same as insert's check.
- `customer_payments_loc_delete` (d) — GATE using: `((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND ((location_id IS NULL) OR (location_id IN ( SELECT current_user_location_ids() AS current_user_location_ids))))`

### `customers` (`_loc_*`)
- `customers_loc_insert` (a) — **keep verbatim.** check: `((org_id IN ( SELECT current_user_writable_org_ids() ...)) AND ((location_id IS NULL) OR (location_id IN ( SELECT current_user_location_ids() ...))))`
- `customers_loc_update` (w) — GATE. using: `((org_id IN ( SELECT current_user_org_ids() ...)) AND ((location_id IS NULL) OR (location_id IN ( SELECT current_user_location_ids() ...))))` ; check: = insert check.
- `customers_loc_delete` (d) — GATE using: = insert check shape (`writable_org_ids` + location).

### `shifts` (`_loc_*`; has `location_id`)
- `shifts_loc_insert` (a) — **keep verbatim.** check: `((org_id IN ( SELECT current_user_writable_org_ids() ...)) AND ((location_id IS NULL) OR (location_id IN ( SELECT current_user_location_ids() ...))))`
- `shifts_loc_update` (w) — **keep verbatim.** using: `((org_id IN ( SELECT current_user_org_ids() ...)) AND (...location...))` ; check: = insert check.
- `shifts_loc_delete` (d) — GATE using: `((org_id IN ( SELECT current_user_writable_org_ids() ...)) AND (...location...))`

### `daily_reconciliation` (`_org_*`; no location_id)
- `daily_reconciliation_org_insert` (a) — **keep verbatim.** check: `(org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids))`
- `daily_reconciliation_org_update` (w) — **keep verbatim.** using: `(org_id IN ( SELECT current_user_org_ids() ...))` ; check: `(org_id IN ( SELECT current_user_writable_org_ids() ...))`
- `daily_reconciliation_org_delete` (d) — GATE using: `(org_id IN ( SELECT current_user_writable_org_ids() ...))`

### `stock_count_audit` (`_org_*`; has org_id + location_id)
- `stock_count_audit_org_insert` (a) — **keep verbatim.** check: `(org_id IN ( SELECT current_user_writable_org_ids() ...))`
- `stock_count_audit_org_update` (w) — GATE. using `(org_id IN ( SELECT current_user_org_ids() ...))`, check `(org_id IN ( SELECT current_user_writable_org_ids() ...))`
- `stock_count_audit_org_delete` (d) — GATE using `(org_id IN ( SELECT current_user_writable_org_ids() ...))`

### `stock_counts` — **NO STATEMENTS** (frozen whitelist: unchanged)
Dump shows 5 policies: `stock_counts_write_location` (FOR ALL, location-scoped, no role), `stock_counts_org_insert/update/delete` (ungated `writable_org_ids`), `stock_counts_read_location` + `stock_counts_org_read`. Per the frozen decision, a member keeps full write to stock_counts — the count-application gate lives on `product_stock` (mig 053). **Observation for the review gate:** `stock_counts_org_delete` is org-wide (not location-scoped), so a member can delete another branch's count. Pre-existing; tightening it (drop `_org_*` writes, keep only `stock_counts_write_location`) is an optional add — surface to the user, do not do silently.

---

## Bucket A — manager-gated

### A-canonical (`_org_*`, plain org-scope) — 14 tables
`app_settings, categories, expense_categories, ingredients, locations, payment_methods, production_log, products, purchases, ra_notes, recipes, stock_receipt_items, stock_receipts, suppliers`

Every one has exactly this shape (verified per-table in the CSV):
- `<t>_org_insert` (a): check = `(org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids))` → **GATE check**
- `<t>_org_update` (w): using = `(org_id IN ( SELECT current_user_org_ids() AS current_user_org_ids))`, check = `(org_id IN ( SELECT current_user_writable_org_ids() ...))` → **GATE using AND check**
- `<t>_org_delete` (d): using = `(org_id IN ( SELECT current_user_writable_org_ids() ...))` → **GATE using**
- `<t>_org_read` (r): untouched.

Loop-eligible (uniform). `production_log` is here (NOT append-only — it has full write policies; corrects the plan's earlier assumption).

### A-explicit `_loc_*` (keep the location clause)

**`balance_adjustments`** — `balance_adjustments_loc_insert/update/delete`.
- insert check: `((org_id IN ( SELECT current_user_writable_org_ids() ...)) AND ((location_id IS NULL) OR (location_id IN ( SELECT current_user_location_ids() ...))))` → GATE check
- update using: `((org_id IN ( SELECT current_user_org_ids() ...)) AND (...location...))` ; check: = insert check → GATE both
- delete using: = insert check shape → GATE using

**`stock_adjustments`** — `stock_adjustments_loc_insert/update/delete`, identical shape to `balance_adjustments`. GATE insert.check, update.using+check, delete.using.

**`sales`** — `sales_loc_insert/update/delete`.
- `sales_loc_insert` (a) → GATE check: `((org_id IN ( SELECT current_user_writable_org_ids() ...)) AND ((location_id IS NULL) OR (location_id IN ( SELECT current_user_location_ids() ...))))`
- `sales_loc_update` (w) → **DROP, do not recreate.** (mig 078's intent; sales mutated only via `submit_sale_batch` / `void_sale_lines` DEFINER RPCs.)
- `sales_loc_delete` (d) → **DROP, do not recreate.**

### A-explicit bare-named

**`combos`** — `combos_insert` (a), `combos_delete` (d), `combos_update` (w, **USING-only, no WITH CHECK**), `combos_read` (r, untouched).
- insert check: `(org_id IN ( SELECT current_user_org_ids() AS current_user_org_ids))` → GATE check
- update using: `(org_id IN ( SELECT current_user_org_ids() ...))` → GATE using (no check clause exists — do not add one)
- delete using: `(org_id IN ( SELECT current_user_org_ids() ...))` → GATE using

**`promotions`** — `promotions_insert/delete/update` (update USING-only), `promotions_read` untouched. Same expr (`current_user_org_ids`) and same GATE pattern as `combos`.

**`purchase_orders`** — `purchase_orders_insert/delete/update` (update USING-only), `_read` untouched. Same as `combos` (`current_user_org_ids`).

**`location_settings`** — `location_settings_insert/update/delete`, `location_settings_read` **UNTOUCHED** (carries the mig-100 PIN-hiding clause).
- insert check: `((org_id IN ( SELECT current_user_writable_org_ids() ...)) AND (location_id IN ( SELECT current_user_location_ids() ...)))` → GATE check
- update using: `((org_id IN ( SELECT current_user_org_ids() ...)) AND (location_id IN ( SELECT current_user_location_ids() ...)))` ; check: `((org_id IN ( SELECT current_user_writable_org_ids() ...)) AND (location_id IN (...)))` → GATE both
- delete using: = insert check shape → GATE using

**`report_subscriptions`** — `report_subs_insert/update/delete`, `report_subs_read` untouched.
- insert check: `(org_id IN ( SELECT current_user_writable_org_ids() ...))` → GATE check
- update using `(org_id IN ( SELECT current_user_org_ids() ...))`, check `(org_id IN ( SELECT current_user_writable_org_ids() ...))` → GATE both
- delete using `(org_id IN ( SELECT current_user_writable_org_ids() ...))` → GATE using

### A-explicit `plp_*`

**`product_location_prices`** — `plp_insert/update/delete`, `plp_read` untouched.
- insert check: `((org_id IN ( SELECT current_user_writable_org_ids() ...)) AND (location_id IN ( SELECT current_user_location_ids() ...)))` → GATE check
- update using: `((org_id IN ( SELECT current_user_org_ids() ...)) AND (location_id IN (...)))` ; check: = insert check → GATE both
- delete using: = insert check shape → GATE using

### A-child (no `org_id` column; gate the parent subquery)

Each has only `_insert` and `_delete` (**no `_update` policy** — do not create one). Read policy untouched.

**`combo_items`** — `combo_items_insert` (check), `combo_items_delete` (using). Current expr:
`(combo_id IN ( SELECT combos.id FROM combos WHERE (combos.org_id IN ( SELECT current_user_org_ids() AS current_user_org_ids))))`
→ replace `current_user_org_ids()` with `current_user_manager_org_ids()` inside the subquery (the whole gate for child tables).

**`promotion_items`** — `promotion_items_insert`/`_delete`, via `promotions` (`promotion_id IN ( SELECT promotions.id FROM promotions WHERE (promotions.org_id IN ( SELECT current_user_org_ids() ...)))`) → same replacement.

**`purchase_order_items`** — `purchase_order_items_insert`/`_delete`, via `purchase_orders` (`po_id IN ( SELECT purchase_orders.id FROM purchase_orders WHERE (purchase_orders.org_id IN ( SELECT current_user_org_ids() ...)))`) → same replacement.

### A-FOR ALL decompose

The single `*` policy becomes: one `FOR SELECT` (old expr, **ungated**) + `FOR INSERT/UPDATE/DELETE` (old expr **GATE**d). New policy names: `<t>_org_read`, `<t>_org_insert`, `<t>_org_update`, `<t>_org_delete`.

**Group 1 — only a `FOR ALL` policy exists** (12 tables; DROP the FOR ALL, create all 4):
`wms_adjustments, wms_catalog, wms_dispatch_items, wms_dispatches, wms_inventory, wms_po_items, wms_purchase_orders, wms_receipt_items, wms_receipts, wms_stock_count_audit, wms_stock_counts` — policy `org_isolation`, expr (both qual & withcheck) `(org_id IN ( SELECT current_user_org_ids() AS current_user_org_ids))`.
`wms_stock_count_sessions` — policy `wms_scs_org_isolation`, same expr.

**Group 2 — a `FOR ALL` write policy + a separate `_org_read`** (DROP only the write policy, create insert/update/delete gated; leave the existing read):
- `wms_locations` — `wms_locations_org_write` (`*`), expr `(org_id IN ( SELECT current_user_writable_org_ids() ...))` (both). Leave `wms_locations_org_read`.
- `wms_org_settings` — `wms_org_settings_org_write` (`*`), same. Leave `wms_org_settings_org_read`.
- `zra_config` — `zra_config_write` (`*`), using `(org_id IN ( SELECT current_user_writable_org_ids() ...))`, **no withcheck** — use `using` as the source for all three write policies. Leave `zra_config_read`.
- `zra_invoices` — `zra_invoices_write` (`*`), same as `zra_config`. Leave `zra_invoices_read`.

---

## Decision — `customer_payments` hardening (spec open item)

**Recommend option A (no schema change).** Document residual risk: a member
can insert `customer_payments` rows with any `customer_id` in the org, any
`amount` (no `> 0` check), backdated `payment_date`, no attribution. This is
unchanged by 119 (the INSERT policy is in the frozen whitelist). Mitigating
it (add `recorded_by_user_id uuid DEFAULT auth.uid()` + `WITH CHECK` +
`CHECK (amount > 0)`, mirroring `expenses` mig 046) is a clean follow-up
migration 120, not something to fold into a security-policy sweep.
**PENDING USER DECISION at the Task 2 review gate** — if the user wants it in
119, it becomes Part 0 of the migration.

---

## Summary counts

- Bucket C: ~25 tables, 0 statements.
- Bucket B: 6 tables (`customer_payments`, `customers`, `shifts`, `daily_reconciliation`, `stock_count_audit` get statements; `stock_counts` gets none).
- Bucket A canonical: 14 tables × 3 = 42 policies gated (loop).
- Bucket A explicit: `balance_adjustments`, `stock_adjustments`, `sales` (insert gated + 2 dropped), `combos`, `promotions`, `purchase_orders`, `location_settings`, `report_subscriptions`, `product_location_prices` = ~25 policies.
- Bucket A child: 3 tables × 2 = 6 policies.
- Bucket A FOR ALL: 12 + 1 (group 1, ×4 new each = 52) + 4 (group 2, ×3 new each = 12, reads kept).
- Total policies touched ≈ 140.
