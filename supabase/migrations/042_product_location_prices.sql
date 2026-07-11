-- ============================================================
-- Migration 042: Per-location price overrides (branch pricing)
--
-- products.selling_price stays the BASE price for a product, org-wide.
-- This table holds optional per-branch OVERRIDES: a row here means "at
-- this location, sell this product for this price instead of the base".
-- Absence of a row = use the base price. So the common case (same price
-- everywhere) needs zero rows, and only the exceptions are stored.
--
-- Effective price at the POS = COALESCE(override for current location,
-- products.selling_price). Because sales snapshot unit_price at sale time,
-- historical reporting needs no change.
--
-- Mirrors product_stock (migration 024): keyed by (product_id, location_id),
-- org- and location-scoped RLS, writes gated by current_user_writable_org_ids().
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS product_location_prices (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id    UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  location_id   UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  selling_price DECIMAL(10,2) NOT NULL CHECK (selling_price >= 0),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product_id, location_id)
);

CREATE INDEX IF NOT EXISTS idx_plp_org ON product_location_prices(org_id);
CREATE INDEX IF NOT EXISTS idx_plp_product ON product_location_prices(product_id);
CREATE INDEX IF NOT EXISTS idx_plp_location ON product_location_prices(location_id);

-- org_id defaults from the caller's org so client upserts can omit it,
-- exactly as product_stock does.
ALTER TABLE product_location_prices ALTER COLUMN org_id SET DEFAULT default_user_org_id();

ALTER TABLE product_location_prices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "plp_read" ON product_location_prices;
DROP POLICY IF EXISTS "plp_insert" ON product_location_prices;
DROP POLICY IF EXISTS "plp_update" ON product_location_prices;
DROP POLICY IF EXISTS "plp_delete" ON product_location_prices;

-- Read: any member who can see the org and the location (cashiers see their
-- own location's prices; owners/admins see every location's — needed both to
-- ring up sales and to manage the price list).
CREATE POLICY "plp_read" ON product_location_prices
  FOR SELECT USING (
    org_id IN (SELECT current_user_org_ids())
    AND location_id IN (SELECT current_user_location_ids())
  );
CREATE POLICY "plp_insert" ON product_location_prices
  FOR INSERT WITH CHECK (
    org_id IN (SELECT current_user_writable_org_ids())
    AND location_id IN (SELECT current_user_location_ids())
  );
CREATE POLICY "plp_update" ON product_location_prices
  FOR UPDATE USING (
    org_id IN (SELECT current_user_org_ids())
    AND location_id IN (SELECT current_user_location_ids())
  ) WITH CHECK (
    org_id IN (SELECT current_user_writable_org_ids())
    AND location_id IN (SELECT current_user_location_ids())
  );
CREATE POLICY "plp_delete" ON product_location_prices
  FOR DELETE USING (
    org_id IN (SELECT current_user_writable_org_ids())
    AND location_id IN (SELECT current_user_location_ids())
  );

COMMIT;
