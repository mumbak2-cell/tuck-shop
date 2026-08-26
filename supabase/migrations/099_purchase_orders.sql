-- ============================================================
-- Migration 099: Purchase Orders (Reorder List -> Receive Stock)
--
-- Ties a PO number to a set of ordered items so Receive Stock can load
-- them back in instead of the operator retyping every line by hand.
-- Reorder List already builds an order (selected products + qtys); this
-- adds a place to persist it once the operator commits to sending it.
--
-- Deliberately simple: no partial-receive state machine (that's what WMS's
-- wms_purchase_orders/085 state machine is for, a different system keyed to
-- wms_catalog, not products). A shop PO here is either Draft (created, not
-- yet received) or Received (a receipt has been logged against it) or
-- Cancelled. One receipt closes the whole PO. If that turns out to be too
-- coarse for a real workflow, add partial receiving later -- YAGNI for now.
--
-- po_number is derived the same way sales receipts and GRNs already are
-- (src/lib/receipt-code.ts): last 6 hex digits of the row's UUID, prefixed
-- "PO-". No sequence table, no collision risk beyond the UUID's own.
--
-- No BEGIN/COMMIT -- see migration 096 for why (Supabase SQL Editor does
-- not guarantee a pasted multi-statement script shares one connection).
-- Each statement below is independently idempotent and safe to re-run.
--
-- Depends on: 001 (products, ingredients), 017 (current_user_org_ids),
-- 024 (locations), 050 (suppliers name is free text, not a FK -- matches
-- stock_receipts/wms_purchase_orders convention, see CLAUDE.md).
--
-- Record with:
--   node node_modules/supabase/dist/supabase.js migration repair \
--     --status applied 099
-- ============================================================


-- ============================================================
-- STATEMENT 1: purchase_orders -- one row per order raised from Reorder List
-- ============================================================

CREATE TABLE IF NOT EXISTS purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL DEFAULT default_user_org_id() REFERENCES organizations(id) ON DELETE CASCADE,
  po_number TEXT NOT NULL,
  supplier TEXT,
  location_id UUID REFERENCES locations(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Received', 'Cancelled')),
  total_cost NUMERIC(10,2) NOT NULL DEFAULT 0,
  notes TEXT,
  created_by TEXT,
  received_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, po_number)
);

ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "purchase_orders_read" ON purchase_orders;
CREATE POLICY "purchase_orders_read" ON purchase_orders
  FOR SELECT USING (org_id IN (SELECT current_user_org_ids()));

DROP POLICY IF EXISTS "purchase_orders_insert" ON purchase_orders;
CREATE POLICY "purchase_orders_insert" ON purchase_orders
  FOR INSERT WITH CHECK (org_id IN (SELECT current_user_org_ids()));

DROP POLICY IF EXISTS "purchase_orders_update" ON purchase_orders;
CREATE POLICY "purchase_orders_update" ON purchase_orders
  FOR UPDATE USING (org_id IN (SELECT current_user_org_ids()));

DROP POLICY IF EXISTS "purchase_orders_delete" ON purchase_orders;
CREATE POLICY "purchase_orders_delete" ON purchase_orders
  FOR DELETE USING (org_id IN (SELECT current_user_org_ids()));

CREATE INDEX IF NOT EXISTS idx_purchase_orders_org_status ON purchase_orders (org_id, status);


-- ============================================================
-- STATEMENT 2: purchase_order_items -- lines on each PO
--
-- item_name is a snapshot (survives the product being renamed or deleted
-- later), same reasoning as stock_receipt_items keeping product_id
-- nullable. qty_in_pack is snapshotted too -- Receive Stock needs it to
-- convert packs -> units the same way it does for a manually-typed line,
-- and a product's pack size could change between order and delivery.
-- ============================================================

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  ingredient_id UUID REFERENCES ingredients(id) ON DELETE SET NULL,
  item_name TEXT NOT NULL,
  quantity NUMERIC(10,2) NOT NULL CHECK (quantity > 0),
  unit_cost NUMERIC(10,2) NOT NULL DEFAULT 0,
  qty_in_pack INTEGER NOT NULL DEFAULT 1,
  line_total NUMERIC(10,2) GENERATED ALWAYS AS (quantity * unit_cost) STORED,
  CONSTRAINT po_item_has_target CHECK (product_id IS NOT NULL OR ingredient_id IS NOT NULL)
);

ALTER TABLE purchase_order_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "purchase_order_items_read" ON purchase_order_items;
CREATE POLICY "purchase_order_items_read" ON purchase_order_items
  FOR SELECT USING (
    po_id IN (SELECT id FROM purchase_orders WHERE org_id IN (SELECT current_user_org_ids()))
  );

DROP POLICY IF EXISTS "purchase_order_items_insert" ON purchase_order_items;
CREATE POLICY "purchase_order_items_insert" ON purchase_order_items
  FOR INSERT WITH CHECK (
    po_id IN (SELECT id FROM purchase_orders WHERE org_id IN (SELECT current_user_org_ids()))
  );

DROP POLICY IF EXISTS "purchase_order_items_delete" ON purchase_order_items;
CREATE POLICY "purchase_order_items_delete" ON purchase_order_items
  FOR DELETE USING (
    po_id IN (SELECT id FROM purchase_orders WHERE org_id IN (SELECT current_user_org_ids()))
  );

CREATE INDEX IF NOT EXISTS idx_po_items_po ON purchase_order_items (po_id);


-- ============================================================
-- STATEMENT 3: stock_receipts.po_id -- links a logged delivery back to
-- the PO it was received against (nullable: most receipts have no PO,
-- exactly like today).
--
-- ON DELETE SET NULL, not CASCADE: deleting a PO must not delete the
-- record that goods were actually received -- same reasoning as 059's
-- stock_receipts.location_id.
-- ============================================================

ALTER TABLE stock_receipts
  ADD COLUMN IF NOT EXISTS po_id UUID REFERENCES purchase_orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_stock_receipts_po ON stock_receipts (po_id);


-- ============================================================
-- VERIFY (run after all three statements):
--
-- SELECT 'table: ' || table_name FROM information_schema.tables
--  WHERE table_name IN ('purchase_orders', 'purchase_order_items')
-- UNION ALL
-- SELECT 'column: stock_receipts.po_id (' || data_type || ')'
--  FROM information_schema.columns
--  WHERE table_name = 'stock_receipts' AND column_name = 'po_id';
-- ============================================================
