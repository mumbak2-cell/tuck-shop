-- ============================================================
-- Migration 097: Per-org expense categories
--
-- Expense categories were a single hardcoded list (EXPENSE_CATEGORIES in
-- src/types/database.ts) shared by every tenant. Different shop types need
-- different categories (e.g. a pharmacy has no use for "Fuel"/"Rent" but
-- needs "Security Guard"), so this mirrors the existing per-org `categories`
-- table (migration 019) for expenses: one row per category per org, editable
-- from the Expenses page.
--
-- `expenses.category` is plain TEXT with no CHECK constraint (migration
-- 001), so this is purely additive — no column type change, no data
-- migration on the expenses table itself. Code paths that write a fixed
-- category string directly (Receive Stock writes "Stock Purchases") are
-- unaffected whether or not that name is active in an org's list; the list
-- only drives which options are offered in the UI.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS expense_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, name)
);

CREATE INDEX IF NOT EXISTS idx_expense_categories_org ON expense_categories(org_id);

ALTER TABLE expense_categories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "expense_categories_org_read" ON expense_categories;
CREATE POLICY "expense_categories_org_read" ON expense_categories
  FOR SELECT USING (org_id IN (SELECT current_user_org_ids()));

DROP POLICY IF EXISTS "expense_categories_org_insert" ON expense_categories;
CREATE POLICY "expense_categories_org_insert" ON expense_categories
  FOR INSERT WITH CHECK (org_id IN (SELECT current_user_writable_org_ids()));

DROP POLICY IF EXISTS "expense_categories_org_update" ON expense_categories;
CREATE POLICY "expense_categories_org_update" ON expense_categories
  FOR UPDATE USING (org_id IN (SELECT current_user_org_ids()))
  WITH CHECK (org_id IN (SELECT current_user_writable_org_ids()));

DROP POLICY IF EXISTS "expense_categories_org_delete" ON expense_categories;
CREATE POLICY "expense_categories_org_delete" ON expense_categories
  FOR DELETE USING (org_id IN (SELECT current_user_writable_org_ids()));

ALTER TABLE expense_categories ALTER COLUMN org_id SET DEFAULT default_user_org_id();

-- ------------------------------------------------------------
-- Backfill every existing org with today's global list, in order, so no
-- tenant's dropdown changes as a result of this migration. Orgs edit from
-- here via Settings.
-- ------------------------------------------------------------

INSERT INTO expense_categories (org_id, name, sort_order)
SELECT o.id, c.name, c.ord
FROM organizations o
CROSS JOIN (VALUES
  ('Transport', 0),
  ('Fuel', 1),
  ('Rent', 2),
  ('Electricity', 3),
  ('Consumables', 4),
  ('Wages', 5),
  ('Stock Purchases', 6),
  ('Ingredient Purchases', 7),
  ('Director Withdrawal', 8),
  ('Other', 9)
) AS c(name, ord)
ON CONFLICT (org_id, name) DO NOTHING;

-- ------------------------------------------------------------
-- Seed the same defaults for orgs created from this point on.
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

  RETURN new_org_id;
END;
$$;

COMMIT;
