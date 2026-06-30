-- ============================================================
-- Migration 022: Billing fields and invoice events log (Slice 3b)
--
-- Extends the organizations row with the minimum state needed to track
-- a recurring Subscription against Paystack or Flutterwave, plus an
-- append-only invoice_events table that every webhook delivery writes
-- to so we have a full audit trail of what each provider sent us.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Billing fields on the organization
-- ------------------------------------------------------------

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS billing_provider TEXT
    CHECK (billing_provider IN ('paystack', 'flutterwave', 'manual') OR billing_provider IS NULL),
  ADD COLUMN IF NOT EXISTS billing_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS billing_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS billing_currency TEXT,
  -- Most recent charge amount in minor units. For receipts and the billing page.
  ADD COLUMN IF NOT EXISTS last_charge_minor INTEGER,
  ADD COLUMN IF NOT EXISTS last_charge_at TIMESTAMPTZ,
  -- The Subscription is paid through this date. After this date the org
  -- reverts to read-only until a successful charge extends it.
  ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_orgs_billing_subscription ON organizations(billing_subscription_id);

-- ------------------------------------------------------------
-- 2. invoice_events - append-only log of webhook deliveries
-- ------------------------------------------------------------

CREATE TABLE invoice_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  provider TEXT NOT NULL CHECK (provider IN ('paystack', 'flutterwave')),
  event_type TEXT NOT NULL,
  /** Provider's own transaction or subscription reference, useful for support. */
  provider_reference TEXT,
  /** Amount in minor units. */
  amount_minor INTEGER,
  currency TEXT,
  /** Full payload received from the webhook, for forensics. */
  payload JSONB NOT NULL,
  /** Whether we successfully reconciled the event into organization state. */
  processed BOOLEAN NOT NULL DEFAULT FALSE,
  processing_error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_invoice_events_org ON invoice_events(org_id);
CREATE INDEX idx_invoice_events_provider_ref ON invoice_events(provider, provider_reference);
CREATE INDEX idx_invoice_events_received ON invoice_events(received_at DESC);

ALTER TABLE invoice_events ENABLE ROW LEVEL SECURITY;

-- Members can read their own org's invoice events for the billing page.
CREATE POLICY "invoice_events_org_read" ON invoice_events
  FOR SELECT
  USING (org_id IN (SELECT current_user_org_ids()));

-- Writes happen ONLY via the webhook endpoint (service role bypasses RLS).
-- No INSERT/UPDATE/DELETE policy for anon/auth users.

-- ------------------------------------------------------------
-- 3. Helper: an org is paid-active if status is 'active' and either
--    no current_period_end is set yet (trust the status), or the
--    period end is in the future.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION is_org_paid_active(p_org_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT subscription_status = 'active'
    AND (current_period_end IS NULL OR current_period_end > NOW())
  FROM organizations
  WHERE id = p_org_id;
$$;

COMMIT;
