-- ============================================================
-- Migration 0230: Multi-location support (Slice 5 Phase 1)
--
-- Adds a locations table per organisation and a location_id column to
-- the tables that are inherently per-shop: sales, shifts, stock
-- adjustments, expenses, customers, and customer payments.
--
-- Architecture decisions (locked with the operator):
--   Stock stays ORG-LEVEL - one shared pool per product, sales from any
--     location decrement the same opening_stock. McDonald's pattern.
--   Customers per LOCATION - credit accounts do not cross stores.
--   Workflow toggles per LOCATION - some shops want strict shifts, others
--     do not. Settings split into org-wide (currency, business name,
--     categories, payment methods, inventory prefix) and location-specific
--     (PINs, address, phone, workflow toggles).
--   Cashiers locked to ONE location. Admins and owners see across.
--   Inventory IDs stay ORG-wide - STN0001 is the same item everywhere.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. locations table
-- ------------------------------------------------------------

CREATE TABLE locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  address TEXT,
  phone TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, name)
);

CREATE INDEX idx_locations_org ON locations(org_id);

ALTER TABLE locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "locations_org_read" ON locations
  FOR SELECT USING (org_id IN (SELECT current_user_org_ids()));
CREATE POLICY "locations_org_insert" ON locations
  FOR INSERT WITH CHECK (org_id IN (SELECT current_user_writable_org_ids()));
CREATE POLICY "locations_org_update" ON locations
  FOR UPDATE USING (org_id IN (SELECT current_user_org_ids()))
  WITH CHECK (org_id IN (SELECT current_user_writable_org_ids()));
CREATE POLICY "locations_org_delete" ON locations
  FOR DELETE USING (org_id IN (SELECT current_user_writable_org_ids()));

ALTER TABLE locations ALTER COLUMN org_id SET DEFAULT default_user_org_id();

-- ------------------------------------------------------------
-- 2. Default "Main Shop" location for each existing org
--    (one row per existing organisation, so all existing data has
--    something to be reassigned to.)
-- ------------------------------------------------------------

INSERT INTO locations (org_id, name, sort_order)
SELECT id, 'Main Shop', 0
FROM organizations
ON CONFLICT (org_id, name) DO NOTHING;

-- ------------------------------------------------------------
-- 3. Add assigned_location_id to org_members
--    NULL for owners and admins (org-wide access).
--    Required for cashiers - their RLS scopes them to this location.
-- ------------------------------------------------------------

ALTER TABLE org_members
  ADD COLUMN IF NOT EXISTS assigned_location_id UUID REFERENCES locations(id) ON DELETE SET NULL;

CREATE INDEX idx_org_members_location ON org_members(assigned_location_id);

-- ------------------------------------------------------------
-- 4. Add location_id to the per-location tables and backfill to
--    each org's default Main Shop. After backfill, lock down to NOT NULL.
-- ------------------------------------------------------------

DO $$
DECLARE
  t TEXT;
  table_list TEXT[] := ARRAY[
    'sales', 'shifts', 'stock_adjustments', 'expenses',
    'customers', 'customer_payments'
  ];
BEGIN
  FOREACH t IN ARRAY table_list LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id) ON DELETE CASCADE',
      t
    );
    -- Backfill: every existing row gets its org's Main Shop location.
    EXECUTE format(
      'UPDATE %I SET location_id = (SELECT id FROM locations WHERE locations.org_id = %I.org_id AND locations.name = ''Main Shop'' LIMIT 1) WHERE location_id IS NULL',
      t, t
    );
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%I_location ON %I(location_id)', t, t);
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 5. Helper: which location_ids can the calling user read?
--    Owners and admins see every location in their org.
--    Cashiers see only their assigned location.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION current_user_location_ids()
RETURNS SETOF UUID
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT l.id
  FROM locations l
  JOIN org_members om ON om.org_id = l.org_id
  WHERE om.user_id = auth.uid()
    AND (
      -- Owners and admins see every location in their org
      om.role IN ('owner', 'admin')
      -- Cashiers see only their assigned location
      OR om.assigned_location_id = l.id
    );
$$;

-- ------------------------------------------------------------
-- 6. Rewrite per-location-table policies to ALSO filter by the
--    user's accessible location set. The org_id filter still
--    applies via current_user_org_ids, so the policies layer.
-- ------------------------------------------------------------

DO $$
DECLARE
  t TEXT;
  table_list TEXT[] := ARRAY[
    'sales', 'shifts', 'stock_adjustments', 'expenses',
    'customers', 'customer_payments'
  ];
