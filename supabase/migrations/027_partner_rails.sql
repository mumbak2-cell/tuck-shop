-- ============================================================
-- Migration 027: Partner rails (Slice 4 Phase 4a)
--
-- Adds a referral programme so on-the-ground sales agents in SADC
-- can refer new shops to Tilify and earn a recurring commission on
-- the MRR those shops pay. Three new tables, one column added to
-- organizations, plus a platform_admins concept so MK Global staff
-- can see all partners and run payouts.
--
-- Architecture:
--   - partners: one row per active partner. Each has a unique short
--     code (e.g. "JIMMY2026") and a commission percentage.
--   - referrals: links organizations to the partner whose code was
--     used at signup. One row per (partner, org).
--   - commission_payouts: snapshot of MRR + commission owed for a
--     period, with manual paid_at marking by a platform admin.
--   - platform_admins: a small allowlist of user ids that can manage
--     partners and payouts. Initially just mumbak2@gmail.com.
--   - organizations.referral_code captures the raw string used at
--     signup so we have it even if the partner record changes.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. partners table
-- ------------------------------------------------------------

CREATE TABLE partners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  commission_pct NUMERIC(5,2) NOT NULL DEFAULT 20.00,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','terminated')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_partners_code ON partners(code);
CREATE INDEX idx_partners_user ON partners(user_id);
CREATE INDEX idx_partners_status ON partners(status);

-- ------------------------------------------------------------
-- 2. organizations.referral_code (the raw code used at signup)
-- ------------------------------------------------------------

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS referral_code TEXT;

CREATE INDEX IF NOT EXISTS idx_organizations_referral_code ON organizations(referral_code);

-- ------------------------------------------------------------
-- 3. referrals table — one row per (partner, org)
-- ------------------------------------------------------------

CREATE TABLE referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  referred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  converted_at TIMESTAMPTZ,
  -- status is derived but cached for fast list queries
  status TEXT NOT NULL DEFAULT 'trialing' CHECK (status IN ('trialing','active','churned')),
  UNIQUE (partner_id, org_id)
);

CREATE INDEX idx_referrals_partner ON referrals(partner_id);
CREATE INDEX idx_referrals_org ON referrals(org_id);
CREATE INDEX idx_referrals_status ON referrals(status);

-- ------------------------------------------------------------
-- 4. commission_payouts table
-- ------------------------------------------------------------

CREATE TABLE commission_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  total_referrals_active INTEGER NOT NULL DEFAULT 0,
  total_mrr_zar NUMERIC(12,2) NOT NULL DEFAULT 0,
  commission_pct NUMERIC(5,2) NOT NULL,
  commission_amount_zar NUMERIC(12,2) NOT NULL,
  paid_at TIMESTAMPTZ,
  paid_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  paid_reference TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (period_end >= period_start)
);

CREATE INDEX idx_payouts_partner ON commission_payouts(partner_id);
CREATE INDEX idx_payouts_paid_at ON commission_payouts(paid_at);
CREATE INDEX idx_payouts_period ON commission_payouts(period_start, period_end);

-- ------------------------------------------------------------
-- 5. platform_admins table
--    A tiny allowlist. Initially seeded with mumbak2@gmail.com if
--    that user exists in auth.users at migration time.
-- ------------------------------------------------------------

CREATE TABLE platform_admins (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes TEXT
);

INSERT INTO platform_admins (user_id, notes)
SELECT id, 'Founder — auto-seeded on migration 027' FROM auth.users
WHERE email = 'mumbak2@gmail.com'
ON CONFLICT (user_id) DO NOTHING;

-- ------------------------------------------------------------
-- 6. is_platform_admin() helper for RLS
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION is_platform_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM platform_admins WHERE user_id = auth.uid()
  );
$$;

-- ------------------------------------------------------------
-- 7. RLS — partners can see their own row + their referrals + their
--    payouts. Platform admins can see/modify everything.
-- ------------------------------------------------------------

ALTER TABLE partners ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;

-- partners: own row visible; admin sees all
CREATE POLICY "partners_select_own" ON partners
  FOR SELECT USING (user_id = auth.uid() OR is_platform_admin());

CREATE POLICY "partners_admin_all" ON partners
  FOR ALL USING (is_platform_admin()) WITH CHECK (is_platform_admin());

-- referrals: own referrals visible to partner; admin sees all
CREATE POLICY "referrals_select_own" ON referrals
  FOR SELECT USING (
    partner_id IN (SELECT id FROM partners WHERE user_id = auth.uid())
    OR is_platform_admin()
  );

CREATE POLICY "referrals_admin_all" ON referrals
  FOR ALL USING (is_platform_admin()) WITH CHECK (is_platform_admin());

