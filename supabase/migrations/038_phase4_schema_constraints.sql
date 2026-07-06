-- Migration 038: Phase 4 schema constraints (L7)
-- 1. customer_payments.customer_id → NOT NULL
-- 2. zra_invoices.sale_id → FK to sales(id)

-- 1. Clean up any orphan rows where customer_id is NULL (should be zero, but
--    just in case).
DELETE FROM customer_payments WHERE customer_id IS NULL;

ALTER TABLE customer_payments
  ALTER COLUMN customer_id SET NOT NULL;

-- 2. Add a proper foreign-key reference from zra_invoices.sale_id → sales(id).
--    We use ON DELETE SET NULL so voiding/deleting a sale doesn't cascade-delete
--    the ZRA audit trail — we want to keep the invoice log for compliance.
ALTER TABLE zra_invoices
  ADD CONSTRAINT fk_zra_invoices_sale
  FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE SET NULL;