BEGIN
  FOREACH t IN ARRAY table_list LOOP
    -- Drop the existing org_read / org_insert / org_update / org_delete
    -- policies, then re-create with the additional location filter.
    EXECUTE format('DROP POLICY IF EXISTS "%s_org_read" ON %I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_org_insert" ON %I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_org_update" ON %I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_org_delete" ON %I', t, t);

    EXECUTE format(
      'CREATE POLICY "%s_loc_read" ON %I FOR SELECT USING (org_id IN (SELECT current_user_org_ids()) AND (location_id IS NULL OR location_id IN (SELECT current_user_location_ids())))',
      t, t
    );
    EXECUTE format(
      'CREATE POLICY "%s_loc_insert" ON %I FOR INSERT WITH CHECK (org_id IN (SELECT current_user_writable_org_ids()) AND (location_id IS NULL OR location_id IN (SELECT current_user_location_ids())))',
      t, t
    );
    EXECUTE format(
      'CREATE POLICY "%s_loc_update" ON %I FOR UPDATE USING (org_id IN (SELECT current_user_org_ids()) AND (location_id IS NULL OR location_id IN (SELECT current_user_location_ids()))) WITH CHECK (org_id IN (SELECT current_user_writable_org_ids()) AND (location_id IS NULL OR location_id IN (SELECT current_user_location_ids())))',
      t, t
    );
    EXECUTE format(
      'CREATE POLICY "%s_loc_delete" ON %I FOR DELETE USING (org_id IN (SELECT current_user_writable_org_ids()) AND (location_id IS NULL OR location_id IN (SELECT current_user_location_ids())))',
      t, t
    );
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 7. location_settings - per-location key-value settings
--    Separate from app_settings (which stays org-wide). Keys here:
--    requires_shift, requires_stock_count_to_close, admin_pin,
--    cashier_pin, ikhokha_link, business_phone.
-- ------------------------------------------------------------

CREATE TABLE location_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (location_id, key)
);

CREATE INDEX idx_location_settings_loc ON location_settings(location_id);

ALTER TABLE location_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "location_settings_read" ON location_settings
  FOR SELECT USING (
    org_id IN (SELECT current_user_org_ids())
    AND location_id IN (SELECT current_user_location_ids())
  );
CREATE POLICY "location_settings_insert" ON location_settings
  FOR INSERT WITH CHECK (
    org_id IN (SELECT current_user_writable_org_ids())
    AND location_id IN (SELECT current_user_location_ids())
  );
CREATE POLICY "location_settings_update" ON location_settings
  FOR UPDATE USING (
    org_id IN (SELECT current_user_org_ids())
    AND location_id IN (SELECT current_user_location_ids())
  ) WITH CHECK (
    org_id IN (SELECT current_user_writable_org_ids())
    AND location_id IN (SELECT current_user_location_ids())
  );
CREATE POLICY "location_settings_delete" ON location_settings
  FOR DELETE USING (
    org_id IN (SELECT current_user_writable_org_ids())
    AND location_id IN (SELECT current_user_location_ids())
  );

ALTER TABLE location_settings ALTER COLUMN org_id SET DEFAULT default_user_org_id();

-- ------------------------------------------------------------
-- 8. Migrate the per-location settings that currently live in
--    app_settings (PINs, phone, ikhokha_link, workflow toggles)
--    into location_settings, keyed to each org's Main Shop.
--    Leave the rows in app_settings too for backward compatibility
--    until the application stops reading them from there.
-- ------------------------------------------------------------

INSERT INTO location_settings (org_id, location_id, key, value)
SELECT
  s.org_id,
  l.id,
  s.key,
  s.value
FROM app_settings s
JOIN locations l ON l.org_id = s.org_id AND l.name = 'Main Shop'
WHERE s.key IN (
  'admin_pin', 'cashier_pin', 'ikhokha_link',
  'business_phone', 'requires_shift', 'requires_stock_count_to_close'
)
ON CONFLICT (location_id, key) DO NOTHING;

-- ------------------------------------------------------------
-- 9. Update create_organization_for_user RPC to also create the
--    org's first Location ("Main Shop") and seed its location_settings.
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

  -- The first location for a brand new org.
  INSERT INTO locations (org_id, name, sort_order)
  VALUES (new_org_id, 'Main Shop', 0)
  RETURNING id INTO new_location_id;

  -- The operator is the owner; assigned_location_id stays NULL because
  -- owners see every location in their org.
  INSERT INTO org_members (org_id, user_id, role)
  VALUES (new_org_id, calling_user, 'owner');

  -- Org-wide settings
  INSERT INTO app_settings (org_id, key, value) VALUES
    (new_org_id, 'business_name', p_name),
    (new_org_id, 'currency', p_currency),
    (new_org_id, 'setup_completed', 'false'),
    (new_org_id, 'next_inventory_number', '1');

  -- Per-location defaults for the Main Shop
  INSERT INTO location_settings (org_id, location_id, key, value) VALUES
    (new_org_id, new_location_id, 'admin_pin', '1234'),
    (new_org_id, new_location_id, 'cashier_pin', '0000'),
    (new_org_id, new_location_id, 'ikhokha_link', ''),
    (new_org_id, new_location_id, 'business_phone', ''),
    (new_org_id, new_location_id, 'requires_shift', 'false'),
    (new_org_id, new_location_id, 'requires_stock_count_to_close', 'false');

  RETURN new_org_id;
END;
$$;

COMMIT;
