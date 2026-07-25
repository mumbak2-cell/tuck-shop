# Financial logic review — Tilify P&L and reports

**Date:** 2026-07-25
**Scope:** Profit & Loss, Reports, the daily email builder, the sale-capture RPC,
the cost/VAT model, and the void path.
**Reviewer note:** This is a review of *software and accounting logic*, not tax
advice. The "can we file this?" verdict is about whether the numbers are
structurally sound and complete enough to be turned into a statutory return.
Final sign-off for ZA (SARS) or ZM (ZRA) VAT and income tax must come from a
qualified accountant in that jurisdiction.

Files reviewed:
- `src/app/(dashboard)/profit-loss/page.tsx`
- `src/app/(dashboard)/reports/page.tsx`
- `src/lib/daily-report.ts`
- `src/types/database.ts`
- `supabase/migrations/034_snapshot_cost_price.sql`
- `supabase/migrations/032_org_tax_fields.sql`
- `src/components/pos/receipt.tsx`
- `src/app/(dashboard)/sales/page.tsx` (void path)

---

## Direct answers

**Does it pass the smell test?** As **management accounts**, largely yes — the
design is more thoughtful than most POS apps (the snapshot-cost and
inventory-vs-expense reasoning is genuinely correct). As **statutory financial
statements**, no — there are three classification/completeness errors that would
make the P&L wrong in the eyes of a tax authority.

**Can you submit these to a tax authority?** **Not as-is.** The *underlying
transaction record* is submittable (and ZRA Smart Invoice already fiscalizes
individual sales, which is the part tax authorities most care about), but the
**P&L report itself cannot be filed** as an income-tax computation, and **there
is no VAT return** at all — VAT exists only as a number printed on a receipt. An
accountant would have to rebuild both from the raw data.

---

## Critical findings (block tax filing)

### C1 — There is no VAT accounting; VAT is a receipt cosmetic
`sales` stores only `total_amount` (VAT-inclusive). VAT is back-calculated *at
render time* on the receipt (`receipt.tsx:299`, `total / (1 + vat/100)`) and
never stored, never separated in P&L or Reports. Consequences:
- P&L "Total Revenue" is **VAT-inclusive gross** — it overstates real revenue by
  the VAT fraction (16% ZM, 15% ZA).
- There is **no output-VAT vs input-VAT ledger**, so a VAT return
  (output − input) cannot be produced at all.
- VAT is recomputed per receipt from a rounded inclusive total, so it isn't even
  internally consistent to the cent across a period.

### C2 — Director Withdrawals are subtracted as if they were an expense
`profit-loss/page.tsx:142`: `netProfit = grossProfit - operatingExpenses -
directorWithdrawals`. Owner's drawings / director distributions are
**appropriations of profit, not expenses** — they must not reduce net profit.
This *understates* reported profit, i.e. understates taxable income, which is the
dangerous direction with a revenue authority. They belong *below* the net-profit
line as a distribution.

### C3 — No period close or immutability
A sale can be voided (`sales/page.tsx:159`) and expenses edited at any time, with
no period lock and no reversing entry. A P&L exported and filed for March can
silently change in April. Filed accounts require a locked period and an audit
trail of post-close adjustments.

---

## High-severity findings

### H1 — The daily email counts voided sales
`daily-report.ts:87` and `:336` query `sales` **without** `.eq("voided", false)`,
while every other revenue surface filters it (dashboard, reports, P&L, RA,
credit-ledger). The emailed daily revenue and the attached CSV overstate takings
by any voided sale. One-line fix, but owners have been reconciling tills against
an inflated figure.

### H2 — Voiding a sale restores the wrong stock field
`sales/page.tsx:172-182` writes the returned units back to
`products.opening_stock` — the **legacy org-wide** column — but the sale deducted
from **`product_stock.quantity`** (the per-branch table the POS actually reads,
migration 024). So a void reverses the money but **not the branch stock level**.
After any void, that branch's stock is understated, and Revenue Assurance reads
it as phantom shrinkage. A real bug from the multi-location migration not being
carried through the void path.

### H3 — Missing cost prices silently understate COGS
The sale RPC falls back to `0` when a product has no cost
(`034_snapshot_cost_price.sql:81`), so those lines book at 100% margin. The P&L
only warns when COGS is *exactly* zero (`profit-loss/page.tsx:275`); a period
that's 90% costed shows no warning. (This is the open "61 products with no cost
price" thread.) It directly overstates gross profit.

