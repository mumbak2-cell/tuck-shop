-- ============================================================
-- Migration 044: Atomic WMS write RPCs for adjustments and PO receiving
--
-- The warehouse adjustment and PO-receive pages did their writes as several
-- separate, non-transactional client calls with read-modify-write on
-- wms_inventory. That meant:
--   - a mid-sequence failure left a partial write (audit row or receipt with
--     no matching stock movement, or vice versa);
--   - concurrent writes / stale client snapshots clobbered each other;
--   - the writes went straight to the tables, bypassing assert_org_writable,
--     so a lapsed-subscription org could still mutate warehouse stock;
--   - an item with no wms_inventory row silently lost the movement.
--
-- These two SECURITY DEFINER RPCs replace those flows. Each derives the org
-- from server-side data (never a caller-supplied org), enforces the single
-- authorization + subscription gate, upserts inventory so a missing row can
-- never swallow stock, and commits everything in one transaction.
--
-- Grants follow the 040 pattern: EXECUTE to `authenticated` only.
--
-- After applying by hand, record it:
--   node node_modules/supabase/dist/supabase.js migration repair --status applied 044
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. record_wms_adjustment — log a breakage/theft/expiry/correction AND
--    move inventory, atomically. Org derived from the catalog item.
--
--    Inventory is clamped at 0 (matches the prior GREATEST semantics and the
--    044-era wms_inventory_qty_nonneg CHECK); the audit row always records the
--    requested adjustment_qty exactly as entered.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_wms_adjustment(
  p_wms_item_id   BIGINT,
  p_adjustment_qty INT,     -- positive to add, negative to remove
  p_reason        TEXT,
  p_notes         TEXT DEFAULT NULL,
  p_recorded_by   TEXT DEFAULT NULL
)
RETURNS INT  -- new physical_qty
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id  UUID;
  v_new_qty INT;
BEGIN
  IF p_adjustment_qty IS NULL OR p_adjustment_qty = 0 THEN
    RAISE EXCEPTION 'Adjustment quantity must be non-zero' USING ERRCODE = '22023';
  END IF;
  IF p_reason NOT IN ('Breakage', 'Expired', 'Theft', 'Correction', 'Other') THEN
    RAISE EXCEPTION 'Invalid adjustment reason: %', p_reason USING ERRCODE = '22023';
  END IF;

  SELECT org_id INTO v_org_id FROM wms_catalog WHERE id = p_wms_item_id;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Warehouse item % not found', p_wms_item_id USING ERRCODE = '42501';
  END IF;

  PERFORM assert_org_writable(v_org_id);

  INSERT INTO wms_adjustments (
    org_id, adjustment_date, wms_item_id, reason, adjustment_qty, notes, recorded_by
  ) VALUES (
    v_org_id, CURRENT_DATE, p_wms_item_id, p_reason, p_adjustment_qty,
    NULLIF(TRIM(p_notes), ''), p_recorded_by
  );

  -- Upsert so a missing inventory row can't silently swallow the movement.
  INSERT INTO wms_inventory (org_id, wms_item_id, physical_qty)
  VALUES (v_org_id, p_wms_item_id, GREATEST(p_adjustment_qty, 0))
  ON CONFLICT (org_id, wms_item_id) DO UPDATE
  SET physical_qty = GREATEST(wms_inventory.physical_qty + p_adjustment_qty, 0),
      updated_at = NOW()
  RETURNING physical_qty INTO v_new_qty;

  RETURN v_new_qty;
END;
$$;

-- ------------------------------------------------------------
-- 2. receive_wms_purchase_order — receive against an open PO in one
--    transaction: receipt header, receipt lines, inventory, qty_received,
--    and the PO status roll-up. Org derived from the PO; unit cost read
--    server-side from wms_po_items (never trusted from the client). Each
--    line is clamped to the outstanding quantity so a PO can't be
--    over-received.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION receive_wms_purchase_order(
  p_po_id       BIGINT,
  p_po_item_ids BIGINT[],
  p_qtys        INTEGER[],
  p_recorded_by TEXT DEFAULT NULL
)
RETURNS BIGINT  -- new receipt id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id     UUID;
  v_po_number  TEXT;
  v_supplier   TEXT;
  v_status     TEXT;
  v_receipt_id BIGINT;
  v_total      NUMERIC := 0;
  v_lines      INT := 0;
  v_remaining  INT;
  v_i          INT;
  v_item_id    BIGINT;
  v_qty        INT;
  v_wms_item   BIGINT;
  v_unit_cost  NUMERIC;
  v_ordered    INT;
  v_received   INT;
  v_receivable INT;
