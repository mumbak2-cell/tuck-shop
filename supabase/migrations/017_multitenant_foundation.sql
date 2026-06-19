-- ============================================================
-- Migration 017: Multi-tenant foundation (Slice 1)
--
-- - Adds organizations and org_members tables
-- - Adds org_id to every existing table
-- - Backfills all existing rows to the "MK Tuck Shop" org
-- - Special handling for app_settings: primary key becomes (org_id, key)
-- - Rewrites every RLS policy to filter by the auth user's org
--
-- SAFETY: This entire migration runs inside a single transaction.
-- If anything fails, the whole thing rolls back and the database is
-- exactly where it started. The "Allow all" policies are kept active
-- right up to the very end, so live traffic is not disrupted until
-- the swap is committed atomically.
--
-- AFTER RUNNING THIS, the app will require an authenticated user for
-- every query. Anonymous queries will return zero rows. Make sure the
-- /signup and /login pages are deployed BEFORE running this migration
-- on production, and create at least one auth user mapped to the
-- MK Tuck Shop org before the first dashboard load.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Tenant tables
-- ------------------------------------------------------------

CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  trial_ends_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '14 days'),
  subscription_plan TEXT NOT NULL DEFAULT 'trial'
    CHECK (subscription_plan IN ('trial','starter','growth','pro','past_due','cancelled')),
  subscription_status TEXT NOT NULL DEFAULT 'trialing'
    CHECK (subscription_status IN ('trialing','active','past_due','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE org_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, user_id)
);

CREATE INDEX idx_org_members_user ON org_members(user_id);
CREATE INDEX idx_org_members_org ON org_members(org_id);

-- ------------------------------------------------------------
-- 2. Helper: returns the set of org_ids the current auth user belongs to
-- Used in every RLS policy below.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION current_user_org_ids()
RETURNS SETOF UUID
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT org_id FROM org_members WHERE user_id = auth.uid();
$$;

-- ------------------------------------------------------------
-- 3. Seed the default org for existing data
-- ------------------------------------------------------------

INSERT INTO organizations (id, name, slug, subscription_plan, subscription_status, trial_ends_at)
VALUES (
  'a0000000-0000-0000-0000-000000000001'::uuid,
  'MK Tuck Shop',
  'mk-tuck-shop',
  'starter',
  'active',
  NOW() + INTERVAL '365 days'
);

-- ------------------------------------------------------------
-- 4. Add org_id to every existing table, defaulting to MK Tuck Shop,
--    then drop the default so future inserts must provide it.
-- ------------------------------------------------------------

DO $$
DECLARE
  t TEXT;
  table_list TEXT[] := ARRAY[
    'products', 'ingredients', 'recipes', 'customers', 'sales',
    'stock_counts', 'production_log', 'customer_payments',
    'daily_reconciliation', 'purchases', 'expenses',
    'stock_receipts', 'stock_receipt_items', 'stock_count_audit',
    'shifts', 'stock_adjustments', 'ra_notes'
  ];
BEGIN
  FOREACH t IN ARRAY table_list LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN org_id UUID NOT NULL DEFAULT %L::uuid REFERENCES organizations(id) ON DELETE CASCADE',
      t, 'a0000000-0000-0000-0000-000000000001'
    );
    EXECUTE format('CREATE INDEX idx_%I_org ON %I(org_id)', t, t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN org_id DROP DEFAULT', t);
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 5. app_settings: change primary key from (key) to (org_id, key)
--    so each org has its own settings row set.
-- ------------------------------------------------------------

ALTER TABLE app_settings
  ADD COLUMN org_id UUID NOT NULL DEFAULT 'a0000000-0000-0000-0000-000000000001'::uuid
  REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE app_settings ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE app_settings DROP CONSTRAINT app_settings_pkey;
ALTER TABLE app_settings ADD PRIMARY KEY (org_id, key);
CREATE INDEX idx_app_settings_org ON app_settings(org_id);

-- ------------------------------------------------------------
-- 6. Drop every old "Allow all" policy.
-- ------------------------------------------------------------

DROP POLICY IF EXISTS "Allow all on products" ON products;
DROP POLICY IF EXISTS "Allow all on ingredients" ON ingredients;
DROP POLICY IF EXISTS "Allow all on recipes" ON recipes;
DROP POLICY IF EXISTS "Allow all on customers" ON customers;
DROP POLICY IF EXISTS "Allow all on sales" ON sales;
DROP POLICY IF EXISTS "Allow all on stock_counts" ON stock_counts;
DROP POLICY IF EXISTS "Allow all on production_log" ON production_log;
DROP POLICY IF EXISTS "Allow all on customer_payments" ON customer_payments;
DROP POLICY IF EXISTS "Allow all on daily_reconciliation" ON daily_reconciliation;
DROP POLICY IF EXISTS "Allow all on purchases" ON purchases;
DROP POLICY IF EXISTS "Allow all on app_settings" ON app_settings;
DROP POLICY IF EXISTS "Allow all on expenses" ON expenses;
DROP POLICY IF EXISTS "Allow all on stock_receipts" ON stock_receipts;
DROP POLICY IF EXISTS "Allow all on stock_receipt_items" ON stock_receipt_items;
DROP POLICY IF EXISTS "Allow all on stock_count_audit" ON stock_count_audit;
DROP POLICY IF EXISTS "Allow all on shifts" ON shifts;
DROP POLICY IF EXISTS "Allow all on stock_adjustments" ON stock_adjustments;
DROP POLICY IF EXISTS "Allow all on ra_notes" ON ra_notes;

-- ------------------------------------------------------------
-- 7. Create new org-scoped policies on every table.
-- ------------------------------------------------------------

DO $$
DECLARE
  t TEXT;
  table_list TEXT[] := ARRAY[
    'products', 'ingredients', 'recipes', 'customers', 'sales',
    'stock_counts', 'production_log', 'customer_payments',
    'daily_reconciliation', 'purchases', 'app_settings', 'expenses',
    'stock_receipts', 'stock_receipt_items', 'stock_count_audit',
    'shifts', 'stock_adjustments', 'ra_notes'
  ];
BEGIN
  FOREACH t IN ARRAY table_list LOOP
    EXECUTE format(
      'CREATE POLICY "%s_org_read" ON %I FOR SELECT USING (org_id IN (SELECT current_user_org_ids()))',
      t, t
    );
    EXECUTE format(
      'CREATE POLICY "%s_org_insert" ON %I FOR INSERT WITH CHECK (org_id IN (SELECT current_user_org_ids()))',
      t, t
    );
    EXECUTE format(
      'CREATE POLICY "%s_org_update" ON %I FOR UPDATE USING (org_id IN (SELECT current_user_org_ids())) WITH CHECK (org_id IN (SELECT current_user_org_ids()))',
      t, t
    );
    EXECUTE format(
      'CREATE POLICY "%s_org_delete" ON %I FOR DELETE USING (org_id IN (SELECT current_user_org_ids()))',
      t, t
    );
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 8. RLS on the new tenant tables themselves
-- ------------------------------------------------------------

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_members ENABLE ROW LEVEL SECURITY;

-- A member can see their own organization
CREATE POLICY "org_read_own" ON organizations
  FOR SELECT
  USING (id IN (SELECT current_user_org_ids()));

-- Only an owner can update the organization (rename, change plan via webhook, etc.)
CREATE POLICY "org_update_owner" ON organizations
  FOR UPDATE
  USING (id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid() AND role = 'owner'))
  WITH CHECK (id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid() AND role = 'owner'));

