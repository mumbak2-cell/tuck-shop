-- ============================================================
-- Migration 020: Per-org sales workflow flexibility
--
-- Removes the hard-coded "shift must be open to sell" and "stock count
-- must be done to close shift" rules. They were sensible for the original
-- tuck-shop workflow but force every retail shop into the same mould.
--
-- Two new per-org settings:
--   requires_shift                  - if false, POS works without opening a shift
--   requires_stock_count_to_close   - if false, shifts can close without a stock count
--
-- Defaults for new orgs: both false (the simplest workflow).
-- The existing MK Tuck Shop org keeps both true to preserve Mumba's workflow.
-- ============================================================

BEGIN;

-- Backfill for existing orgs: MK Tuck Shop keeps the strict workflow.
-- Any other existing org defaults to the flexible workflow.
INSERT INTO app_settings (org_id, key, value)
SELECT id, 'requires_shift',
  CASE WHEN slug = 'mk-tuck-shop' THEN 'true' ELSE 'false' END
FROM organizations
ON CONFLICT (org_id, key) DO NOTHING;

INSERT INTO app_settings (org_id, key, value)
SELECT id, 'requires_stock_count_to_close',
  CASE WHEN slug = 'mk-tuck-shop' THEN 'true' ELSE 'false' END
FROM organizations
ON CONFLICT (org_id, key) DO NOTHING;

-- Update the sign-up RPC so new orgs get the flexible defaults
CREATE OR REPLACE FUNCTION create_organization_for_user(p_name TEXT, p_currency TEXT DEFAULT 'ZAR')
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_org_id UUID;
  calling_user UUID;
BEGIN
  calling_user := auth.uid();
  IF calling_user IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF EXISTS (SELECT 1 FROM org_members WHERE user_id = calling_user) THEN
    RAISE EXCEPTION 'User already belongs to an organization';
  END IF;

  INSERT INTO organizations (name, slug)
  VALUES (
    p_name,
    LOWER(REGEXP_REPLACE(p_name, '[^a-zA-Z0-9]+', '-', 'g')) || '-' || SUBSTRING(gen_random_uuid()::text, 1, 6)
  )
  RETURNING id INTO new_org_id;

  INSERT INTO org_members (org_id, user_id, role)
  VALUES (new_org_id, calling_user, 'owner');

  INSERT INTO app_settings (org_id, key, value) VALUES
    (new_org_id, 'admin_pin', '1234'),
    (new_org_id, 'cashier_pin', '0000'),
    (new_org_id, 'ikhokha_link', ''),
    (new_org_id, 'business_name', p_name),
    (new_org_id, 'business_phone', ''),
    (new_org_id, 'currency', p_currency),
    (new_org_id, 'setup_completed', 'false'),
    (new_org_id, 'next_inventory_number', '1'),
    -- Sales workflow defaults to flexible (no shift, no count required)
    (new_org_id, 'requires_shift', 'false'),
    (new_org_id, 'requires_stock_count_to_close', 'false');

  RETURN new_org_id;
END;
$$;

COMMIT;
