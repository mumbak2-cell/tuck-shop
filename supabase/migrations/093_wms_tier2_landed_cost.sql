-- ============================================================
-- 093_wms_tier2_landed_cost.sql
--
-- Tier 2 Phase 4 (part 1/3) — landed cost on purchase orders.
--
-- Motivation
-- ----------
-- SADC merchants who import a container of stock pay freight, duty,
-- clearing fees etc. Those costs are landed onto the goods and MUST
-- flow into COGS, or every imported item is silently underpriced.
--
-- Model
-- -----
--   wms_purchase_orders.landed_cost_total   NUMERIC(12,2) nullable
--   wms_purchase_orders.landed_cost_method  TEXT nullable, one of
--       'by_value'  (allocate proportional to qty*unit_cost per line)
--       'by_weight' (allocate proportional to a per-line weight)
--       'by_qty'    (allocate proportional to received units)
--
--   Per-line weight lives on wms_po_items.line_weight NUMERIC(12,4)
--   nullable — merchant enters it manually when using 'by_weight'.
--
-- Allocation timing
--   Landed cost is allocated at receive-time, not at PO create-time,
--   because you often only know the freight bill AFTER goods arrive.
--   Merchant edits landed_cost_total/method on the PO header up until
--   the last receipt. Every receive_wms_purchase_order call re-reads
--   the current header values and allocates to THAT call's lines.
--
-- Effect on cost basis
--   Allocated landed cost per unit is ADDED to the line's unit_cost
--   before the moving-average update. The ledger row records the
--   effective per-unit cost (unit_cost + allocated_landed).
--
-- Idempotent. Safe to re-run. Depends on 088 (avg_cost), 089
-- (moving-avg helper + emit_stock_movement + receive_wms_purchase_order).
--
-- Record with:
--   node node_modules/supabase/dist/supabase.js migration repair \
--     --status applied 093
-- ============================================================

-- ------------------------------------------------------------
-- 1. Schema additions
-- ------------------------------------------------------------
ALTER TABLE wms_purchase_orders
  ADD COLUMN IF NOT EXISTS landed_cost_total  NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS landed_cost_method TEXT
    CHECK (landed_cost_method IS NULL OR landed_cost_method IN ('by_value','by_weight','by_qty'));

ALTER TABLE wms_po_items
  ADD COLUMN IF NOT EXISTS line_weight NUMERIC(12,4);

-- ------------------------------------------------------------
-- 2. Rewrite receive_wms_purchase_order to allocate landed cost.
--
--    Same signature as 090 (BIGINT, BIGINT[], INTEGER[], TEXT, DATE[]).
--    No new client-supplied params — allocation reads header fields
--    the merchant set beforehand.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.receive_wms_purchase_order(BIGINT, BIGINT[], INTEGER[], TEXT, DATE[]);