-- A user can see other members of orgs they belong to
CREATE POLICY "member_read_own_org" ON org_members
  FOR SELECT
  USING (org_id IN (SELECT current_user_org_ids()));

-- An owner can invite members to their org
CREATE POLICY "member_insert_owner" ON org_members
  FOR INSERT
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid() AND role = 'owner'));

-- A user can remove their own membership; an owner can remove anyone in the org
CREATE POLICY "member_delete_own_or_owner" ON org_members
  FOR DELETE
  USING (
    user_id = auth.uid()
    OR org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid() AND role = 'owner')
  );

-- ------------------------------------------------------------
-- 9. Auto-populate org_id on INSERT from the auth user's primary org.
--    This way existing application code that does
--      db.from("products").insert({ name, selling_price })
--    keeps working without having to thread org_id through every call.
--
--    PostgreSQL does not allow subqueries in DEFAULT expressions, so we
--    wrap the lookup in a function and use the function call as DEFAULT.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION default_user_org_id()
RETURNS UUID
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT org_id FROM org_members WHERE user_id = auth.uid() LIMIT 1;
$$;

DO $$
DECLARE
  t TEXT;
  table_list TEXT[] := ARRAY[
    'products', 'ingredients', 'recipes', 'customers', 'sales',
    'stock_counts', 'production_log', 'customer_payments',
    'daily_reconciliation', 'purchases', 'app_settings', 'expenses',
    'stock_receipts', 'stock_receipt_items', 'stock_count_audit',
    'shifts', 'stock_adjustments', 'ra_notes'
  ];
BEGIN
  FOREACH t IN ARRAY table_list LOOP
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN org_id SET DEFAULT default_user_org_id()',
      t
    );
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 10. Sign-up helper: create an organization and link the calling user
--     as the owner, all in one atomic call. Bypasses the chicken-and-egg
--     problem where the new user has no org_members row yet so cannot
--     pass the org_members RLS INSERT check.
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

  -- One organization per user for now (the owner). Tighten later if needed.
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

  -- Seed default settings for the new org
  INSERT INTO app_settings (org_id, key, value) VALUES
    (new_org_id, 'admin_pin', '1234'),
    (new_org_id, 'cashier_pin', '0000'),
    (new_org_id, 'ikhokha_link', ''),
    (new_org_id, 'business_name', p_name),
    (new_org_id, 'business_phone', ''),
    (new_org_id, 'currency', p_currency);

  RETURN new_org_id;
END;
$$;

COMMIT;

-- ============================================================
-- POST-DEPLOY MANUAL STEP for production cutover:
-- After this migration runs on the production database, you (Mumba)
-- need to:
--   1. Sign up at /signup with your email - this creates your auth.users row
--   2. Run the following SQL ONCE to link your user to the existing
--      MK Tuck Shop org as the owner:
--
--      INSERT INTO org_members (org_id, user_id, role)
--      VALUES (
--        'a0000000-0000-0000-0000-000000000001'::uuid,
--        (SELECT id FROM auth.users WHERE email = '<your email>'),
--        'owner'
--      );
--
-- After this, log in at /login and your existing tuck shop data
-- (products, customers, sales, stock counts) is all there under the
-- MK Tuck Shop org.
-- ============================================================
