-- ============================================================
-- Migration 041: admin_org_overrides audit trail
--
-- Records every manual change a platform admin makes to an org's
-- subscription state from the /admin/customers page (extend trial,
-- change plan, change status, manual comp activation). These edits sit
-- OUTSIDE the payment provider (Paystack/Flutterwave), so an immutable
-- log of who changed what — and why — is the accountability trail for
-- billing state that was set by hand rather than by a webhook.
--
-- One row per changed field. Writes come from the service-role client in
-- PATCH /api/admin/orgs/[id] (which bypasses RLS); reads are restricted
-- to platform admins.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS admin_org_overrides (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  admin_user_id UUID NOT NULL REFERENCES auth.users(id),
  admin_email   TEXT,
  field         TEXT NOT NULL
                  CHECK (field IN (
                    'trial_ends_at', 'subscription_plan',
                    'subscription_status', 'current_period_end'
                  )),
  old_value     TEXT,          -- rendered as text; NULL means the column was NULL
  new_value     TEXT,
  note          TEXT,          -- admin's stated reason for the override
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_org_overrides_org
  ON admin_org_overrides(org_id, created_at DESC);

ALTER TABLE admin_org_overrides ENABLE ROW LEVEL SECURITY;

-- Platform admins may read the log. No INSERT/UPDATE/DELETE policy: the API
-- inserts via the service-role client (bypasses RLS), and the log is
-- append-only, so nobody can edit or remove entries through PostgREST.
DROP POLICY IF EXISTS "admin_overrides_read" ON admin_org_overrides;
CREATE POLICY "admin_overrides_read" ON admin_org_overrides
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM platform_admins pa WHERE pa.user_id = auth.uid()));

COMMIT;