CREATE OR REPLACE FUNCTION receive_wms_purchase_order(
  p_po_id        BIGINT,
  p_po_item_ids  BIGINT[],
  p_qtys         INTEGER[],
  p_recorded_by  TEXT   DEFAULT NULL,
  p_expiry_dates DATE[] DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id           UUID;
  v_po_number        TEXT;
  v_supplier         TEXT;
  v_status           TEXT;
  v_landed_total     NUMERIC;
  v_landed_method    TEXT;
  v_receipt_id       BIGINT;
  v_total            NUMERIC := 0;
  v_lines            INT := 0;
  v_remaining        INT;
  v_i                INT;
  v_item_id          BIGINT;
  v_qty              INT;
  v_wms_item         BIGINT;
  v_unit_cost        NUMERIC;
  v_ordered          INT;
  v_received         INT;
  v_receivable       INT;
  v_expiry           DATE;
  v_location_id      UUID;
  v_old_qty          INT;
  v_old_avg          NUMERIC;
  v_new_avg          NUMERIC;
  v_line_weight      NUMERIC;
  v_alloc_basis      NUMERIC;      -- per-line basis for landed allocation
  v_alloc_basis_sum  NUMERIC := 0; -- total basis across the receive call
  v_landed_per_unit  NUMERIC;
  v_effective_cost   NUMERIC;
  v_intake           JSONB := '[]'::JSONB;  -- accumulator: per-line data for landed pass
  v_intake_row       JSONB;
BEGIN
  IF array_length(p_po_item_ids, 1) IS NULL OR array_length(p_po_item_ids, 1) = 0 THEN
    RAISE EXCEPTION 'At least one line item is required' USING ERRCODE = '22023';
  END IF;
  IF array_length(p_po_item_ids, 1) <> array_length(p_qtys, 1) THEN
    RAISE EXCEPTION 'Item and quantity arrays must be the same length' USING ERRCODE = '22023';
  END IF;
  IF p_expiry_dates IS NOT NULL AND array_length(p_expiry_dates, 1) <> array_length(p_po_item_ids, 1) THEN
    RAISE EXCEPTION 'p_expiry_dates length must match p_po_item_ids' USING ERRCODE = '22023';
  END IF;

  SELECT org_id, po_number, supplier, status, landed_cost_total, landed_cost_method
    INTO v_org_id, v_po_number, v_supplier, v_status, v_landed_total, v_landed_method
    FROM wms_purchase_orders WHERE id = p_po_id;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Purchase order not found' USING ERRCODE = '42501';
  END IF;

  PERFORM assert_org_writable(v_org_id);

  IF v_status NOT IN ('Sent', 'Partially Received') THEN
    RAISE EXCEPTION 'Purchase order % cannot be received in status %', v_po_number, v_status USING ERRCODE = '22023';
  END IF;

  PERFORM assert_no_active_freeze(v_org_id,
    (SELECT ARRAY_AGG(DISTINCT wms_item_id) FROM wms_po_items WHERE po_id = p_po_id));

  v_location_id := resolve_wms_main_location(v_org_id);

  -- ------------------------------------------------------------
  -- Pass 1: gather this call's line data + accumulate allocation basis.
  --   We compute basis BEFORE writing anything so per-unit landed cost
  --   is known when we do the inventory upserts.
  -- ------------------------------------------------------------
  FOR v_i IN 1..array_length(p_po_item_ids, 1) LOOP
    v_item_id := p_po_item_ids[v_i];
    v_qty     := p_qtys[v_i];
    v_expiry  := CASE WHEN p_expiry_dates IS NULL THEN NULL ELSE p_expiry_dates[v_i] END;
    IF v_qty IS NULL OR v_qty <= 0 THEN CONTINUE; END IF;

    SELECT wms_item_id, unit_cost, qty_ordered, qty_received, line_weight
      INTO v_wms_item, v_unit_cost, v_ordered, v_received, v_line_weight
      FROM wms_po_items
     WHERE id = v_item_id AND po_id = p_po_id AND org_id = v_org_id
     FOR UPDATE;
    IF v_wms_item IS NULL THEN
      RAISE EXCEPTION 'Line item % is not part of purchase order %', v_item_id, v_po_number USING ERRCODE = '42501';
    END IF;

    v_receivable := v_ordered - v_received;
    IF v_receivable <= 0 THEN CONTINUE; END IF;
    IF v_qty > v_receivable THEN v_qty := v_receivable; END IF;

    -- Compute this line's allocation basis according to the method.
    IF v_landed_total IS NOT NULL AND v_landed_total > 0 AND v_landed_method IS NOT NULL THEN
      CASE v_landed_method
        WHEN 'by_value'  THEN v_alloc_basis := v_qty * v_unit_cost;
        WHEN 'by_weight' THEN v_alloc_basis := v_qty * COALESCE(v_line_weight, 0);
        WHEN 'by_qty'    THEN v_alloc_basis := v_qty;
        ELSE                 v_alloc_basis := 0;
      END CASE;
    ELSE
      v_alloc_basis := 0;
    END IF;

    v_alloc_basis_sum := v_alloc_basis_sum + v_alloc_basis;

    v_intake := v_intake || jsonb_build_array(jsonb_build_object(
      'po_item_id',  v_item_id,
      'wms_item_id', v_wms_item,
      'qty',         v_qty,
      'unit_cost',   v_unit_cost,
      'expiry',      v_expiry,
      'basis',       v_alloc_basis
    ));
  END LOOP;

  IF jsonb_array_length(v_intake) = 0 THEN
    RAISE EXCEPTION 'Nothing to receive — every line is already fully received' USING ERRCODE = '22023';
  END IF;

  INSERT INTO wms_receipts (org_id, receipt_date, supplier, notes, total_cost, recorded_by)
  VALUES (v_org_id, CURRENT_DATE, v_supplier,
          'Received against ' || v_po_number ||
            CASE WHEN v_landed_total IS NOT NULL AND v_landed_total > 0
                 THEN ' (landed R' || v_landed_total::TEXT || ' ' || v_landed_method || ')'
                 ELSE '' END,
          0, p_recorded_by)
  RETURNING id INTO v_receipt_id;

  -- ------------------------------------------------------------
  -- Pass 2: for each intake row compute effective per-unit cost
  -- (unit_cost + share of landed) and write receipt_items, inventory,
  -- po_items.qty_received, and ledger.
  -- ------------------------------------------------------------
  FOR v_intake_row IN SELECT * FROM jsonb_array_elements(v_intake) LOOP
    v_item_id   := (v_intake_row->>'po_item_id')::BIGINT;
    v_wms_item  := (v_intake_row->>'wms_item_id')::BIGINT;
    v_qty       := (v_intake_row->>'qty')::INT;
    v_unit_cost := (v_intake_row->>'unit_cost')::NUMERIC;
    v_expiry    := CASE WHEN v_intake_row->>'expiry' IS NULL THEN NULL
                        ELSE (v_intake_row->>'expiry')::DATE END;
    v_alloc_basis := (v_intake_row->>'basis')::NUMERIC;

    IF v_alloc_basis_sum > 0 THEN
      -- Line's share of the landed pool, spread across its units.
      v_landed_per_unit := ROUND(
        (v_alloc_basis / v_alloc_basis_sum) * v_landed_total / v_qty,
        4
      );
    ELSE
      v_landed_per_unit := 0;
    END IF;

    v_effective_cost := v_unit_cost + COALESCE(v_landed_per_unit, 0);

    INSERT INTO wms_receipt_items (
      org_id, receipt_id, wms_item_id, packs, pack_size, total_units,
      unit_cost, line_total, expiry_date
    ) VALUES (
      v_org_id, v_receipt_id, v_wms_item, v_qty, 1, v_qty,
      v_effective_cost, v_qty * v_effective_cost, v_expiry
    );

    SELECT physical_qty, avg_cost INTO v_old_qty, v_old_avg
      FROM wms_inventory
     WHERE org_id = v_org_id AND wms_item_id = v_wms_item AND location_id = v_location_id
     FOR UPDATE;

    v_new_avg := _wms_moving_avg(COALESCE(v_old_qty, 0), v_old_avg, v_qty, v_effective_cost);

    INSERT INTO wms_inventory (org_id, wms_item_id, location_id, physical_qty, avg_cost)
    VALUES (v_org_id, v_wms_item, v_location_id, v_qty, v_new_avg)
    ON CONFLICT (org_id, wms_item_id, location_id) DO UPDATE
    SET physical_qty = wms_inventory.physical_qty + EXCLUDED.physical_qty,
        avg_cost     = v_new_avg,
        updated_at   = NOW();

    UPDATE wms_po_items SET qty_received = qty_received + v_qty WHERE id = v_item_id;

    PERFORM emit_stock_movement(
      v_org_id, v_wms_item, v_location_id, v_qty, v_effective_cost,
      'receipt', 'wms_receipts', v_receipt_id,
      CASE WHEN v_landed_per_unit > 0
           THEN 'PO ' || v_po_number || ' (landed +R' || v_landed_per_unit::TEXT || '/u)'
           ELSE 'PO ' || v_po_number END
    );

    v_total := v_total + (v_qty * v_effective_cost);
    v_lines := v_lines + 1;
  END LOOP;

  UPDATE wms_receipts SET total_cost = v_total WHERE id = v_receipt_id;

  SELECT COUNT(*) INTO v_remaining
    FROM wms_po_items WHERE po_id = p_po_id AND qty_received < qty_ordered;
  UPDATE wms_purchase_orders
     SET status = CASE WHEN v_remaining = 0 THEN 'Received' ELSE 'Partially Received' END,
         updated_at = NOW()
   WHERE id = p_po_id;

  RETURN v_receipt_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION receive_wms_purchase_order(BIGINT, BIGINT[], INTEGER[], TEXT, DATE[]) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION receive_wms_purchase_order(BIGINT, BIGINT[], INTEGER[], TEXT, DATE[]) TO authenticated;

-- ============================================================
-- Verification (run manually in SQL Editor after applying)
-- ============================================================
-- -- 1. Columns exist:
-- SELECT column_name FROM information_schema.columns
--  WHERE table_schema='public'
--    AND (table_name,column_name) IN (
--      ('wms_purchase_orders','landed_cost_total'),
--      ('wms_purchase_orders','landed_cost_method'),
--      ('wms_po_items','line_weight')
--    )
--  ORDER BY column_name;
-- -- Expect: 3 rows.
--
-- -- 2. RPC has exactly one overload:
-- SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--  WHERE n.nspname='public' AND p.proname='receive_wms_purchase_order';
-- -- Expect: 1.
--
-- -- 3. End-to-end (pick <PO_ID> with status Sent + at least one line):
-- --   UPDATE wms_purchase_orders SET landed_cost_total = 200, landed_cost_method = 'by_value'
-- --    WHERE id = <PO_ID>;
-- --   -- Receive the whole PO in one call; the receipt.total_cost should be
-- --   -- SUM(qty*unit_cost) + 200. Every wms_receipt_items.unit_cost row for
-- --   -- this receipt should be > its wms_po_items.unit_cost.
-- --   SELECT id, unit_cost FROM wms_receipt_items WHERE receipt_id = <NEW>;
