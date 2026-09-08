-- ============================================================
-- Migration 118: Payment method on customer_payments
--
-- A credit-account settlement (Customers page > Payment) had no record of
-- HOW it was paid, so cash collected against a customer's balance never fed
-- into the daily cash-up (shift.tsx sums the `sales` table only) — a
-- cashier could pocket that cash with the till still appearing balanced.
--
-- Nullable: existing rows stay NULL, which is fine — the cash-up screen
-- only ever reads today's rows, never historical ones, so no backfill is
-- needed for this to take effect going forward.
-- ============================================================

BEGIN;

ALTER TABLE customer_payments
  ADD COLUMN payment_method TEXT;

COMMIT;
