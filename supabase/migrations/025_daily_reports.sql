-- ============================================================
-- Migration 025: Daily sales report subscriptions (Slice 6 Phase 6a)
--
-- Each org has zero or more recipients who receive yesterday's sales
-- summary by email each morning. Default behaviour: when a new org
-- is created via create_organization_for_user, a subscription row is
-- seeded for the owner's auth email, ENABLED = false. Operators turn
-- it on in Settings (Phase 6b). This avoids surprising new users with
-- mail they did not ask for.
-- ============================================================

BEGIN;

CREATE TABLE report_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  /** Local hour at which the recipient wants the digest. Cron runs once
   *  globally; this lets recipients customise display copy and lets v2
   *  filter recipients by their local hour. */
  send_hour_local INTEGER NOT NULL DEFAULT 6 CHECK (send_hour_local BETWEEN 0 AND 23),
  /** Last successful send. Prevents double-sends if the cron retries. */
  last_sent_at TIMESTAMPTZ,
  /** Last error, useful for debugging delivery problems from Settings. */
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, email)
);

CREATE INDEX idx_report_subs_org ON report_subscriptions(org_id);
CREATE INDEX idx_report_subs_enabled ON report_subscriptions(enabled) WHERE enabled = TRUE;

ALTER TABLE report_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "report_subs_read" ON report_subscriptions
  FOR SELECT USING (org_id IN (SELECT current_user_org_ids()));
CREATE POLICY "report_subs_insert" ON report_subscriptions
  FOR INSERT WITH CHECK (org_id IN (SELECT current_user_writable_org_ids()));
CREATE POLICY "report_subs_update" ON report_subscriptions
  FOR UPDATE USING (org_id IN (SELECT current_user_org_ids()))
  WITH CHECK (org_id IN (SELECT current_user_writable_org_ids()));
CREATE POLICY "report_subs_delete" ON report_subscriptions
  FOR DELETE USING (org_id IN (SELECT current_user_writable_org_ids()));

ALTER TABLE report_subscriptions ALTER COLUMN org_id SET DEFAULT default_user_org_id();

-- ------------------------------------------------------------
-- Backfill: every existing org gets a disabled subscription row
-- using the owner's auth email. Operator enables it in Settings.
-- ------------------------------------------------------------

INSERT INTO report_subscriptions (org_id, email, enabled)
SELECT DISTINCT om.org_id, u.email, FALSE
FROM org_members om
JOIN auth.users u ON u.id = om.user_id
WHERE om.role = 'owner' AND u.email IS NOT NULL
ON CONFLICT (org_id, email) DO NOTHING;

-- ------------------------------------------------------------
-- Update create_organization_for_user RPC to seed a (disabled)
-- subscription row using the new owner's email.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION create_organization_for_user(p_name TEXT, p_currency TEXT DEFAULT 'ZAR')
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
BEGIN
  calling_user := auth.uid();
  IF calling_user IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF EXISTS (SELECT 1 FROM org_members WHERE user_id = calling_user) THEN
    RAISE EXCEPTION 'User already belongs to an organization';
  END IF;

  SELECT email INTO calling_email FROM auth.users WHERE id = calling_user;

  INSERT INTO organizations (name, slug)
  VALUES (
    p_name,
    LOWER(REGEXP_REPLACE(p_name, '[^a-zA-Z0-9]+', '-', 'g')) || '-' || SUBSTRING(gen_random_uuid()::text, 1, 6)
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

  -- Daily digest subscription: seeded but disabled. Operator opts in.
  IF calling_email IS NOT NULL THEN
    INSERT INTO report_subscriptions (org_id, email, enabled)
    VALUES (new_org_id, calling_email, FALSE);
  END IF;

  RETURN new_org_id;
END;
$$;

COMMIT;
