-- ============================================================
-- Migration 037: Phase 3 audit fixes
--
-- M2  — Webhook idempotency: unique constraint on invoice_events
-- M6  — ZRA RLS: replace default_user_org_id() with current_user_org_ids()
-- M13 — Customer balance: remove GREATEST(…, 0) clamp from adjust_customer_balance
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- M2: Webhook idempotency
-- Add unique constraint on (provider, provider_reference) so duplicate
-- webhook deliveries are rejected at the DB level. provider_reference
-- can be NULL (for events without a reference) so we only constrain
-- non-NULL values.
-- ------------------------------------------------------------

DROP INDEX IF EXISTS idx_invoice_events_provider_ref;

CREATE UNIQUE INDEX idx_invoice_events_provider_ref
  ON invoice_events(provider, provider_reference)
  WHERE provider_reference IS NOT NULL;

-- ------------------------------------------------------------
-- M6: ZRA RLS — use current_user_org_ids() instead of default_user_org_id()
-- The original policies used default_user_org_id() which can match the wrong
-- org for multi-org users.
-- ------------------------------------------------------------

-- zra_config
DROP POLICY IF EXISTS "zra_config_read" ON zra_config;
DROP POLICY IF EXISTS "zra_config_write" ON zra_config;

CREATE POLICY "zra_config_read" ON zra_config
  FOR SELECT USING (org_id IN (SELECT current_user_org_ids()));
CREATE POLICY "zra_config_write" ON zra_config
  FOR ALL USING (org_id IN (SELECT current_user_writable_org_ids()));

-- zra_invoices
DROP POLICY IF EXISTS "zra_invoices_read" ON zra_invoices;
DROP POLICY IF EXISTS "zra_invoices_write" ON zra_invoices;

CREATE POLICY "zra_invoices_read" ON zra_invoices
  FOR SELECT USING (org_id IN (SELECT current_user_org_ids()));
CREATE POLICY "zra_invoices_write" ON zra_invoices
  FOR ALL USING (org_id IN (SELECT current_user_writable_org_ids()));

-- ------------------------------------------------------------
-- M13: Allow negative customer balances (overpayment = credit owed)
-- Remove the GREATEST(…, 0) clamp from adjust_customer_balance.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION adjust_customer_balance(
  p_customer_id UUID,
  p_delta NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_new_balance NUMERIC;
BEGIN
  UPDATE customers
     SET balance = balance + p_delta
   WHERE id = p_customer_id
  RETURNING balance INTO v_new_balance;

  RETURN v_new_balance;
END;
$$;

COMMIT;