-- commission_payouts: own payouts visible to partner; admin manages
CREATE POLICY "payouts_select_own" ON commission_payouts
  FOR SELECT USING (
    partner_id IN (SELECT id FROM partners WHERE user_id = auth.uid())
    OR is_platform_admin()
  );

CREATE POLICY "payouts_admin_all" ON commission_payouts
  FOR ALL USING (is_platform_admin()) WITH CHECK (is_platform_admin());

-- platform_admins: only admins can see who else is an admin
CREATE POLICY "platform_admins_admin_all" ON platform_admins
  FOR ALL USING (is_platform_admin()) WITH CHECK (is_platform_admin());

-- ------------------------------------------------------------
-- 8. Update create_organization_for_user to accept a referral code
--    and attribute the new org to a partner.
--    Codes are matched case-insensitively. Unknown codes are stored
--    on the org but no referral row is created (graceful degrade).
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION create_organization_for_user(
  p_name TEXT,
  p_currency TEXT DEFAULT 'ZAR',
  p_referral_code TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_org_id UUID;
  new_location_id UUID;
  calling_user UUID;
  calling_email TEXT;
  matched_partner_id UUID;
  normalized_code TEXT;
BEGIN
  calling_user := auth.uid();
  IF calling_user IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF EXISTS (SELECT 1 FROM org_members WHERE user_id = calling_user) THEN
    RAISE EXCEPTION 'User already belongs to an organization';
  END IF;

  SELECT email INTO calling_email FROM auth.users WHERE id = calling_user;

  -- Normalize and try to match the referral code to an active partner.
  normalized_code := NULLIF(UPPER(TRIM(p_referral_code)), '');
  IF normalized_code IS NOT NULL THEN
    SELECT id INTO matched_partner_id
    FROM partners
    WHERE UPPER(code) = normalized_code AND status = 'active'
    LIMIT 1;
  END IF;

  INSERT INTO organizations (name, slug, referral_code)
  VALUES (
    p_name,
    LOWER(REGEXP_REPLACE(p_name, '[^a-zA-Z0-9]+', '-', 'g')) || '-' || SUBSTRING(gen_random_uuid()::text, 1, 6),
    normalized_code
  )
  RETURNING id INTO new_org_id;

  INSERT INTO locations (org_id, name, sort_order)
  VALUES (new_org_id, 'Main Shop', 0)
  RETURNING id INTO new_location_id;

  INSERT INTO org_members (org_id, user_id, role)
  VALUES (new_org_id, calling_user, 'owner');

  INSERT INTO app_settings (org_id, key, value) VALUES
    (new_org_id, 'business_name', p_name),
    (new_org_id, 'currency', p_currency),
    (new_org_id, 'setup_completed', 'false'),
    (new_org_id, 'next_inventory_number', '1');

  INSERT INTO location_settings (org_id, location_id, key, value) VALUES
    (new_org_id, new_location_id, 'admin_pin', '1234'),
    (new_org_id, new_location_id, 'cashier_pin', '0000'),
    (new_org_id, new_location_id, 'ikhokha_link', ''),
    (new_org_id, new_location_id, 'business_phone', ''),
    (new_org_id, new_location_id, 'requires_shift', 'false'),
    (new_org_id, new_location_id, 'requires_stock_count_to_close', 'false');

  IF calling_email IS NOT NULL THEN
    INSERT INTO report_subscriptions (org_id, email, enabled)
    VALUES (new_org_id, calling_email, FALSE);
  END IF;

  -- Record the referral if we matched a partner.
  IF matched_partner_id IS NOT NULL THEN
    INSERT INTO referrals (partner_id, org_id, status)
    VALUES (matched_partner_id, new_org_id, 'trialing')
    ON CONFLICT (partner_id, org_id) DO NOTHING;
  END IF;

  RETURN new_org_id;
END;
$$;

-- ------------------------------------------------------------
-- 9. Trigger: sync referrals.status when org subscription_status changes.
--    Keeps the partner's referral list accurate in real time.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION sync_referral_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.subscription_status = 'active' THEN
    UPDATE referrals
    SET status = 'active',
        converted_at = COALESCE(converted_at, NOW())
    WHERE org_id = NEW.id AND status <> 'active';
  ELSIF NEW.subscription_status IN ('cancelled','past_due','inactive') THEN
    UPDATE referrals
    SET status = 'churned'
    WHERE org_id = NEW.id AND status = 'active';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_org_referral_sync ON organizations;
CREATE TRIGGER trg_org_referral_sync
  AFTER UPDATE OF subscription_status ON organizations
  FOR EACH ROW EXECUTE FUNCTION sync_referral_status();

COMMIT;
