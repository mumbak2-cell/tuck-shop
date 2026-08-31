-- ============================================================
-- Migration 103: Fix create_organization_for_user overload split
--
-- Migration 097 added expense_categories seeding to org creation, but did
-- it by CREATE OR REPLACE on the OLD 2-arg signature
-- (p_name, p_currency) instead of the live 3-arg signature
-- (p_name, p_currency, p_referral_code) that migration 076 introduced and
-- that the signup page actually calls (src/app/(auth)/signup/page.tsx
-- always sends p_referral_code). Postgres treats those as two distinct
-- functions, so 097 created a dead second overload that PostgREST never
-- routes to (the frontend's call always matches the 3-arg one by
-- parameter name) — every real signup since 097 got no default expense
-- categories, the trial-length/partner-referral/location/location_settings
-- logic from 076 kept running, unaffected but stuck without 097's fix.
--
-- Drop the dead 2-arg overload (same "old signature must be dropped, not
-- just replaced" rule already documented for submit_sale_batch in
-- CLAUDE.md) and redefine the live 3-arg one with the expense_categories
-- insert folded in.
-- ============================================================

BEGIN;

DROP FUNCTION IF EXISTS create_organization_for_user(p_name TEXT, p_currency TEXT);

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

  INSERT INTO expense_categories (org_id, name, sort_order) VALUES
    (new_org_id, 'Transport', 0),
    (new_org_id, 'Fuel', 1),
    (new_org_id, 'Rent', 2),
    (new_org_id, 'Electricity', 3),
    (new_org_id, 'Consumables', 4),
    (new_org_id, 'Wages', 5),
    (new_org_id, 'Stock Purchases', 6),
    (new_org_id, 'Ingredient Purchases', 7),
    (new_org_id, 'Director Withdrawal', 8),
    (new_org_id, 'Other', 9);

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

COMMIT;
