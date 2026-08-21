-- ============================================================
-- Migration 098: Combos (bundle two products at a fixed price)
--
-- A combo is a manual "add both at once" tile at the till, distinct
-- from promotions (031): promotions discount ONE product by a percent
-- automatically whenever it's in the cart; a combo is a fixed price
-- for a SPECIFIC PAIR of products, added as one deliberate action by
-- the cashier (tapping the combo tile), not derived from cart contents.
--
-- No RPC or stock-deduction changes needed. The POS expands a combo
-- line into its two underlying products only at sale-submission time
-- (front-end only), so submit_sale_batch, deduct_stock_at_location and
-- every existing report keep working unchanged — a combo sale writes
-- two ordinary `sales` rows (real product_id, split unit_price that
-- sums exactly to combo_price), identical in shape to any other sale.
--
-- combo_items has no DB-level "exactly 2 rows" constraint — enforcing
-- that would need a trigger for no real benefit; the UI only ever
-- offers a 2-product picker, so this stays simple.
--
-- No BEGIN/COMMIT — see migration 096 for why (Supabase SQL Editor
-- does not guarantee a pasted multi-statement script shares one
-- connection/transaction). Each statement below is independently
-- idempotent and safe to re-run.
--
-- Depends on: 001 (products), 017 (current_user_org_ids, org_members).
--
-- Record with:
--   node node_modules/supabase/dist/supabase.js migration repair \
--     --status applied 098
-- ============================================================


-- ============================================================
-- STATEMENT 1: combos — one row per combo
-- ============================================================

CREATE TABLE IF NOT EXISTS combos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL DEFAULT default_user_org_id() REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  combo_price NUMERIC(10,2) NOT NULL CHECK (combo_price >= 0),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by TEXT
);

ALTER TABLE combos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "combos_read" ON combos;
CREATE POLICY "combos_read" ON combos
  FOR SELECT USING (org_id IN (SELECT current_user_org_ids()));

DROP POLICY IF EXISTS "combos_insert" ON combos;
CREATE POLICY "combos_insert" ON combos
  FOR INSERT WITH CHECK (org_id IN (SELECT current_user_org_ids()));

DROP POLICY IF EXISTS "combos_update" ON combos;
CREATE POLICY "combos_update" ON combos
  FOR UPDATE USING (org_id IN (SELECT current_user_org_ids()));

DROP POLICY IF EXISTS "combos_delete" ON combos;
CREATE POLICY "combos_delete" ON combos
  FOR DELETE USING (org_id IN (SELECT current_user_org_ids()));

CREATE INDEX IF NOT EXISTS idx_combos_org_active ON combos (org_id, active);


-- ============================================================
-- STATEMENT 2: combo_items — products in each combo
-- ============================================================

CREATE TABLE IF NOT EXISTS combo_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  combo_id UUID NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  UNIQUE (combo_id, product_id)
);

ALTER TABLE combo_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "combo_items_read" ON combo_items;
CREATE POLICY "combo_items_read" ON combo_items
  FOR SELECT USING (
    combo_id IN (SELECT id FROM combos WHERE org_id IN (SELECT current_user_org_ids()))
  );

DROP POLICY IF EXISTS "combo_items_insert" ON combo_items;
CREATE POLICY "combo_items_insert" ON combo_items
  FOR INSERT WITH CHECK (
    combo_id IN (SELECT id FROM combos WHERE org_id IN (SELECT current_user_org_ids()))
  );

DROP POLICY IF EXISTS "combo_items_delete" ON combo_items;
CREATE POLICY "combo_items_delete" ON combo_items
  FOR DELETE USING (
    combo_id IN (SELECT id FROM combos WHERE org_id IN (SELECT current_user_org_ids()))
  );

CREATE INDEX IF NOT EXISTS idx_combo_items_product ON combo_items (product_id);


-- ============================================================
-- VERIFY (run after both statements):
--
-- SELECT table_name FROM information_schema.tables
--  WHERE table_name IN ('combos', 'combo_items');
-- ============================================================
