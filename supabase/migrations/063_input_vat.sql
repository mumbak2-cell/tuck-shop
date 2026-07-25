-- ============================================================
-- Migration 063: Capture input VAT on expenses
--
-- 061 snapshots OUTPUT VAT on sales. A VAT return also needs INPUT VAT — the
-- VAT a registered business pays on its purchases and reclaims. This adds a
-- single nullable column on `expenses` to hold it.
--
-- Single source by design: input VAT is recorded ONLY on `expenses.tax_amount`,
-- never on `stock_receipts`. Receive Stock already writes a "Stock Purchases"
-- expense mirroring each delivery, so the delivery's input VAT rides on that
-- expense row. Putting it on both would double-count the reclaim — the same
-- trap the cash-spent report documents. The P&L VAT panel therefore sums
-- expenses.tax_amount across ALL categories (including the inventory ones) as
-- total input VAT.
--
-- The app only ever sends tax_amount for a VAT-registered org, so a non-VAT
-- fleet is unaffected regardless of deploy order, and the P&L reads it through
-- a query that degrades to 0 if this column is not present yet.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, replay-safe.
-- ============================================================

BEGIN;

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(10,2);

COMMENT ON COLUMN expenses.tax_amount IS
  'Reclaimable input VAT included in `amount` (migration 063). NULL/0 = no VAT. '
  'Set only for VAT-registered orgs; summed across all categories for the VAT return.';

COMMIT;

NOTIFY pgrst, 'reload schema';
