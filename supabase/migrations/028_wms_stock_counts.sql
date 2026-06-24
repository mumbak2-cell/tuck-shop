-- ============================================================
-- Migration 028: WMS Stock Count Sessions
--
-- Adds periodic physical count capability to the warehouse.
-- Mirrors the retail stock_counts pattern with session-based
-- counting so multiple counts per day are supported (opening,
-- closing, spot-check).
-- ============================================================

BEGIN;

-- WMS Stock Counts (one row per item per session)
CREATE TABLE wms_stock_counts (
  id              BIGSERIAL PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  session_id      UUID NOT NULL,
  session_label   TEXT NOT NULL DEFAULT 'Stock Count',
  count_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  wms_item_id     BIGINT NOT NULL REFERENCES wms_catalog(id) ON DELETE CASCADE,
  system_qty      INT NOT NULL DEFAULT 0,       -- wms_inventory.physical_qty at count time
  counted_qty     INT NOT NULL DEFAULT 0,       -- physical count entered by user
  variance        INT GENERATED ALWAYS AS (counted_qty - system_qty) STORED,
  counted_by      TEXT,
  counted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  update_count    INT NOT NULL DEFAULT 1,
  UNIQUE (session_id, wms_item_id)
);

CREATE INDEX idx_wms_stock_counts_org ON wms_stock_counts(org_id);
CREATE INDEX idx_wms_stock_counts_session ON wms_stock_counts(session_id);
CREATE INDEX idx_wms_stock_counts_date ON wms_stock_counts(count_date);

-- Auto org_id
ALTER TABLE wms_stock_counts ALTER COLUMN org_id SET DEFAULT default_user_org_id();

-- RLS
ALTER TABLE wms_stock_counts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON wms_stock_counts FOR ALL
  USING (org_id IN (SELECT current_user_org_ids()))
  WITH CHECK (org_id IN (SELECT current_user_org_ids()));

-- WMS Stock Count Audit (tracks edits to counts)
CREATE TABLE wms_stock_count_audit (
  id                BIGSERIAL PRIMARY KEY,
  org_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stock_count_id    BIGINT NOT NULL REFERENCES wms_stock_counts(id) ON DELETE CASCADE,
  wms_item_id       BIGINT NOT NULL REFERENCES wms_catalog(id) ON DELETE CASCADE,
  count_date        DATE NOT NULL,
  counted_qty_old   INT NOT NULL,
  counted_qty_new   INT NOT NULL,
  changed_by        TEXT,
  changed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_wms_sc_audit_org ON wms_stock_count_audit(org_id);
CREATE INDEX idx_wms_sc_audit_count ON wms_stock_count_audit(stock_count_id);

ALTER TABLE wms_stock_count_audit ALTER COLUMN org_id SET DEFAULT default_user_org_id();

ALTER TABLE wms_stock_count_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON wms_stock_count_audit FOR ALL
  USING (org_id IN (SELECT current_user_org_ids()))
  WITH CHECK (org_id IN (SELECT current_user_org_ids()));

-- Optional: RPC to apply count results to wms_inventory
-- Sets physical_qty = counted_qty for all items in a given session.
CREATE OR REPLACE FUNCTION apply_wms_stock_count(
  p_session_id UUID
)
RETURNS INT  -- number of items updated
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INT := 0;
  r RECORD;
BEGIN
  FOR r IN
    SELECT wms_item_id, counted_qty, org_id
    FROM wms_stock_counts
    WHERE session_id = p_session_id
  LOOP
    UPDATE wms_inventory
    SET physical_qty = r.counted_qty,
        updated_at = NOW()
    WHERE wms_item_id = r.wms_item_id
      AND org_id = r.org_id;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

COMMIT;
