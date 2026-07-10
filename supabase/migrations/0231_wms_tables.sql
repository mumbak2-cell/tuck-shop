-- ============================================================
-- Migration 0231: Warehouse Management System (WMS) Module
--
-- Creates the independent WMS layer:
--   - wms_catalog: master item catalog (independent of retail products)
--   - wms_inventory: stock levels with reorder thresholds
--   - wms_dispatches: outward dispatch headers
--   - wms_dispatch_items: dispatch line items
--
-- All tables are multi-tenant (org_id) with RLS policies using
-- current_user_org_ids(). The process_tilify_dispatch RPC handles
-- the POS integration when dispatching to an internal shop.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. WMS Tables
-- ============================================================

-- Master WMS Catalog (independent of retail products table)
CREATE TABLE wms_catalog (
  id         BIGSERIAL PRIMARY KEY,
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sku        TEXT NOT NULL,
  item_name  TEXT NOT NULL,
  category   TEXT,
  pack_size  INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, sku)
);

CREATE INDEX idx_wms_catalog_org ON wms_catalog(org_id);

-- Warehouse Stock Tracking (one row per catalog item)
CREATE TABLE wms_inventory (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  wms_item_id   BIGINT NOT NULL REFERENCES wms_catalog(id) ON DELETE CASCADE,
  physical_qty  INT NOT NULL DEFAULT 0,
  reorder_level INT NOT NULL DEFAULT 10,
  reorder_qty   INT NOT NULL DEFAULT 50,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, wms_item_id)
);

CREATE INDEX idx_wms_inventory_org ON wms_inventory(org_id);
CREATE INDEX idx_wms_inventory_item ON wms_inventory(wms_item_id);

