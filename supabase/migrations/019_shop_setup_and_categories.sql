-- ============================================================
-- Migration 019: Shop setup, dynamic categories, auto inventory IDs
--
-- Removes the hard-coded Sweets / Snacks / Drinks / etc. category list
-- (which only made sense for the original tuck shop) and turns it into
-- a per-organisation table the operator defines during shop setup.
--
-- Also removes the free-text inventory_id field. Now generated server-side
-- as "<PREFIX><4-digit sequence>" per org (e.g. STN0001, STN0002 for a
-- stationery shop, TS0001, TS0002 for a tuck shop). The prefix is chosen
-- by the operator on the setup screen.
--
-- New onboarding flow:
--   1. Operator signs up (auth.users + organizations + org_members row)
--   2. Operator is redirected to /setup
--   3. /setup asks: shop type, whether they prepare food, categories,
--      inventory ID prefix
--   4. setup_completed = true, dashboard becomes accessible
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Categories table - one row per category per org
-- ------------------------------------------------------------

CREATE TABLE categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, name)
);

CREATE INDEX idx_categories_org ON categories(org_id);

ALTER TABLE categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "categories_org_read" ON categories
  FOR SELECT USING (org_id IN (SELECT current_user_org_ids()));
CREATE POLICY "categories_org_insert" ON categories
  FOR INSERT WITH CHECK (org_id IN (SELECT current_user_writable_org_ids()));
CREATE POLICY "categories_org_update" ON categories
  FOR UPDATE USING (org_id IN (SELECT current_user_org_ids()))
  WITH CHECK (org_id IN (SELECT current_user_writable_org_ids()));
CREATE POLICY "categories_org_delete" ON categories
  FOR DELETE USING (org_id IN (SELECT current_user_writable_org_ids()));

-- Auto-populate org_id on INSERT
ALTER TABLE categories ALTER COLUMN org_id SET DEFAULT default_user_org_id();

-- ------------------------------------------------------------
-- 2. Backfill: lift any distinct category values already in products
--    into the new categories table for the MK Tuck Shop org.
-- ------------------------------------------------------------

INSERT INTO categories (org_id, name, sort_order)
SELECT
  'a0000000-0000-0000-0000-000000000001'::uuid,
  c.category,
  ROW_NUMBER() OVER (ORDER BY c.category)
FROM (SELECT DISTINCT category FROM products WHERE org_id = 'a0000000-0000-0000-0000-000000000001'::uuid AND category IS NOT NULL) c
ON CONFLICT (org_id, name) DO NOTHING;

-- ------------------------------------------------------------
-- 3. Setup-related settings on each org
-- ------------------------------------------------------------

-- For NEW orgs created from this point on, these will be inserted by
-- the create_organization_for_user RPC (see update below).
-- For the existing MK Tuck Shop org, backfill them here.

INSERT INTO app_settings (org_id, key, value) VALUES
  ('a0000000-0000-0000-0000-000000000001'::uuid, 'shop_type', 'Tuck Shop'),
  ('a0000000-0000-0000-0000-000000000001'::uuid, 'prepares_food', 'true'),
  ('a0000000-0000-0000-0000-000000000001'::uuid, 'inventory_id_prefix', 'IN'),
  ('a0000000-0000-0000-0000-000000000001'::uuid, 'setup_completed', 'true'),
  (
    'a0000000-0000-0000-0000-000000000001'::uuid,
    'next_inventory_number',
    GREATEST(
      (SELECT COALESCE(MAX(CAST(SUBSTRING(inventory_id FROM '[0-9]+$') AS INTEGER)), 0) FROM products WHERE org_id = 'a0000000-0000-0000-0000-000000000001'::uuid) + 1,
      1
    )::text
  )
ON CONFLICT (org_id, key) DO NOTHING;

-- ------------------------------------------------------------
-- 4. Inventory ID is now per-org, not globally unique
-- ------------------------------------------------------------

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_inventory_id_key;
ALTER TABLE products ADD CONSTRAINT products_org_inventory_id_unique UNIQUE (org_id, inventory_id);

-- Allow inventory_id to be null on INSERT - the trigger fills it
ALTER TABLE products ALTER COLUMN inventory_id DROP NOT NULL;

-- ------------------------------------------------------------
-- 5. Atomic inventory-ID generator and trigger
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION generate_inventory_id(p_org_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  prefix TEXT;
  next_n INT;
BEGIN
  -- Lock the row to prevent races
  SELECT value::int INTO next_n
  FROM app_settings
  WHERE org_id = p_org_id AND key = 'next_inventory_number'
  FOR UPDATE;

  IF next_n IS NULL THEN
    next_n := 1;
  END IF;

  SELECT value INTO prefix
  FROM app_settings
  WHERE org_id = p_org_id AND key = 'inventory_id_prefix';

  IF prefix IS NULL OR prefix = '' THEN
    prefix := 'ITEM';
  END IF;

  -- Persist the next number
  INSERT INTO app_settings (org_id, key, value)
  VALUES (p_org_id, 'next_inventory_number', (next_n + 1)::text)
  ON CONFLICT (org_id, key) DO UPDATE SET value = (next_n + 1)::text;

  RETURN prefix || LPAD(next_n::text, 4, '0');
END;
$$;

CREATE OR REPLACE FUNCTION trg_products_auto_inventory_id()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.inventory_id IS NULL OR NEW.inventory_id = '' THEN
    NEW.inventory_id := generate_inventory_id(NEW.org_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS products_auto_inventory_id ON products;
CREATE TRIGGER products_auto_inventory_id
  BEFORE INSERT ON products
  FOR EACH ROW EXECUTE FUNCTION trg_products_auto_inventory_id();

-- ------------------------------------------------------------
-- 6. Update the sign-up RPC so new orgs require shop setup
-- ------------------------------------------------------------

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

  -- Minimal defaults. Categories, shop type, prepares_food, inventory ID
  -- prefix all come from the /setup screen the operator sees next.
  INSERT INTO app_settings (org_id, key, value) VALUES
    (new_org_id, 'admin_pin', '1234'),
    (new_org_id, 'cashier_pin', '0000'),
    (new_org_id, 'ikhokha_link', ''),
    (new_org_id, 'business_name', p_name),
    (new_org_id, 'business_phone', ''),
    (new_org_id, 'currency', p_currency),
    (new_org_id, 'setup_completed', 'false'),
    (new_org_id, 'next_inventory_number', '1');

  RETURN new_org_id;
END;
$$;

COMMIT;