### H4 — Shrinkage never reaches the P&L
Stock lost to adjustments/breakage/oversells is removed from inventory but booked
to **neither COGS nor an expense**. The daily email shows an "adjustments loss"
but values it at **selling price** (`daily-report.ts:160`) and only
informationally. Net effect: inventory losses vanish from profit, so gross profit
is overstated and inventory (if ever valued) won't reconcile.

---

## Medium findings

- **M1 — No inventory valuation / balance sheet.** COGS is perpetual (per-sale
  snapshot) but there is no closing-stock valuation to reconcile it against, so
  COGS can't be *proven*. Statutory accounts need opening + purchases − closing.
- **M2 — Timezone boundaries use UTC.** Date ranges are built with
  `toISOString()` (UTC) against a local trading day (SAST = UTC+2). Sales in the
  first two hours after midnight land in the wrong day/period. Minor for monthly
  totals, wrong for daily reconciliation.
- **M3 — No refunds/credit notes.** The only reversal is a full void; no partial
  return, no credit-note document. Tax authorities expect credit notes to reverse
  fiscalized invoices.

---

## What's genuinely well done (calibration)

- **Snapshot `cost_price`/`unit_price` at sale time (migration 034)** — correct,
  avoids retroactively corrupting historical margins. The best decision in the
  financial layer.
- **Inventory held out of operating expenses** — the COGS-vs-double-count
  reasoning (`database.ts:220`, P&L, Reports) is correct and well-documented.
- **Accrual P&L vs cash-basis "Cash spent" kept as two separate lists** —
  sophisticated, and the code explicitly warns against "unifying" them.
- **Void filtering, paged fetches, RLS-scoped reads, RA two-directional
  reconciliation** — all solid.

---

## Suggested changes — phased and implementable

Next migration number is **060** (latest applied 059).

### Phase 1 — correctness fixes (small, ship first)
1. Add `.eq("voided", false)` to both `daily-report.ts` queries (H1). ~2 lines.
2. Fix the void stock restoration to write `product_stock.quantity` at the sale's
   `location_id`, not `products.opening_stock` (H2). Ideally via a `void_sale`
   RPC mirroring `deduct_stock_at_location`, so it's atomic and location-correct.
3. Move Director Withdrawals below the net-profit line (C2) — label "Drawings /
   Distributions", `netProfit = grossProfit − operatingExpenses`. **Raises
   reported profit** — flag to shop owners.
4. Extend the COGS warning to "*N of M lines sold with no cost price*" (H3), not
   just the all-zero case.

### Phase 2 — VAT ledger (the real project; unblocks tax filing)
5. Migration 060: snapshot `sales.tax_rate` and `sales.tax_amount` at sale time
   in `submit_sale_batch` (back-calculated from `organizations.vat_percent`), the
   same way `cost_price` is snapshotted — never recomputed at read time.
6. Add optional VAT capture to `expenses` and `stock_receipts` (input VAT).
7. P&L shows Revenue **excl. VAT**; add a VAT summary card
   (output − input = payable). This becomes the VAT return.

### Phase 3 — auditability
8. Period-close/lock table; block voids/edits in closed periods or force a dated
   reversing entry.
9. Book shrinkage (adjustments + oversells) to a "Stock loss" line at **cost**
   (H4), and add a period-end inventory valuation snapshot (M1).

### Phase 4
Org trading-day timezone for all date-range math (M2); credit-note documents (M3).

**Also:** a one-off review by a SARS/ZRA-registered accountant to sign off the
chart of accounts and VAT treatment before any output is used for filing — the
code can be correct and still not match a jurisdiction's required presentation.

---

## Implementation progress (2026-07-25)

### Phase 1 — done (in code)
- **H1** — `daily-report.ts`: both `sales` queries now filter `voided = false`.
- **C2** — `profit-loss/page.tsx`: Net Profit = Gross Profit − Operating
  Expenses. Director Withdrawals moved below the Net Profit line as a
  distribution, with a "Profit kept in the business" figure. *Raises reported
  net profit for any shop with recorded withdrawals — flag to owners.*
