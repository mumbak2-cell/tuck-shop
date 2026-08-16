-- ============================================================
-- 090_wms_tier2_lot_lite_expiry.sql
--
-- Tier 2 Phase 2 — lot-lite (expiry per receipt line).
--
-- Scope choice
-- ------------
-- "Lot-lite" captures expiry_date PER RECEIPT LINE only. No separate
-- wms_lots table, no per-lot cost basis, no recall table, no serials.
-- Full lots (with FEFO enforced at dispatch and cross-receipt lot
-- allocation) is Tier 3 territory; almost every SADC tuck-shop use
-- case only needs "warn me before it expires" and "let me see what's
-- expiring soon", both of which fall out of the per-receipt-line
-- capture with no further backend work.
--
-- Backend enforcement
-- -------------------
-- NONE in this migration. Dispatch continues to draw from bin-level
-- wms_inventory quantity without consulting expiry. The receive path
-- captures the data; frontend surfaces "earliest expiring stock" as
-- an advisory. Enforced FEFO allocation (choosing which receipt line
-- to draw down first) waits for full lots (Tier 3) — enforcing it
-- here without lot-level remaining_units tracking would silently
-- allow oversell of the older lots.
--
-- Changes
-- -------
--   - wms_catalog.tracks_expiry       BOOLEAN NOT NULL DEFAULT FALSE
--                                     Per-item opt-in. Non-perishables
--                                     stay at FALSE and skip the whole
--                                     expiry flow.
--   - wms_receipt_items.expiry_date   DATE nullable. Captured on receive.
--   - receive_wms_stock rewritten to accept p_expiry_dates DATE[]
--     DEFAULT NULL (per-line, may contain NULLs). Old callers unaffected.
--   - receive_wms_purchase_order rewritten similarly with
--     p_expiry_dates DATE[] DEFAULT NULL — one entry per p_po_item_ids.
--   - wms_expiry_forecast view — per (org, item) surfaces
--     earliest_expiring_at, expired_units, expiring_within_30d_units.
--     Estimated remaining per receipt line via FIFO consumption of
--     dispatch quantity by receipt date; approximate but sufficient
--     for expiry warnings, which is the whole point of lot-lite.
--
-- Idempotent. Safe to re-run.
--
-- Depends on 083 (damage_qty column), 087–089 (ledger + inventory
-- reshape); no schema conflict with earlier migrations.
--
-- Record with:
--   node node_modules/supabase/dist/supabase.js migration repair \
--     --status applied 090
-- ============================================================

-- ------------------------------------------------------------
-- 1. Schema additions
-- ------------------------------------------------------------
ALTER TABLE wms_catalog
  ADD COLUMN IF NOT EXISTS tracks_expiry BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE wms_receipt_items
  ADD COLUMN IF NOT EXISTS expiry_date DATE;

CREATE INDEX IF NOT EXISTS idx_wms_receipt_items_expiry
  ON wms_receipt_items(org_id, wms_item_id, expiry_date)
  WHERE expiry_date IS NOT NULL;

-- ------------------------------------------------------------
-- 2. Rewrite receive_wms_stock (adds p_expiry_dates)
--    Drops the 12-arg version from migration 089 and re-creates 13-arg.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.receive_wms_stock(
  TEXT, TEXT, TEXT, INTEGER[], INTEGER[], INTEGER[], NUMERIC[],
  INTEGER[], NUMERIC[], NUMERIC[], UUID, UUID
);

