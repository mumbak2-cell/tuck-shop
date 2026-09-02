-- ============================================================
-- Migration 102: Balance adjustments
--
-- Customer statements sum `sales` and `customer_payments` to reconcile
-- against `customers.balance`. Historically staff could edit
-- `customers.balance` directly via the "Balance Owed — Carried Forward"
-- field on the Edit Customer form, with no corresponding ledger row —
-- an untracked, unexplained jump in what a customer owes.
--
-- This table gives those adjustments a home: a signed amount (+ increases
-- what the customer owes, - decreases it) with a note, so statements can
-- include them as a line item instead of silently disagreeing with
-- `customers.balance`. The direct-edit UI path is being removed in the
-- same change that ships this migration.
-- ============================================================

CREATE TABLE balance_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  amount DECIMAL(10,2) NOT NULL,
  note TEXT,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_id UUID REFERENCES locations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_balance_adjustments_customer ON balance_adjustments(customer_id);
CREATE INDEX idx_balance_adjustments_org ON balance_adjustments(org_id);
CREATE INDEX idx_balance_adjustments_location ON balance_adjustments(location_id);

ALTER TABLE balance_adjustments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "balance_adjustments_loc_read" ON balance_adjustments
  FOR SELECT USING (
    org_id IN (SELECT current_user_org_ids())
    AND (location_id IS NULL OR location_id IN (SELECT current_user_location_ids()))
  );

CREATE POLICY "balance_adjustments_loc_insert" ON balance_adjustments
  FOR INSERT WITH CHECK (
    org_id IN (SELECT current_user_writable_org_ids())
    AND (location_id IS NULL OR location_id IN (SELECT current_user_location_ids()))
  );

CREATE POLICY "balance_adjustments_loc_update" ON balance_adjustments
  FOR UPDATE USING (
    org_id IN (SELECT current_user_org_ids())
    AND (location_id IS NULL OR location_id IN (SELECT current_user_location_ids()))
  ) WITH CHECK (
    org_id IN (SELECT current_user_writable_org_ids())
    AND (location_id IS NULL OR location_id IN (SELECT current_user_location_ids()))
  );

CREATE POLICY "balance_adjustments_loc_delete" ON balance_adjustments
  FOR DELETE USING (
    org_id IN (SELECT current_user_writable_org_ids())
    AND (location_id IS NULL OR location_id IN (SELECT current_user_location_ids()))
  );
