-- ============================================================
-- Migration 029: WMS Cycle Count Support
--
-- Adds cycle counting fields to wms_catalog so items can be
-- counted on a rotating schedule by ABC class / frequency.
-- Also adds a trigger to update last_counted_at when the
-- apply_wms_stock_count RPC runs.
-- ============================================================

BEGIN;

-- 1. Add cycle count columns to wms_catalog
ALTER TABLE wms_catalog
  ADD COLUMN abc_class TEXT NOT NULL DEFAULT 'C'
    CHECK (abc_class IN ('A', 'B', 'C')),
  ADD COLUMN count_frequency_days INT NOT NULL DEFAULT 30,
  ADD COLUMN last_counted_at TIMESTAMPTZ;

COMMENT ON COLUMN wms_catalog.abc_class IS
  'ABC classification: A = high-value/fast-moving (count weekly), B = medium (count bi-weekly), C = low (count monthly)';
COMMENT ON COLUMN wms_catalog.count_frequency_days IS
  'How often this item should be cycle-counted, in days. Defaults: A=7, B=14, C=30';
COMMENT ON COLUMN wms_catalog.last_counted_at IS
  'Timestamp of the last completed stock count for this item';

-- 2. Index for overdue queries
CREATE INDEX idx_wms_catalog_cycle ON wms_catalog(org_id, abc_class, last_counted_at);

-- 3. Replace apply_wms_stock_count to also update last_counted_at
CREATE OR REPLACE FUNCTION apply_wms_stock_count(
  p_session_id UUID
)
RETURNS INT
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
    -- Update inventory quantity
    UPDATE wms_inventory
    SET physical_qty = r.counted_qty,
        updated_at = NOW()
    WHERE wms_item_id = r.wms_item_id
      AND org_id = r.org_id;

    -- Mark catalog item as counted
    UPDATE wms_catalog
    SET last_counted_at = NOW()
    WHERE id = r.wms_item_id
      AND org_id = r.org_id;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

-- 4. Helper view: items due for counting
-- An item is "overdue" when last_counted_at is NULL or
-- older than count_frequency_days ago.
CREATE OR REPLACE VIEW wms_cycle_count_due AS
SELECT
  c.id,
  c.org_id,
  c.sku,
  c.item_name,
  c.category,
  c.abc_class,
  c.count_frequency_days,
  c.last_counted_at,
  i.physical_qty,
  CASE
    WHEN c.last_counted_at IS NULL THEN TRUE
    WHEN c.last_counted_at < NOW() - (c.count_frequency_days || ' days')::INTERVAL THEN TRUE
    ELSE FALSE
  END AS is_overdue,
  CASE
    WHEN c.last_counted_at IS NULL THEN NULL
    ELSE (c.last_counted_at + (c.count_frequency_days || ' days')::INTERVAL)::DATE
  END AS next_count_due
FROM wms_catalog c
LEFT JOIN wms_inventory i ON i.wms_item_id = c.id AND i.org_id = c.org_id;

COMMIT;
