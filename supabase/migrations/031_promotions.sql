-- ============================================================
-- Migration 031: Promotions (time-limited discounts)
--
-- Lets operators create promotions with a percentage discount
-- that apply to selected products for a date range. POS checks
-- active promotions at sale time — selling_price is never
-- modified, so prices revert automatically when the promotion
-- end_date passes.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. promotions — one row per promotion
-- ------------------------------------------------------------

CREATE TABLE promotions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL DEFAULT default_user_org_id() REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  discount_percent NUMERIC(5,2) NOT NULL CHECK (discount_percent > 0 AND discount_percent <= 100),
  start_date DATE NOT NULL DEFAULT CURRENT_DATE,
  end_date DATE NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by TEXT,
  CHECK (end_date >= start_date)
);

ALTER TABLE promotions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "promotions_read" ON promotions
  FOR SELECT USING (org_id IN (SELECT current_user_org_ids()));

CREATE POLICY "promotions_insert" ON promotions
  FOR INSERT WITH CHECK (org_id IN (SELECT current_user_org_ids()));

CREATE POLICY "promotions_update" ON promotions
  FOR UPDATE USING (org_id IN (SELECT current_user_org_ids()));

CREATE POLICY "promotions_delete" ON promotions
  FOR DELETE USING (org_id IN (SELECT current_user_org_ids()));

CREATE INDEX idx_promotions_org_active ON promotions (org_id, active, start_date, end_date);

-- ------------------------------------------------------------
-- 2. promotion_items — products in each promotion
-- ------------------------------------------------------------

CREATE TABLE promotion_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id UUID NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  UNIQUE (promotion_id, product_id)
);

ALTER TABLE promotion_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "promotion_items_read" ON promotion_items
  FOR SELECT USING (
    promotion_id IN (SELECT id FROM promotions WHERE org_id IN (SELECT current_user_org_ids()))
  );

CREATE POLICY "promotion_items_insert" ON promotion_items
  FOR INSERT WITH CHECK (
    promotion_id IN (SELECT id FROM promotions WHERE org_id IN (SELECT current_user_org_ids()))
  );

CREATE POLICY "promotion_items_delete" ON promotion_items
  FOR DELETE USING (
    promotion_id IN (SELECT id FROM promotions WHERE org_id IN (SELECT current_user_org_ids()))
  );

CREATE INDEX idx_promotion_items_product ON promotion_items (product_id);

COMMIT;
