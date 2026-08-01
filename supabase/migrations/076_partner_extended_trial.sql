-- ============================================================
-- Migration 076: Extended trial for partner-referred signups
--
-- Shops that sign up with a valid partner referral code get a
-- 30-day trial instead of the default 14 days.
-- ============================================================

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
  v_trial_days INTEGER;
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

  -- 30-day trial for partner referrals, 14 days otherwise.
  IF matched_partner_id IS NOT NULL THEN
    v_trial_days := 30;
  ELSE
    v_trial_days := 14;
  END IF;

  INSERT INTO organizations (name, slug, referral_code, trial_ends_at)
  VALUES (
    p_name,
    LOWER(REGEXP_REPLACE(p_name, '[^a-zA-Z0-9]+', '-', 'g')) || '-' || SUBSTRING(gen_random_uuid()::text, 1, 6),
    normalized_code,
    NOW() + (v_trial_days || ' days')::INTERVAL
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