BEGIN
  IF array_length(p_po_item_ids, 1) IS NULL OR array_length(p_po_item_ids, 1) = 0 THEN
    RAISE EXCEPTION 'At least one line item is required' USING ERRCODE = '22023';
  END IF;
  IF array_length(p_po_item_ids, 1) <> array_length(p_qtys, 1) THEN
    RAISE EXCEPTION 'Item and quantity arrays must be the same length' USING ERRCODE = '22023';
  END IF;

  SELECT org_id, po_number, supplier, status
    INTO v_org_id, v_po_number, v_supplier, v_status
    FROM wms_purchase_orders
   WHERE id = p_po_id;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Purchase order not found' USING ERRCODE = '42501';
  END IF;

  PERFORM assert_org_writable(v_org_id);

  IF v_status NOT IN ('Sent', 'Partially Received') THEN
    RAISE EXCEPTION 'Purchase order % cannot be received in status %', v_po_number, v_status
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO wms_receipts (org_id, receipt_date, supplier, notes, total_cost, recorded_by)
  VALUES (v_org_id, CURRENT_DATE, v_supplier, 'Received against ' || v_po_number, 0, p_recorded_by)
  RETURNING id INTO v_receipt_id;

  FOR v_i IN 1..array_length(p_po_item_ids, 1) LOOP
    v_item_id := p_po_item_ids[v_i];
    v_qty     := p_qtys[v_i];
    IF v_qty IS NULL OR v_qty <= 0 THEN
      CONTINUE;
    END IF;

    SELECT wms_item_id, unit_cost, qty_ordered, qty_received
      INTO v_wms_item, v_unit_cost, v_ordered, v_received
      FROM wms_po_items
     WHERE id = v_item_id AND po_id = p_po_id AND org_id = v_org_id
     FOR UPDATE;
    IF v_wms_item IS NULL THEN
      RAISE EXCEPTION 'Line item % is not part of purchase order %', v_item_id, v_po_number
        USING ERRCODE = '42501';
    END IF;

    -- Never receive more than what is still outstanding.
    v_receivable := v_ordered - v_received;
    IF v_receivable <= 0 THEN
      CONTINUE;
    END IF;
    IF v_qty > v_receivable THEN
      v_qty := v_receivable;
    END IF;

    INSERT INTO wms_receipt_items (
      org_id, receipt_id, wms_item_id, packs, pack_size, total_units, unit_cost, line_total
    ) VALUES (
      v_org_id, v_receipt_id, v_wms_item, v_qty, 1, v_qty, v_unit_cost, v_qty * v_unit_cost
    );

    -- Upsert so a missing inventory row can't silently swallow the receipt.
    INSERT INTO wms_inventory (org_id, wms_item_id, physical_qty)
    VALUES (v_org_id, v_wms_item, v_qty)
    ON CONFLICT (org_id, wms_item_id) DO UPDATE
    SET physical_qty = wms_inventory.physical_qty + EXCLUDED.physical_qty,
        updated_at = NOW();

    UPDATE wms_po_items
       SET qty_received = qty_received + v_qty
     WHERE id = v_item_id;

    v_total := v_total + (v_qty * v_unit_cost);
    v_lines := v_lines + 1;
  END LOOP;

  IF v_lines = 0 THEN
    RAISE EXCEPTION 'Nothing to receive — every line is already fully received' USING ERRCODE = '22023';
  END IF;

  UPDATE wms_receipts SET total_cost = v_total WHERE id = v_receipt_id;

  -- Roll up PO status from the outstanding lines.
  SELECT COUNT(*) INTO v_remaining
    FROM wms_po_items
   WHERE po_id = p_po_id AND qty_received < qty_ordered;

  UPDATE wms_purchase_orders
     SET status = CASE WHEN v_remaining = 0 THEN 'Received' ELSE 'Partially Received' END,
         updated_at = NOW()
   WHERE id = p_po_id;

  RETURN v_receipt_id;
END;
$$;

-- ------------------------------------------------------------
-- 3. Grant hygiene.
-- ------------------------------------------------------------
REVOKE ALL    ON FUNCTION record_wms_adjustment(BIGINT, INT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_wms_adjustment(BIGINT, INT, TEXT, TEXT, TEXT) TO authenticated;

REVOKE ALL    ON FUNCTION receive_wms_purchase_order(BIGINT, BIGINT[], INTEGER[], TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION receive_wms_purchase_order(BIGINT, BIGINT[], INTEGER[], TEXT) TO authenticated;

COMMIT;

-- ============================================================
-- VERIFY (run separately, after commit)
--
-- 1. Neither RPC is PUBLIC/anon-executable:
--   SELECT p.proname, coalesce(array_to_string(p.proacl, ', '), 'DEFAULT (PUBLIC!)') AS acl
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public'
--     AND p.proname IN ('record_wms_adjustment','receive_wms_purchase_order');
--   -- each acl must mention authenticated=X and NOT start with =X/ (PUBLIC).
--
-- 2. As an admin on a writable org:
--    a. record a -5 Breakage adjustment -> wms_adjustments row written and
--       physical_qty dropped by 5 (never below 0), returned value matches.
--    b. receive part of an open PO -> one receipt + lines, inventory rose,
--       qty_received rose, status = 'Partially Received'; receive the rest ->
--       status = 'Received'. A second receive attempt raises 'Nothing to
--       receive'.
-- ============================================================
