-- ============================================================
-- Migration 030: WMS Purchase Orders
--
-- Adds a formal purchase order workflow so reorder alerts can
-- be converted into tracked POs. POs flow through statuses:
--   Draft → Sent → Partially Received → Received → Cancelled
--
-- A PO can be "received" which creates a wms_receipt and
-- increments inventory via the existing receive_wms_stock RPC.
-- ============================================================

BEGIN;

-- Purchase Order headers
CREATE TABLE wms_purchase_orders (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  po_number     TEXT NOT NULL,
  supplier      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'Draft'
    CHECK (status IN ('Draft', 'Sent', 'Partially Received', 'Received', 'Cancelled')),
  notes         TEXT,
  expected_date DATE,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, po_number)
);

CREATE INDEX idx_wms_po_org ON wms_purchase_orders(org_id);
CREATE INDEX idx_wms_po_status ON wms_purchase_orders(status);

ALTER TABLE wms_purchase_orders ALTER COLUMN org_id SET DEFAULT default_user_org_id();

ALTER TABLE wms_purchase_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON wms_purchase_orders FOR ALL
  USING (org_id IN (SELECT current_user_org_ids()))
  WITH CHECK (org_id IN (SELECT current_user_org_ids()));

-- Purchase Order line items
CREATE TABLE wms_po_items (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  po_id         BIGINT NOT NULL REFERENCES wms_purchase_orders(id) ON DELETE CASCADE,
  wms_item_id   BIGINT NOT NULL REFERENCES wms_catalog(id) ON DELETE CASCADE,
  qty_ordered   INT NOT NULL CHECK (qty_ordered > 0),
  qty_received  INT NOT NULL DEFAULT 0,
  unit_cost     NUMERIC(12,2) NOT NULL DEFAULT 0,
  line_total    NUMERIC(12,2) GENERATED ALWAYS AS (qty_ordered * unit_cost) STORED
);

CREATE INDEX idx_wms_po_items_po ON wms_po_items(po_id);
CREATE INDEX idx_wms_po_items_org ON wms_po_items(org_id);

ALTER TABLE wms_po_items ALTER COLUMN org_id SET DEFAULT default_user_org_id();

ALTER TABLE wms_po_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON wms_po_items FOR ALL
  USING (org_id IN (SELECT current_user_org_ids()))
  WITH CHECK (org_id IN (SELECT current_user_org_ids()));

COMMIT;