CREATE OR REPLACE FUNCTION receive_wms_stock(
  p_supplier        TEXT,
  p_notes           TEXT,
  p_recorded_by     TEXT,
  p_wms_item_ids    INTEGER[],
  p_packs           INTEGER[],
  p_pack_sizes      INTEGER[],
  p_unit_costs      NUMERIC[],
  p_damage_qtys     INTEGER[] DEFAULT NULL,
  p_tax_rates       NUMERIC[] DEFAULT NULL,
  p_tax_amounts     NUMERIC[] DEFAULT NULL,
  p_idempotency_key UUID      DEFAULT NULL,
  p_location_id     UUID      DEFAULT NULL,
  p_expiry_dates    DATE[]    DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_receipt_id  INTEGER;
  v_total_cost  NUMERIC := 0;
  v_i           INT;
  v_n           INT;
  v_total_units INT;
  v_usable_qty  INT;
  v_line_total  NUMERIC;
  v_org_id      UUID;
  v_orgs        INT;
  v_found       INT;
  v_damage      INT;
  v_tax_rate    NUMERIC;
  v_tax_amount  NUMERIC;
  v_expiry      DATE;
  v_cached      JSONB;
  v_location_id UUID;
  v_old_qty     INT;
  v_old_avg     NUMERIC;
  v_new_avg     NUMERIC;
BEGIN
  IF array_length(p_wms_item_ids, 1) IS NULL OR array_length(p_wms_item_ids, 1) = 0 THEN
    RAISE EXCEPTION 'At least one line item is required';
  END IF;
  v_n := array_length(p_wms_item_ids, 1);
  IF v_n <> array_length(p_packs, 1)
     OR v_n <> array_length(p_pack_sizes, 1)
     OR v_n <> array_length(p_unit_costs, 1) THEN
    RAISE EXCEPTION 'All arrays must have the same length';
  END IF;
  IF p_damage_qtys  IS NOT NULL AND array_length(p_damage_qtys, 1)  <> v_n THEN RAISE EXCEPTION 'p_damage_qtys length must match p_wms_item_ids';  END IF;
  IF p_tax_rates    IS NOT NULL AND array_length(p_tax_rates, 1)    <> v_n THEN RAISE EXCEPTION 'p_tax_rates length must match p_wms_item_ids';    END IF;
  IF p_tax_amounts  IS NOT NULL AND array_length(p_tax_amounts, 1)  <> v_n THEN RAISE EXCEPTION 'p_tax_amounts length must match p_wms_item_ids';  END IF;
  IF p_expiry_dates IS NOT NULL AND array_length(p_expiry_dates, 1) <> v_n THEN RAISE EXCEPTION 'p_expiry_dates length must match p_wms_item_ids'; END IF;

  SELECT COUNT(DISTINCT org_id), COUNT(DISTINCT id) INTO v_orgs, v_found
    FROM wms_catalog WHERE id = ANY(p_wms_item_ids::BIGINT[]);
  IF v_found <> (SELECT COUNT(DISTINCT x) FROM unnest(p_wms_item_ids) AS x) THEN
    RAISE EXCEPTION 'One or more warehouse items do not exist' USING ERRCODE = '42501';
  END IF;
  IF v_orgs <> 1 THEN
    RAISE EXCEPTION 'Line items span more than one organisation' USING ERRCODE = '42501';
  END IF;

  SELECT org_id INTO v_org_id FROM wms_catalog WHERE id = ANY(p_wms_item_ids::BIGINT[]) LIMIT 1;

  PERFORM assert_org_writable(v_org_id);
  PERFORM assert_no_active_freeze(v_org_id, p_wms_item_ids::BIGINT[]);

  v_cached := claim_rpc_idempotency(p_idempotency_key, v_org_id, 'receive_wms_stock');
  IF v_cached IS NOT NULL THEN
    RETURN (v_cached->>'result')::INTEGER;
  END IF;

  v_location_id := COALESCE(p_location_id, resolve_wms_main_location(v_org_id));

  FOR v_i IN 1..v_n LOOP
    v_total_cost := v_total_cost + (p_packs[v_i] * p_pack_sizes[v_i] * p_unit_costs[v_i]);
  END LOOP;

  INSERT INTO wms_receipts (org_id, receipt_date, supplier, notes, total_cost, recorded_by)
  VALUES (v_org_id, CURRENT_DATE, NULLIF(TRIM(p_supplier), ''), NULLIF(TRIM(p_notes), ''),
          v_total_cost, p_recorded_by)
  RETURNING id INTO v_receipt_id;

  FOR v_i IN 1..v_n LOOP
    v_total_units := p_packs[v_i] * p_pack_sizes[v_i];
    v_line_total  := v_total_units * p_unit_costs[v_i];
    v_damage      := COALESCE(p_damage_qtys[v_i], 0);
    v_tax_rate    := CASE WHEN p_tax_rates    IS NULL THEN NULL ELSE p_tax_rates[v_i]    END;
    v_tax_amount  := CASE WHEN p_tax_amounts  IS NULL THEN NULL ELSE p_tax_amounts[v_i]  END;
    v_expiry      := CASE WHEN p_expiry_dates IS NULL THEN NULL ELSE p_expiry_dates[v_i] END;
    v_usable_qty  := v_total_units - v_damage;

    INSERT INTO wms_receipt_items (
      org_id, receipt_id, wms_item_id, packs, pack_size, total_units, unit_cost,
      line_total, damage_qty, tax_rate, tax_amount, expiry_date
    ) VALUES (
      v_org_id, v_receipt_id, p_wms_item_ids[v_i], p_packs[v_i], p_pack_sizes[v_i],
      v_total_units, p_unit_costs[v_i], v_line_total, v_damage, v_tax_rate, v_tax_amount, v_expiry
    );

    SELECT physical_qty, avg_cost INTO v_old_qty, v_old_avg
      FROM wms_inventory
     WHERE org_id = v_org_id AND wms_item_id = p_wms_item_ids[v_i] AND location_id = v_location_id
     FOR UPDATE;

    v_new_avg := _wms_moving_avg(COALESCE(v_old_qty, 0), v_old_avg, v_usable_qty, p_unit_costs[v_i]);

    INSERT INTO wms_inventory (org_id, wms_item_id, location_id, physical_qty, avg_cost)
    VALUES (v_org_id, p_wms_item_ids[v_i], v_location_id, v_usable_qty, v_new_avg)
    ON CONFLICT (org_id, wms_item_id, location_id) DO UPDATE
    SET physical_qty = wms_inventory.physical_qty + EXCLUDED.physical_qty,
        avg_cost     = v_new_avg,
        updated_at   = NOW();

    IF v_usable_qty > 0 THEN
      PERFORM emit_stock_movement(
        v_org_id, p_wms_item_ids[v_i], v_location_id, v_usable_qty, p_unit_costs[v_i],
        'receipt', 'wms_receipts', v_receipt_id::BIGINT, NULL
      );
    END IF;
  END LOOP;

  PERFORM store_rpc_idempotency_response(
    p_idempotency_key, v_org_id, 'receive_wms_stock',
    jsonb_build_object('result', v_receipt_id)
  );

  RETURN v_receipt_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION receive_wms_stock(
  TEXT, TEXT, TEXT, INTEGER[], INTEGER[], INTEGER[], NUMERIC[],
  INTEGER[], NUMERIC[], NUMERIC[], UUID, UUID, DATE[]
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION receive_wms_stock(
  TEXT, TEXT, TEXT, INTEGER[], INTEGER[], INTEGER[], NUMERIC[],
  INTEGER[], NUMERIC[], NUMERIC[], UUID, UUID, DATE[]
) TO authenticated;

-- ------------------------------------------------------------
-- 3. Rewrite receive_wms_purchase_order (adds p_expiry_dates)
--    One entry per p_po_item_ids position. NULL entries mean "no
--    expiry captured for this receipt line".
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.receive_wms_purchase_order(BIGINT, BIGINT[], INTEGER[], TEXT);

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
  v_org_id      UUID;
  v_po_number   TEXT;
  v_supplier    TEXT;
  v_status      TEXT;
  v_receipt_id  BIGINT;
  v_total       NUMERIC := 0;
  v_lines       INT := 0;
  v_remaining   INT;
  v_i           INT;
  v_item_id     BIGINT;
  v_qty         INT;
  v_wms_item    BIGINT;
  v_unit_cost   NUMERIC;
  v_ordered     INT;
  v_received    INT;
  v_receivable  INT;
  v_expiry      DATE;
  v_location_id UUID;
  v_old_qty     INT;
  v_old_avg     NUMERIC;
  v_new_avg     NUMERIC;
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

  SELECT org_id, po_number, supplier, status INTO v_org_id, v_po_number, v_supplier, v_status
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

  INSERT INTO wms_receipts (org_id, receipt_date, supplier, notes, total_cost, recorded_by)
  VALUES (v_org_id, CURRENT_DATE, v_supplier, 'Received against ' || v_po_number, 0, p_recorded_by)
  RETURNING id INTO v_receipt_id;

  FOR v_i IN 1..array_length(p_po_item_ids, 1) LOOP
    v_item_id := p_po_item_ids[v_i];
    v_qty     := p_qtys[v_i];
    v_expiry  := CASE WHEN p_expiry_dates IS NULL THEN NULL ELSE p_expiry_dates[v_i] END;
    IF v_qty IS NULL OR v_qty <= 0 THEN CONTINUE; END IF;

    SELECT wms_item_id, unit_cost, qty_ordered, qty_received
      INTO v_wms_item, v_unit_cost, v_ordered, v_received
      FROM wms_po_items
     WHERE id = v_item_id AND po_id = p_po_id AND org_id = v_org_id
     FOR UPDATE;
    IF v_wms_item IS NULL THEN
      RAISE EXCEPTION 'Line item % is not part of purchase order %', v_item_id, v_po_number USING ERRCODE = '42501';
    END IF;

    v_receivable := v_ordered - v_received;
    IF v_receivable <= 0 THEN CONTINUE; END IF;
    IF v_qty > v_receivable THEN v_qty := v_receivable; END IF;

    INSERT INTO wms_receipt_items (
      org_id, receipt_id, wms_item_id, packs, pack_size, total_units, unit_cost, line_total, expiry_date
    ) VALUES (
      v_org_id, v_receipt_id, v_wms_item, v_qty, 1, v_qty, v_unit_cost, v_qty * v_unit_cost, v_expiry
    );

    SELECT physical_qty, avg_cost INTO v_old_qty, v_old_avg
      FROM wms_inventory
     WHERE org_id = v_org_id AND wms_item_id = v_wms_item AND location_id = v_location_id
     FOR UPDATE;

    v_new_avg := _wms_moving_avg(COALESCE(v_old_qty, 0), v_old_avg, v_qty, v_unit_cost);

    INSERT INTO wms_inventory (org_id, wms_item_id, location_id, physical_qty, avg_cost)
    VALUES (v_org_id, v_wms_item, v_location_id, v_qty, v_new_avg)
    ON CONFLICT (org_id, wms_item_id, location_id) DO UPDATE
    SET physical_qty = wms_inventory.physical_qty + EXCLUDED.physical_qty,
        avg_cost     = v_new_avg,
        updated_at   = NOW();

    UPDATE wms_po_items SET qty_received = qty_received + v_qty WHERE id = v_item_id;

    PERFORM emit_stock_movement(
      v_org_id, v_wms_item, v_location_id, v_qty, v_unit_cost,
      'receipt', 'wms_receipts', v_receipt_id, 'PO ' || v_po_number
    );

    v_total := v_total + (v_qty * v_unit_cost);
    v_lines := v_lines + 1;
  END LOOP;

  IF v_lines = 0 THEN
    RAISE EXCEPTION 'Nothing to receive — every line is already fully received' USING ERRCODE = '22023';
  END IF;

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

-- ------------------------------------------------------------
-- 4. wms_expiry_forecast — read-only advisory view
--    Per (org, item) surfaces earliest expiry that still has an
--    estimated remaining balance, plus rolled-up expired /
--    expiring-within-30-days counts.
--
--    Estimation model — FIFO by receipt_date across receipt lines.
--    The total dispatched-plus-adjusted-out qty for an item is
--    subtracted from the OLDEST receipt lines first. What survives
--    is the "remaining by line" estimate. Approximate — enough for
--    a "the milk expires Friday" nudge; NOT enough to enforce FEFO
--    at dispatch (which would need per-lot remaining_units, saved
--    for Tier 3 full lots).
--
--    Only items where wms_catalog.tracks_expiry = TRUE appear.
-- ------------------------------------------------------------
DROP VIEW IF EXISTS wms_expiry_forecast;

CREATE VIEW wms_expiry_forecast AS
WITH lines AS (
  SELECT ri.org_id,
         ri.wms_item_id,
         ri.id                                          AS receipt_item_id,
         ri.expiry_date,
         (ri.total_units - COALESCE(ri.damage_qty, 0))  AS usable_units,
         r.receipt_date
    FROM wms_receipt_items ri
    JOIN wms_receipts       r ON r.id = ri.receipt_id
    JOIN wms_catalog        c ON c.id = ri.wms_item_id
   WHERE c.tracks_expiry = TRUE
     AND ri.expiry_date IS NOT NULL
     AND ri.total_units - COALESCE(ri.damage_qty, 0) > 0
),
lines_ordered AS (
  SELECT l.*,
         SUM(l.usable_units) OVER (
           PARTITION BY l.org_id, l.wms_item_id
           ORDER BY l.receipt_date, l.receipt_item_id
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         ) AS cum_units_incl
    FROM lines l
),
dispatched_out AS (
  -- Sum every negative ledger delta per item (dispatches, adjustments,
  -- transfers_out). count_apply deltas are excluded because a count
  -- rewrites the base level, not a running consumption.
  SELECT org_id, wms_item_id, -SUM(qty_delta) AS units_out
    FROM stock_movements
   WHERE qty_delta < 0
     AND movement_type IN ('dispatch','adjust','transfer_out')
   GROUP BY org_id, wms_item_id
),
remaining AS (
  SELECT lo.org_id,
         lo.wms_item_id,
         lo.receipt_item_id,
         lo.expiry_date,
         GREATEST(
           lo.usable_units - GREATEST(
             COALESCE(d.units_out, 0) - (lo.cum_units_incl - lo.usable_units),
             0
           ),
           0
         )::INT AS remaining_units
    FROM lines_ordered lo
    LEFT JOIN dispatched_out d
      ON d.org_id = lo.org_id AND d.wms_item_id = lo.wms_item_id
)
SELECT org_id,
       wms_item_id,
       MIN(expiry_date) FILTER (WHERE remaining_units > 0)                          AS earliest_expiring_at,
       COALESCE(SUM(remaining_units) FILTER (WHERE expiry_date < CURRENT_DATE), 0)  AS expired_units,
       COALESCE(SUM(remaining_units) FILTER (
         WHERE expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
       ), 0)                                                                        AS expiring_within_30d_units,
       COALESCE(SUM(remaining_units), 0)                                            AS tracked_units_total
  FROM remaining
 GROUP BY org_id, wms_item_id;

-- RLS inheritance from wms_receipt_items + wms_catalog policies (both
-- org-scoped). No separate policy on the view.

-- ============================================================
-- Verification (run manually in SQL Editor after applying)
-- ============================================================
-- -- 1. New columns + view exist:
-- SELECT 'wms_catalog.tracks_expiry',
--        EXISTS (SELECT 1 FROM information_schema.columns
--                 WHERE table_schema='public' AND table_name='wms_catalog' AND column_name='tracks_expiry')::text
-- UNION ALL
-- SELECT 'wms_receipt_items.expiry_date',
--        EXISTS (SELECT 1 FROM information_schema.columns
--                 WHERE table_schema='public' AND table_name='wms_receipt_items' AND column_name='expiry_date')::text
-- UNION ALL
-- SELECT 'wms_expiry_forecast view',
--        EXISTS (SELECT 1 FROM information_schema.views
--                 WHERE table_schema='public' AND table_name='wms_expiry_forecast')::text;
-- -- Expect: three rows, all 'true'.
--
-- -- 2. RPC overloads (should be exactly one for each):
-- SELECT p.proname, COUNT(*) AS overloads
--   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--  WHERE n.nspname='public'
--    AND p.proname IN ('receive_wms_stock','receive_wms_purchase_order')
--  GROUP BY p.proname;
-- -- Expect: two rows, each overloads=1.
--
-- -- 3. Behaviour test (edit <ITEM> to a wms_catalog.id in your org):
-- DO $$
-- DECLARE v_item BIGINT := <ITEM>;
--         v_org  UUID   := (SELECT org_id FROM wms_catalog WHERE id = v_item);
--         v_rid  INT;
--         v_expiry DATE := CURRENT_DATE + INTERVAL '7 days';
--         v_row_expiry DATE;
-- BEGIN
--   UPDATE wms_catalog SET tracks_expiry = TRUE WHERE id = v_item;
--
--   v_rid := receive_wms_stock('TestSup', 'expiry-test', 'tester',
--     ARRAY[v_item::INT], ARRAY[1], ARRAY[5], ARRAY[3.50],
--     NULL, NULL, NULL, NULL, NULL, ARRAY[v_expiry]);
--
--   SELECT expiry_date INTO v_row_expiry
--     FROM wms_receipt_items
--    WHERE receipt_id = v_rid AND wms_item_id = v_item;
--
--   IF v_row_expiry IS DISTINCT FROM v_expiry THEN
--     RAISE EXCEPTION 'FAIL: expiry stored as %, expected %', v_row_expiry, v_expiry;
--   END IF;
--
--   IF NOT EXISTS (
--     SELECT 1 FROM wms_expiry_forecast
--      WHERE org_id = v_org AND wms_item_id = v_item AND earliest_expiring_at = v_expiry
--   ) THEN
--     RAISE EXCEPTION 'FAIL: expiry_forecast view did not surface the new line';
--   END IF;
--
--   RAISE NOTICE 'PASS: expiry captured + forecast view working';
-- END $$;
