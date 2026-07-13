-- ============================================================
-- Migration 045: Auto-create WMS inventory rows; make receive upsert
--
-- Closes the last "silent stock loss" gap. Previously a wms_catalog item and
-- its wms_inventory row were created as two separate client inserts, so a
-- partial failure orphaned the catalog item — and any later UPDATE-only write
-- against a missing inventory row no-opped, recording cost/receipts while
-- physical_qty never moved.
--
--   1. A trigger creates the wms_inventory row (defaults) inside the same
--      transaction as the wms_catalog insert, so an orphan can no longer
--      exist. Idempotent (ON CONFLICT DO NOTHING).
--   2. receive_wms_stock (the standalone Receive page RPC, last touched in
--      040) is switched from UPDATE-only to INSERT ... ON CONFLICT, matching
--      the upsert used by 044's record_wms_adjustment / receive_wms_purchase_order
--      and self-healing any pre-existing orphan.
--
-- The client create paths (catalog form + CSV import) no longer insert the
-- inventory row themselves; they update the trigger-created row's reorder
-- levels instead. See src/app/(wms)/warehouse/page.tsx and
-- src/components/wms/csv-catalog-upload.tsx.
--
-- After applying by hand, record it:
--   node node_modules/supabase/dist/supabase.js migration repair --status applied 045
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Auto-create the inventory row when a catalog item is added.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_wms_inventory_row()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO wms_inventory (org_id, wms_item_id, physical_qty)
  VALUES (NEW.org_id, NEW.id, 0)
  ON CONFLICT (org_id, wms_item_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wms_catalog_inventory ON wms_catalog;
CREATE TRIGGER trg_wms_catalog_inventory
  AFTER INSERT ON wms_catalog
  FOR EACH ROW EXECUTE FUNCTION create_wms_inventory_row();

-- Backfill any catalog item that is currently missing an inventory row.
INSERT INTO wms_inventory (org_id, wms_item_id, physical_qty)
SELECT c.org_id, c.id, 0
FROM wms_catalog c
LEFT JOIN wms_inventory i ON i.org_id = c.org_id AND i.wms_item_id = c.id
WHERE i.id IS NULL
ON CONFLICT (org_id, wms_item_id) DO NOTHING;

-- ------------------------------------------------------------
-- 2. receive_wms_stock — identical to 040 except the inventory write is now
--    an upsert, so a receipt can never be recorded without moving stock.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION receive_wms_stock(
  p_supplier     TEXT,
  p_notes        TEXT,
  p_recorded_by  TEXT,
  p_wms_item_ids INTEGER[],
  p_packs        INTEGER[],
  p_pack_sizes   INTEGER[],
  p_unit_costs   NUMERIC[]
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_receipt_id  INTEGER;
  v_total_cost  NUMERIC := 0;
  v_i           INTEGER;
  v_total_units INTEGER;
  v_line_total  NUMERIC;
  v_org_id      UUID;
  v_orgs        INT;
  v_found       INT;
BEGIN
  IF array_length(p_wms_item_ids, 1) IS NULL OR array_length(p_wms_item_ids, 1) = 0 THEN
    RAISE EXCEPTION 'At least one line item is required';
  END IF;
  IF array_length(p_wms_item_ids, 1) <> array_length(p_packs, 1)
     OR array_length(p_wms_item_ids, 1) <> array_length(p_pack_sizes, 1)
     OR array_length(p_wms_item_ids, 1) <> array_length(p_unit_costs, 1) THEN
    RAISE EXCEPTION 'All arrays must have the same length';
  END IF;

  SELECT COUNT(DISTINCT org_id), COUNT(DISTINCT id)
    INTO v_orgs, v_found
    FROM wms_catalog
   WHERE id = ANY(p_wms_item_ids::BIGINT[]);

  IF v_found <> (SELECT COUNT(DISTINCT x) FROM unnest(p_wms_item_ids) AS x) THEN
    RAISE EXCEPTION 'One or more warehouse items do not exist' USING ERRCODE = '42501';
  END IF;
  IF v_orgs <> 1 THEN
    RAISE EXCEPTION 'Line items span more than one organisation' USING ERRCODE = '42501';
  END IF;

  SELECT org_id INTO v_org_id
    FROM wms_catalog
   WHERE id = ANY(p_wms_item_ids::BIGINT[])
   LIMIT 1;

  PERFORM assert_org_writable(v_org_id);

  FOR v_i IN 1..array_length(p_wms_item_ids, 1) LOOP
    v_total_cost := v_total_cost + (p_packs[v_i] * p_pack_sizes[v_i] * p_unit_costs[v_i]);
  END LOOP;

  INSERT INTO wms_receipts (org_id, receipt_date, supplier, notes, total_cost, recorded_by)
  VALUES (v_org_id, CURRENT_DATE, NULLIF(TRIM(p_supplier), ''), NULLIF(TRIM(p_notes), ''),
          v_total_cost, p_recorded_by)
  RETURNING id INTO v_receipt_id;

  FOR v_i IN 1..array_length(p_wms_item_ids, 1) LOOP
    v_total_units := p_packs[v_i] * p_pack_sizes[v_i];
    v_line_total  := v_total_units * p_unit_costs[v_i];

    INSERT INTO wms_receipt_items (
      org_id, receipt_id, wms_item_id, packs, pack_size, total_units, unit_cost, line_total
    ) VALUES (
      v_org_id, v_receipt_id, p_wms_item_ids[v_i], p_packs[v_i], p_pack_sizes[v_i],
      v_total_units, p_unit_costs[v_i], v_line_total
    );

    -- Upsert so a missing inventory row can't swallow the receipt.
    INSERT INTO wms_inventory (org_id, wms_item_id, physical_qty)
    VALUES (v_org_id, p_wms_item_ids[v_i], v_total_units)
    ON CONFLICT (org_id, wms_item_id) DO UPDATE
    SET physical_qty = wms_inventory.physical_qty + EXCLUDED.physical_qty,
        updated_at = NOW();
  END LOOP;

  RETURN v_receipt_id;
END;
$$;

-- receive_wms_stock keeps its 040 grants (authenticated only); CREATE OR
-- REPLACE preserves the existing ACL, so no re-grant is required.

COMMIT;

-- ============================================================
-- VERIFY (run separately, after commit)
--
-- 1. Every catalog item has exactly one inventory row (expect zero):
--   SELECT c.id FROM wms_catalog c
--   LEFT JOIN wms_inventory i ON i.org_id = c.org_id AND i.wms_item_id = c.id
--   WHERE i.id IS NULL;
--
-- 2. Trigger exists:
--   SELECT tgname FROM pg_trigger WHERE tgname = 'trg_wms_catalog_inventory';
--
-- 3. As an admin: add a catalog item -> an inventory row appears immediately;
--    receive stock for a brand-new item -> physical_qty rises (no silent loss).
-- ============================================================
