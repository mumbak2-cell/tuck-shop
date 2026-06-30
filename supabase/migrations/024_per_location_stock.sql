-- ============================================================
-- Migration 024: Per-location stock (Slice 5 Phase 5a)
--
-- Each shop tracks its own physical stock. Sales decrement that
-- shop's stock. The owner sees per-location plus aggregated views.
--
-- Architecture:
--   - product_stock table keyed by (product_id, location_id) holds the
--     authoritative quantity for each shop.
--   - products.opening_stock is RETAINED as a convenience column but is
--     now the SUM of all locations (kept in sync by trigger). New code
--     should read product_stock; legacy reads still see a sane total.
--   - stock_mode setting on the org defaults to 'per_location'. Operators
--     who want the old central-warehouse pattern can set it to 'central',
--     which is just a UX convention (the system always uses product_stock).
--   - New products' opening_stock is allocated to the currently-active
--     location when the operator creates them.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. product_stock table
-- ------------------------------------------------------------

CREATE TABLE product_stock (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL DEFAULT 0,
  reorder_level INTEGER NOT NULL DEFAULT 0,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product_id, location_id)
);

CREATE INDEX idx_product_stock_org ON product_stock(org_id);
CREATE INDEX idx_product_stock_product ON product_stock(product_id);
CREATE INDEX idx_product_stock_location ON product_stock(location_id);

ALTER TABLE product_stock ENABLE ROW LEVEL SECURITY;

CREATE POLICY "product_stock_read" ON product_stock
  FOR SELECT USING (
    org_id IN (SELECT current_user_org_ids())
    AND location_id IN (SELECT current_user_location_ids())
  );
CREATE POLICY "product_stock_insert" ON product_stock
  FOR INSERT WITH CHECK (
    org_id IN (SELECT current_user_writable_org_ids())
    AND location_id IN (SELECT current_user_location_ids())
  );
CREATE POLICY "product_stock_update" ON product_stock
  FOR UPDATE USING (
    org_id IN (SELECT current_user_org_ids())
    AND location_id IN (SELECT current_user_location_ids())
  ) WITH CHECK (
    org_id IN (SELECT current_user_writable_org_ids())
    AND location_id IN (SELECT current_user_location_ids())
  );
CREATE POLICY "product_stock_delete" ON product_stock
  FOR DELETE USING (
    org_id IN (SELECT current_user_writable_org_ids())
    AND location_id IN (SELECT current_user_location_ids())
  );

ALTER TABLE product_stock ALTER COLUMN org_id SET DEFAULT default_user_org_id();

-- ------------------------------------------------------------
-- 2. Backfill: every existing product's opening_stock goes to its
--    org's Main Shop as a single product_stock row.
-- ------------------------------------------------------------

INSERT INTO product_stock (org_id, product_id, location_id, quantity, reorder_level)
SELECT
  p.org_id,
  p.id,
  l.id,
  p.opening_stock,
  p.reorder_level
FROM products p
JOIN locations l ON l.org_id = p.org_id AND l.name = 'Main Shop'
ON CONFLICT (product_id, location_id) DO NOTHING;

-- ------------------------------------------------------------
-- 3. Keep products.opening_stock in sync as the SUM across locations.
--    Existing app code that reads products.opening_stock continues to
--    work (it sees the org-wide total), while new code reads
--    product_stock per-location for accurate stock per shop.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION sync_product_opening_stock()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  p UUID;
  total INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    p := OLD.product_id;
  ELSE
    p := NEW.product_id;
  END IF;
  SELECT COALESCE(SUM(quantity), 0) INTO total FROM product_stock WHERE product_id = p;
  UPDATE products SET opening_stock = total WHERE id = p;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_product_stock_sync ON product_stock;
CREATE TRIGGER trg_product_stock_sync
  AFTER INSERT OR UPDATE OR DELETE ON product_stock
  FOR EACH ROW EXECUTE FUNCTION sync_product_opening_stock();

-- ------------------------------------------------------------
-- 4. Stock-mode setting on the org. Default to 'per_location'.
--    Backfill every existing org with the default.
-- ------------------------------------------------------------

INSERT INTO app_settings (org_id, key, value)
SELECT id, 'stock_mode', 'per_location'
FROM organizations
ON CONFLICT (org_id, key) DO NOTHING;

-- ------------------------------------------------------------
-- 5. New deduct_stock RPC that takes location_id and decrements
--    the right product_stock row. Existing callers passing only
--    product_id and quantity will fall through to the legacy
--    deduct_stock function (which still updates products.opening_stock
--    but does so org-wide, suitable for the 'central' stock_mode).
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION deduct_stock_at_location(
  p_product_id UUID,
  p_quantity   INTEGER,
  p_location_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Ensure a row exists so we can decrement it; will create with 0 then go negative if needed
  INSERT INTO product_stock (product_id, location_id, quantity, org_id)
  SELECT p_product_id, p_location_id, 0, p.org_id
  FROM products p WHERE p.id = p_product_id
  ON CONFLICT (product_id, location_id) DO NOTHING;

  UPDATE product_stock
  SET quantity = GREATEST(quantity - p_quantity, 0),
      last_updated = NOW()
  WHERE product_id = p_product_id AND location_id = p_location_id;
END;
$$;

CREATE OR REPLACE FUNCTION add_product_stock_at_location(
  p_product_id UUID,
  p_quantity   INTEGER,
  p_location_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO product_stock (product_id, location_id, quantity, org_id)
  SELECT p_product_id, p_location_id, p_quantity, p.org_id
  FROM products p WHERE p.id = p_product_id
  ON CONFLICT (product_id, location_id) DO UPDATE
  SET quantity = product_stock.quantity + EXCLUDED.quantity,
      last_updated = NOW();
END;
$$;

COMMIT;