-- Warehouse Dispatches (header)
CREATE TABLE wms_dispatches (
  id               BIGSERIAL PRIMARY KEY,
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  destination_type TEXT NOT NULL CHECK (destination_type IN ('Internal Shop', 'External Client', 'Wholesale')),
  destination_id   TEXT NOT NULL,     -- shop identifier, client name, or wholesale customer
  status           TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Dispatched', 'Received')),
  notes            TEXT,
  created_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_wms_dispatches_org ON wms_dispatches(org_id);
CREATE INDEX idx_wms_dispatches_status ON wms_dispatches(status);

-- Dispatch Line Items
CREATE TABLE wms_dispatch_items (
  id          BIGSERIAL PRIMARY KEY,
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  dispatch_id BIGINT NOT NULL REFERENCES wms_dispatches(id) ON DELETE CASCADE,
  wms_item_id BIGINT NOT NULL REFERENCES wms_catalog(id) ON DELETE CASCADE,
  qty_sent    INT NOT NULL CHECK (qty_sent > 0)
);

CREATE INDEX idx_wms_dispatch_items_dispatch ON wms_dispatch_items(dispatch_id);
CREATE INDEX idx_wms_dispatch_items_org ON wms_dispatch_items(org_id);

-- Warehouse Receipts (audit trail for supplier deliveries)
CREATE TABLE wms_receipts (
  id          BIGSERIAL PRIMARY KEY,
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  receipt_date DATE NOT NULL DEFAULT CURRENT_DATE,
  supplier    TEXT,
  notes       TEXT,
  total_cost  NUMERIC(12,2) NOT NULL DEFAULT 0,
  recorded_by TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_wms_receipts_org ON wms_receipts(org_id);

-- Receipt Line Items
CREATE TABLE wms_receipt_items (
  id          BIGSERIAL PRIMARY KEY,
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  receipt_id  BIGINT NOT NULL REFERENCES wms_receipts(id) ON DELETE CASCADE,
  wms_item_id BIGINT NOT NULL REFERENCES wms_catalog(id) ON DELETE CASCADE,
  packs       INT NOT NULL DEFAULT 1,
  pack_size   INT NOT NULL DEFAULT 1,
  total_units INT NOT NULL,
  unit_cost   NUMERIC(12,2) NOT NULL DEFAULT 0,
  line_total  NUMERIC(12,2) NOT NULL DEFAULT 0
);

CREATE INDEX idx_wms_receipt_items_receipt ON wms_receipt_items(receipt_id);
CREATE INDEX idx_wms_receipt_items_org ON wms_receipt_items(org_id);

-- Warehouse Stock Adjustments (breakage, theft, expired, corrections)
CREATE TABLE wms_adjustments (
  id              BIGSERIAL PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  adjustment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  wms_item_id     BIGINT NOT NULL REFERENCES wms_catalog(id) ON DELETE CASCADE,
  reason          TEXT NOT NULL CHECK (reason IN ('Breakage', 'Expired', 'Theft', 'Correction', 'Other')),
  adjustment_qty  INT NOT NULL,    -- positive = add, negative = remove
  notes           TEXT,
  recorded_by     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_wms_adjustments_org ON wms_adjustments(org_id);
CREATE INDEX idx_wms_adjustments_item ON wms_adjustments(wms_item_id);

-- ============================================================
-- 1b. Auto-populate org_id on INSERT (same pattern as migration 017)
-- ============================================================

ALTER TABLE wms_catalog ALTER COLUMN org_id SET DEFAULT default_user_org_id();
ALTER TABLE wms_inventory ALTER COLUMN org_id SET DEFAULT default_user_org_id();
ALTER TABLE wms_dispatches ALTER COLUMN org_id SET DEFAULT default_user_org_id();
ALTER TABLE wms_dispatch_items ALTER COLUMN org_id SET DEFAULT default_user_org_id();
ALTER TABLE wms_receipts ALTER COLUMN org_id SET DEFAULT default_user_org_id();
ALTER TABLE wms_receipt_items ALTER COLUMN org_id SET DEFAULT default_user_org_id();
ALTER TABLE wms_adjustments ALTER COLUMN org_id SET DEFAULT default_user_org_id();

-- ============================================================
-- 2. RLS Policies (org-scoped via current_user_org_ids)
-- ============================================================

ALTER TABLE wms_catalog ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON wms_catalog FOR ALL
  USING (org_id IN (SELECT current_user_org_ids()))
  WITH CHECK (org_id IN (SELECT current_user_org_ids()));

ALTER TABLE wms_inventory ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON wms_inventory FOR ALL
  USING (org_id IN (SELECT current_user_org_ids()))
  WITH CHECK (org_id IN (SELECT current_user_org_ids()));

ALTER TABLE wms_dispatches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON wms_dispatches FOR ALL
  USING (org_id IN (SELECT current_user_org_ids()))
  WITH CHECK (org_id IN (SELECT current_user_org_ids()));

ALTER TABLE wms_dispatch_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON wms_dispatch_items FOR ALL
  USING (org_id IN (SELECT current_user_org_ids()))
  WITH CHECK (org_id IN (SELECT current_user_org_ids()));

ALTER TABLE wms_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON wms_receipts FOR ALL
  USING (org_id IN (SELECT current_user_org_ids()))
  WITH CHECK (org_id IN (SELECT current_user_org_ids()));

ALTER TABLE wms_receipt_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON wms_receipt_items FOR ALL
  USING (org_id IN (SELECT current_user_org_ids()))
  WITH CHECK (org_id IN (SELECT current_user_org_ids()));

ALTER TABLE wms_adjustments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON wms_adjustments FOR ALL
  USING (org_id IN (SELECT current_user_org_ids()))
  WITH CHECK (org_id IN (SELECT current_user_org_ids()));

-- ============================================================
-- 3. RPCs
-- ============================================================

-- 3a. Receive WMS Stock (bulk supplier receipt)
-- Accepts JSON array of {wms_item_id, qty} and increments physical_qty.
CREATE OR REPLACE FUNCTION receive_wms_stock(
  p_org_id    UUID,
  p_items     JSONB   -- array of {"wms_item_id": bigint, "qty": int}
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  item JSONB;
BEGIN
  FOR item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    UPDATE wms_inventory
    SET physical_qty = physical_qty + (item->>'qty')::int,
        updated_at = NOW()
    WHERE org_id = p_org_id
      AND wms_item_id = (item->>'wms_item_id')::bigint;
  END LOOP;
END;
$$;

-- 3b. Adjust WMS Inventory (corrections, breakage, theft)
CREATE OR REPLACE FUNCTION adjust_wms_inventory(
  p_org_id      UUID,
  p_wms_item_id BIGINT,
  p_adjustment  INT,      -- positive to add, negative to remove
  p_reason      TEXT
)
RETURNS INT  -- returns new physical_qty
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_qty INT;
BEGIN
  UPDATE wms_inventory
  SET physical_qty = GREATEST(physical_qty + p_adjustment, 0),
      updated_at = NOW()
  WHERE org_id = p_org_id
    AND wms_item_id = p_wms_item_id
  RETURNING physical_qty INTO v_new_qty;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WMS inventory row not found for item % in org %', p_wms_item_id, p_org_id;
  END IF;

  RETURN v_new_qty;
END;
$$;

-- 3c. Process Tilify Dispatch (WMS → POS integration)
-- Deducts warehouse stock, logs the dispatch, and increments
-- the retail products.opening_stock by matching wms_catalog.sku
-- to products.inventory_id within the same org.
CREATE OR REPLACE FUNCTION process_tilify_dispatch(
  p_org_id         UUID,
  p_destination_id TEXT,
  p_items          JSONB,   -- array of {"wms_item_id": bigint, "qty": int}
  p_notes          TEXT DEFAULT NULL,
  p_created_by     TEXT DEFAULT NULL
)
RETURNS BIGINT  -- returns the new dispatch ID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dispatch_id  BIGINT;
  item           JSONB;
  v_current_qty  INT;
  v_qty          INT;
  v_sku          TEXT;
BEGIN
  -- Create dispatch header
  INSERT INTO wms_dispatches (org_id, destination_type, destination_id, status, notes, created_by)
  VALUES (p_org_id, 'Internal Shop', p_destination_id, 'Dispatched', p_notes, p_created_by)
  RETURNING id INTO v_dispatch_id;

  -- Process each line item
  FOR item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_qty := (item->>'qty')::int;

    -- 1. Verify sufficient warehouse stock
    SELECT physical_qty INTO v_current_qty
    FROM wms_inventory
    WHERE org_id = p_org_id
      AND wms_item_id = (item->>'wms_item_id')::bigint
    FOR UPDATE;

    IF v_current_qty IS NULL THEN
      RAISE EXCEPTION 'WMS inventory row not found for item %', (item->>'wms_item_id');
    END IF;

    IF v_current_qty < v_qty THEN
      RAISE EXCEPTION 'Insufficient warehouse stock for item %. Available: %, Requested: %',
        (item->>'wms_item_id'), v_current_qty, v_qty;
    END IF;

    -- 2. Deduct from WMS inventory
    UPDATE wms_inventory
    SET physical_qty = physical_qty - v_qty,
        updated_at = NOW()
    WHERE org_id = p_org_id
      AND wms_item_id = (item->>'wms_item_id')::bigint;

    -- 3. Log dispatch line item
    INSERT INTO wms_dispatch_items (org_id, dispatch_id, wms_item_id, qty_sent)
    VALUES (p_org_id, v_dispatch_id, (item->>'wms_item_id')::bigint, v_qty);

    -- 4. Find matching retail product by SKU (wms_catalog.sku = products.inventory_id)
    SELECT sku INTO v_sku
    FROM wms_catalog
    WHERE id = (item->>'wms_item_id')::bigint
      AND org_id = p_org_id;

    -- 5. Increment retail stock if a matching product exists
    IF v_sku IS NOT NULL THEN
      UPDATE products
      SET opening_stock = opening_stock + v_qty
      WHERE org_id = p_org_id
        AND inventory_id = v_sku;
    END IF;
  END LOOP;

  RETURN v_dispatch_id;
END;
$$;

COMMIT;