- **H3** — `profit-loss/page.tsx`: COGS card warns "N of M sales have no cost
  price" whenever any line is costless, not only when COGS is exactly 0.
- **H2** — `migration 060` adds `restock_at_location` (atomic, increment-only);
  the void handler in `sales/page.tsx` now credits `product_stock.quantity` at
  the sale's location instead of the legacy `products.opening_stock`. The
  handler guards on `location_id`, so nothing breaks before 060 is applied.

### Phase 2 — output VAT foundation done; input VAT + profit-math deferred
- **DONE — `migration 061`**: `sales.tax_rate` + `sales.tax_amount`, backfilled
  from `organizations.vat_percent`; `submit_sale_batch` now snapshots output VAT
  per line server-side (offline-safe, no client change). Dormant until an org
  sets `vat_percent`.
- **DONE — `profit-loss/page.tsx`**: read-only VAT panel showing Revenue excl.
  VAT and Output VAT collected, shown only when VAT was captured. Profit math is
  deliberately **unchanged**.
- **DONE — VAT registration self-serve (`vat-section.tsx` in Settings)**: owner
  switch "We are registered for VAT" + rate (RSA 15 / Zambia 16) + TPIN, saved to
  `organizations.vat_percent`/`tpin` (owner RLS from 017), `refreshOrg()` after so
  receipt/POS/product-form update live. Off = `vat_percent` NULL.
- **DONE — per-product zero-rating (`migration 062` + product form)**:
  `products.zero_rated`; `submit_sale_batch` records tax_rate 0 / tax_amount 0 on
  a zero-rated line even in a VAT-registered org (bread, milk). The product-form
  checkbox and payload field appear **only when the org is VAT-registered**, so a
  non-VAT fleet never references the column regardless of deploy order.
- **DONE — input VAT + VAT-return card (`migration 063`):** `expenses.tax_amount`
  (single source — Receive Stock rides input VAT on the auto "Stock Purchases"
  expense, never on `stock_receipts`, so no double-count). A "VAT included
  (reclaimable)" checkbox on the Record Expense modal and Receive Stock
  back-calculates input VAT at the org rate. The P&L VAT panel is now a **VAT
  return**: Output VAT − Input VAT = Net VAT payable/(refundable), shown for any
  VAT-registered org. Input-VAT read degrades to 0 if 063 isn't applied yet.
  Apply 063 before the code goes live for a VAT-registered org (only VAT orgs
  send the column).
- **STILL DEFERRED (needs a decision):** whether COGS is carried ex-VAT for a
  VAT-registered org — a VAT return does not need it, but gross profit is
  slightly overstated while COGS includes reclaimable input VAT. Not attempted
  blind.
- **DONE — receipt VAT with mixed baskets:** `CartItem` now carries `zeroRated`
  (populated in POS `addToCart` from `products.zero_rated`), and `receipt.tsx`
  computes VAT from the taxable subtotal (`vatableTotal`), not a back-calc of the
  whole total. A mixed basket now prints the correct VAT — verified in preview:
  Drill Bit (zero-rated) + Safety Straps (standard) → VAT R8.74, not R24.39.
  Receipt line-item spacing was also improved (per-item padding + separators).

### Verified in preview (2026-07-25, test org mumbak2+test1)
- Settings VAT section renders; toggle/rate/TPIN work.
- Product-form zero-rated checkbox appears only when VAT-registered; saves.
- Sale VAT snapshot correct per line; standard line taxed, zero-rated line 0;
  snapshot immutable (a historical line kept its VAT after the product's rating
  changed).
- P&L VAT panel reads the snapshot; net-profit caption excludes withdrawals.
- Void restock (H2): branch `product_stock` returned 98→99 via
  `restock_at_location`; other line untouched.
- Receipt mixed-basket VAT correct (R8.74) and re-spaced.

### Pending DB apply (user runs these)
Apply in the SQL Editor, then repair:
```
node node_modules/supabase/dist/supabase.js migration repair --status applied 060
node node_modules/supabase/dist/supabase.js migration repair --status applied 061
node node_modules/supabase/dist/supabase.js migration repair --status applied 062
```
Apply 060 → 061 → 062 in order (062 must land before any org sets vat_percent).
All idempotent. Not yet verified in-browser (void needs 060 live; VAT needs a
VAT-registered org).
