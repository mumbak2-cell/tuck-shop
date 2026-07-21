-- ============================================================
-- Migration 050: Suppliers master list
--
-- "Supplier" was free text on every form (stock_receipts, purchases,
-- wms_purchase_orders, wms_receipts), retyped by hand each delivery — so the
-- same supplier could be spelled four ways and there was no way to correct one.
--
-- This adds an org-scoped suppliers list the operator manages (name, phone,
-- email, notes, active). The Receive Stock and WMS Purchase Order forms pick
-- from it instead of free-typing.
--
-- Deliberately NOT changing the existing `supplier` TEXT columns to foreign
-- keys: those four tables carry historical rows and are read by several
-- reports, so the forms keep writing the chosen supplier's NAME into the
-- existing column. The list is the source of the dropdown, not a new join.
-- Trade-off: renaming a supplier later does not retroactively rename it on past
-- deliveries. Revisit only if supplier-level reporting needs hard linkage.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL DEFAULT default_user_org_id() REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  phone TEXT,
  email TEXT,
  notes TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One supplier per name per org, case- and whitespace-insensitive, so "Makro",
-- "makro" and " Makro " can't all exist side by side.
CREATE UNIQUE INDEX IF NOT EXISTS suppliers_org_name_unique
  ON suppliers (org_id, lower(trim(name)));

ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;

-- Mirrors the products policy set: read for any member of the org, writes
-- gated on the subscription/trial state via current_user_writable_org_ids().
DROP POLICY IF EXISTS "suppliers_org_read" ON suppliers;
CREATE POLICY "suppliers_org_read" ON suppliers FOR SELECT
  USING (org_id IN (SELECT current_user_org_ids()));

DROP POLICY IF EXISTS "suppliers_org_insert" ON suppliers;
CREATE POLICY "suppliers_org_insert" ON suppliers FOR INSERT
  WITH CHECK (org_id IN (SELECT current_user_writable_org_ids()));

DROP POLICY IF EXISTS "suppliers_org_update" ON suppliers;
CREATE POLICY "suppliers_org_update" ON suppliers FOR UPDATE
  USING (org_id IN (SELECT current_user_org_ids()))
  WITH CHECK (org_id IN (SELECT current_user_writable_org_ids()));

DROP POLICY IF EXISTS "suppliers_org_delete" ON suppliers;
CREATE POLICY "suppliers_org_delete" ON suppliers FOR DELETE
  USING (org_id IN (SELECT current_user_writable_org_ids()));

-- ------------------------------------------------------------
-- Seed each org's list from the supplier names it has already used, so the
-- dropdown is populated on day one. One canonical spelling per name per org.
-- ------------------------------------------------------------
INSERT INTO suppliers (org_id, name)
SELECT org_id, MIN(trim(supplier)) AS name
FROM (
  SELECT org_id, supplier FROM stock_receipts      WHERE supplier IS NOT NULL AND trim(supplier) <> ''
  UNION ALL
  SELECT org_id, supplier FROM purchases           WHERE supplier IS NOT NULL AND trim(supplier) <> ''
  UNION ALL
  SELECT org_id, supplier FROM wms_purchase_orders WHERE supplier IS NOT NULL AND trim(supplier) <> ''
  UNION ALL
  SELECT org_id, supplier FROM wms_receipts        WHERE supplier IS NOT NULL AND trim(supplier) <> ''
) s
WHERE org_id IS NOT NULL
GROUP BY org_id, lower(trim(supplier))
ON CONFLICT (org_id, lower(trim(name))) DO NOTHING;

COMMIT;
