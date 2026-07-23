-- ============================================================
-- Migration 054: How a stock delivery was paid for
--
-- stock_receipts recorded what arrived and what it cost, but never how it was
-- paid. Cash-flow reporting cannot work without that: stock bought on account
-- leaves the bank weeks after the delivery date, so counting every delivery as
-- cash out on its receipt date overstates what actually left the till.
--
--   cash        — physical cash handed over, hits the till the same day
--   account     — on terms / credit from the supplier, paid later
--   electronic  — EFT, card or transfer; money gone, but not from the cash box
--
-- Existing rows are backfilled as 'cash'. That is a GUESS. It is the common
-- case for the small retailers on Tilify today, and it keeps historical rows
-- out of a NULL bucket the report would have to explain, but it is not derived
-- from anything recorded at the time. Any operator who has been buying on terms
-- should correct their history before trusting the cash figures for past
-- periods.
-- ============================================================

BEGIN;

ALTER TABLE stock_receipts
  ADD COLUMN IF NOT EXISTS paid_by TEXT;

-- Backfill before the constraint so the CHECK does not reject existing rows.
UPDATE stock_receipts SET paid_by = 'cash' WHERE paid_by IS NULL;

ALTER TABLE stock_receipts
  ALTER COLUMN paid_by SET DEFAULT 'cash';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stock_receipts_paid_by_check'
  ) THEN
    ALTER TABLE stock_receipts
      ADD CONSTRAINT stock_receipts_paid_by_check
      CHECK (paid_by IN ('cash', 'account', 'electronic'));
  END IF;
END $$;

-- The cash-spent report filters by date and reads paid_by for the split.
CREATE INDEX IF NOT EXISTS idx_stock_receipts_date_paid
  ON stock_receipts (receipt_date, paid_by);

COMMIT;
