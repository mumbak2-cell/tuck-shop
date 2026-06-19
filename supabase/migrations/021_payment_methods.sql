-- ============================================================
-- Migration 021: Per-org payment methods (Slice 3a)
--
-- Replaces the hardcoded 'cash' / 'card' / 'credit' CHECK constraint
-- on the sales table with a per-org payment_methods table. New shops
-- pick their accepted methods in /setup based on country-aware
-- presets (Airtel Money for Malawi, EcoCash for Zimbabwe, etc.).
--
-- The existing sales.payment_method column stays as TEXT to keep
-- historical data intact, but the CHECK constraint is dropped so it
-- can hold any method name. A new payment_reference column captures
-- mobile money transaction IDs for reconciliation.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. payment_methods table
-- ------------------------------------------------------------

CREATE TABLE payment_methods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- Kind drives UI behaviour: cash shows a tendered/change field,
  -- credit shows a customer picker, mobile_money shows a reference field, etc.
  kind TEXT NOT NULL CHECK (kind IN ('cash', 'card', 'credit', 'mobile_money', 'eft', 'other')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, name)
);

CREATE INDEX idx_payment_methods_org ON payment_methods(org_id);

ALTER TABLE payment_methods ENABLE ROW LEVEL SECURITY;

CREATE POLICY "payment_methods_org_read" ON payment_methods
  FOR SELECT USING (org_id IN (SELECT current_user_org_ids()));
CREATE POLICY "payment_methods_org_insert" ON payment_methods
  FOR INSERT WITH CHECK (org_id IN (SELECT current_user_writable_org_ids()));
CREATE POLICY "payment_methods_org_update" ON payment_methods
  FOR UPDATE USING (org_id IN (SELECT current_user_org_ids()))
  WITH CHECK (org_id IN (SELECT current_user_writable_org_ids()));
CREATE POLICY "payment_methods_org_delete" ON payment_methods
  FOR DELETE USING (org_id IN (SELECT current_user_writable_org_ids()));

ALTER TABLE payment_methods ALTER COLUMN org_id SET DEFAULT default_user_org_id();

-- ------------------------------------------------------------
-- 2. Drop the rigid CHECK on sales.payment_method.
--    Existing 'cash' / 'card' / 'credit' values keep working.
--    Add payment_reference for mobile money transaction IDs.
-- ------------------------------------------------------------

ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_payment_method_check;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_reference TEXT;

-- ------------------------------------------------------------
-- 3. Backfill MK Tuck Shop with its existing methods so historical
--    sales are still meaningful.
-- ------------------------------------------------------------

INSERT INTO payment_methods (org_id, name, kind, sort_order)
SELECT 'a0000000-0000-0000-0000-000000000001'::uuid, name, kind, sort_order
FROM (VALUES
  ('Cash', 'cash', 1),
  ('iKhokha (Card)', 'card', 2),
  ('Credit Account', 'credit', 3),
  ('EFT', 'eft', 4)
) AS m(name, kind, sort_order)
ON CONFLICT (org_id, name) DO NOTHING;

-- Also normalise existing sales rows so the legacy 'cash'/'card'/'credit'
-- values display in a friendly way without a join.
UPDATE sales SET payment_method = 'Cash'
  WHERE org_id = 'a0000000-0000-0000-0000-000000000001'::uuid AND payment_method = 'cash';
UPDATE sales SET payment_method = 'iKhokha (Card)'
  WHERE org_id = 'a0000000-0000-0000-0000-000000000001'::uuid AND payment_method = 'card';
UPDATE sales SET payment_method = 'Credit Account'
  WHERE org_id = 'a0000000-0000-0000-0000-000000000001'::uuid AND payment_method = 'credit';

COMMIT;
