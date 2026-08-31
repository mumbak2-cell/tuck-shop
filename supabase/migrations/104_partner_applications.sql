-- ============================================================
-- Migration 104: Self-serve partner applications
--
-- A public page (/partner/apply) lets a would-be partner submit their
-- details. This does NOT create a partner — it writes a pending row here.
-- A platform admin reviews the queue in /admin/partners and either
-- approves (which creates the partner record and sets the referral code)
-- or rejects it.
--
-- Submissions come in through POST /api/partners/apply using the service
-- role client, so there is no public INSERT policy — RLS only needs to let
-- platform admins read and manage the queue.
--
-- Idempotent. Run each STATEMENT block separately, then:
--   node node_modules/supabase/dist/supabase.js migration repair --status applied 104
-- ============================================================

-- STATEMENT 1: table ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS partner_applications (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT NOT NULL,
  email               TEXT NOT NULL,
  phone               TEXT,
  requested_code      TEXT,
  pitch               TEXT,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'rejected')),
  review_notes        TEXT,
  reviewed_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at         TIMESTAMPTZ,
  partner_id          UUID REFERENCES partners(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- STATEMENT 2: indexes -----------------------------------------------------
-- One open application per email address; approved/rejected rows don't block
-- a fresh attempt later.

CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_applications_pending_email
  ON partner_applications (LOWER(email)) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_partner_applications_status
  ON partner_applications (status, created_at DESC);

-- STATEMENT 3: RLS -------------------------------------------------------

ALTER TABLE partner_applications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "partner_applications_admin_all" ON partner_applications;
CREATE POLICY "partner_applications_admin_all" ON partner_applications
  FOR ALL USING (is_platform_admin()) WITH CHECK (is_platform_admin());
