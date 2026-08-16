-- ============================================================
-- 089_wms_tier2_rpc_rewire.sql
--
-- Tier 2 Phase 1 (part 3/3) — RPC rewire.
--
-- Rewrites every mutating WMS RPC to:
--   1. Accept p_location_id UUID DEFAULT NULL (resolves to MAIN when NULL,
--      so pre-Tier-2 callers work unchanged).
--   2. Emit a stock_movements row per line item.
--   3. Update wms_inventory.avg_cost using moving-average on receipt paths.
--   4. Carry avg_cost onto wms_dispatch_items.unit_cost (new column).
--   5. Bridge cost basis to POS product_stock on Internal Shop dispatches.
--   6. Use the new ON CONFLICT (org, item, location) key.
--
-- Preserves from Tier 1:
--   - assert_org_writable + assert_no_active_freeze guards
--   - claim_rpc_idempotency + store_rpc_idempotency_response wrappers
--   - all existing signature params (added params are DEFAULT NULL so
--     pre-Tier-2 callers still compile against the RPC)
--
-- CRITICAL — apply this in the SAME SQL Editor session as 088.
-- Migration 088 drops the (org_id, wms_item_id) unique; the old RPC
-- bodies reference it in ON CONFLICT clauses. Between 088 and 089 every
-- WMS stock write fails.
--
-- Depends on 087 (locations + ledger), 088 (inventory reshape).
--
-- Idempotent. Safe to re-run.
--
-- Record with:
--   node node_modules/supabase/dist/supabase.js migration repair \
--     --status applied 089
-- ============================================================

-- ------------------------------------------------------------
-- 0. Schema tweak: wms_dispatch_items gains unit_cost.
--    Nullable for pre-Tier2 rows; populated by dispatch RPC going forward.
-- ------------------------------------------------------------
ALTER TABLE wms_dispatch_items
  ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(12,2);

-- ------------------------------------------------------------
-- 1. Helper — resolve an org's MAIN location id.
--    Used as the default when a caller passes p_location_id = NULL.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION resolve_wms_main_location(p_org_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  SELECT id INTO v_id
    FROM wms_locations
   WHERE org_id = p_org_id AND code = 'MAIN'
   LIMIT 1;

  IF v_id IS NULL THEN
    -- Trigger from 087 should have made this impossible for WMS-active
    -- orgs, but guard rather than silently corrupt.
    INSERT INTO wms_locations (org_id, code, label, kind, active)
    VALUES (p_org_id, 'MAIN', 'Main Warehouse', 'staging', TRUE)
    ON CONFLICT (org_id, code) DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
      SELECT id INTO v_id FROM wms_locations WHERE org_id = p_org_id AND code = 'MAIN';
    END IF;
  END IF;

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION resolve_wms_main_location(UUID) FROM PUBLIC, anon;

-- ------------------------------------------------------------
-- 2. Helper — moving-average cost update on receipt.
--    new_avg = (old_qty * old_avg + received_qty * received_cost)
--              / (old_qty + received_qty)
--    Falls back to received_cost if old_avg is NULL (fresh row) or
--    old_qty is 0.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION _wms_moving_avg(
  p_old_qty  INT,
  p_old_avg  NUMERIC,
  p_new_qty  INT,
  p_new_cost NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF p_new_qty IS NULL OR p_new_qty <= 0 THEN
    RETURN p_old_avg;
  END IF;
  IF p_old_qty IS NULL OR p_old_qty <= 0 OR p_old_avg IS NULL THEN
    RETURN p_new_cost;
  END IF;
  RETURN ROUND(
    (p_old_qty * p_old_avg + p_new_qty * p_new_cost)::NUMERIC
    / (p_old_qty + p_new_qty),
    4
  );
END;
$$;

-- ------------------------------------------------------------
-- 3. Helper — emit a stock_movements ledger row.
--    SECURITY DEFINER so it bypasses the append-only RLS gap (no
-- client INSERT policy exists on stock_movements). Callers pass the
-- pre-derived org_id — this function does not re-authorize.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION emit_stock_movement(
  p_org_id        UUID,
  p_wms_item_id   BIGINT,
  p_location_id   UUID,
  p_qty_delta     INT,
  p_cost_per_unit NUMERIC,
  p_movement_type TEXT,
  p_ref_table     TEXT,
  p_ref_id        BIGINT,
  p_notes         TEXT DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id BIGINT;
BEGIN
  INSERT INTO stock_movements (
    org_id, wms_item_id, location_id, qty_delta, cost_per_unit,
    movement_type, ref_table, ref_id, actor_user_id, notes
  )
  VALUES (
    p_org_id, p_wms_item_id, p_location_id, p_qty_delta, p_cost_per_unit,
    p_movement_type, p_ref_table, p_ref_id, auth.uid(), p_notes
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION emit_stock_movement(UUID, BIGINT, UUID, INT, NUMERIC, TEXT, TEXT, BIGINT, TEXT) FROM PUBLIC, anon;
-- Not granted to authenticated: only the SECURITY DEFINER RPCs below call it.

-- ============================================================
-- 4. receive_wms_stock — adds location + ledger + moving-avg.
-- ============================================================
DROP FUNCTION IF EXISTS public.receive_wms_stock(
  TEXT, TEXT, TEXT, INTEGER[], INTEGER[], INTEGER[], NUMERIC[],
  INTEGER[], NUMERIC[], NUMERIC[], UUID
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
  p_location_id     UUID      DEFAULT NULL
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

  -- Resolve target location (default MAIN if caller passed NULL).
  v_location_id := COALESCE(p_location_id, resolve_wms_main_location(v_org_id));

  -- Cost aggregation for the receipt header.
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
    v_tax_rate    := CASE WHEN p_tax_rates   IS NULL THEN NULL ELSE p_tax_rates[v_i]   END;
    v_tax_amount  := CASE WHEN p_tax_amounts IS NULL THEN NULL ELSE p_tax_amounts[v_i] END;
    v_usable_qty  := v_total_units - v_damage;

    INSERT INTO wms_receipt_items (
      org_id, receipt_id, wms_item_id, packs, pack_size, total_units, unit_cost,
      line_total, damage_qty, tax_rate, tax_amount
    ) VALUES (
      v_org_id, v_receipt_id, p_wms_item_ids[v_i], p_packs[v_i], p_pack_sizes[v_i],
      v_total_units, p_unit_costs[v_i], v_line_total, v_damage, v_tax_rate, v_tax_amount
    );

    -- Fetch old (qty, avg) for moving-average computation, LOCKing the row.
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

    -- Ledger row: only the USABLE (non-damaged) units enter stock.
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
  INTEGER[], NUMERIC[], NUMERIC[], UUID, UUID
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION receive_wms_stock(
  TEXT, TEXT, TEXT, INTEGER[], INTEGER[], INTEGER[], NUMERIC[],
  INTEGER[], NUMERIC[], NUMERIC[], UUID, UUID
) TO authenticated;

-- ============================================================
-- 5. create_wms_dispatch — adds location for source + ledger + cost carry.
-- ============================================================
DROP FUNCTION IF EXISTS public.create_wms_dispatch(TEXT, UUID, TEXT, JSONB, TEXT, TEXT, UUID);

CREATE OR REPLACE FUNCTION create_wms_dispatch(
  p_destination_type        TEXT,
  p_destination_location_id UUID,
  p_destination_name        TEXT,
  p_items                   JSONB,
  p_notes                   TEXT DEFAULT NULL,
  p_created_by              TEXT DEFAULT NULL,
  p_idempotency_key         UUID DEFAULT NULL,
  p_source_location_id      UUID DEFAULT NULL   -- warehouse bin to draw from; defaults MAIN
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dispatch_id BIGINT;
  v_org_id      UUID;
  v_loc_org     UUID;
  v_dest_label  TEXT;
  v_item_ids    BIGINT[];
  v_cached      JSONB;
  item          JSONB;
  v_item_id     BIGINT;
  v_qty         INT;
  v_current_qty INT;
  v_avg_cost    NUMERIC;
  v_product_id  UUID;
  v_source_loc  UUID;
BEGIN
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'At least one dispatch item is required';
  END IF;
  IF p_destination_type NOT IN ('Internal Shop', 'External Client', 'Wholesale') THEN
    RAISE EXCEPTION 'Invalid destination type: %', p_destination_type USING ERRCODE = '22023';
  END IF;

  SELECT ARRAY_AGG((elem->>'wms_item_id')::BIGINT) INTO v_item_ids
    FROM jsonb_array_elements(p_items) AS elem;

  SELECT c.org_id INTO v_org_id FROM wms_catalog c WHERE c.id = v_item_ids[1];
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Unknown wms_item_id %', v_item_ids[1] USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM wms_catalog c WHERE c.id = ANY(v_item_ids) AND c.org_id <> v_org_id) THEN
    RAISE EXCEPTION 'Dispatch items span more than one organisation' USING ERRCODE = '42501';
  END IF;

  IF p_destination_type = 'Internal Shop' THEN
    IF p_destination_location_id IS NULL THEN
      RAISE EXCEPTION 'Internal Shop dispatch requires a destination location' USING ERRCODE = '22023';
    END IF;
    SELECT org_id, name INTO v_loc_org, v_dest_label
      FROM locations WHERE id = p_destination_location_id AND active;
    IF v_loc_org IS NULL THEN
      RAISE EXCEPTION 'Destination location not found or inactive' USING ERRCODE = '42501';
    END IF;
    IF v_loc_org <> v_org_id THEN
      RAISE EXCEPTION 'Destination location belongs to a different organisation' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF p_destination_location_id IS NOT NULL THEN
      RAISE EXCEPTION 'Only Internal Shop dispatches target a location' USING ERRCODE = '22023';
    END IF;
    v_dest_label := NULLIF(TRIM(p_destination_name), '');
    IF v_dest_label IS NULL THEN
      RAISE EXCEPTION 'Destination name is required' USING ERRCODE = '22023';
    END IF;
  END IF;

  PERFORM assert_org_writable(v_org_id);
  PERFORM assert_no_active_freeze(v_org_id, v_item_ids);

  v_cached := claim_rpc_idempotency(p_idempotency_key, v_org_id, 'create_wms_dispatch');
  IF v_cached IS NOT NULL THEN
    RETURN (v_cached->>'result')::BIGINT;
  END IF;

  v_source_loc := COALESCE(p_source_location_id, resolve_wms_main_location(v_org_id));

  INSERT INTO wms_dispatches (
    org_id, destination_type, destination_id, destination_location_id,
    status, notes, created_by
  ) VALUES (
    v_org_id, p_destination_type, v_dest_label, p_destination_location_id,
    'Dispatched', NULLIF(TRIM(p_notes), ''), p_created_by
  )
  RETURNING id INTO v_dispatch_id;

  FOR item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_item_id := (item->>'wms_item_id')::BIGINT;
    v_qty     := (item->>'qty')::INT;
    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'Quantity must be greater than zero for item %', v_item_id;
    END IF;

    -- Lock inventory row at the source bin + read avg_cost for cost carry.
    SELECT physical_qty, avg_cost INTO v_current_qty, v_avg_cost
      FROM wms_inventory
     WHERE org_id = v_org_id AND wms_item_id = v_item_id AND location_id = v_source_loc
     FOR UPDATE;
    IF v_current_qty IS NULL THEN
      RAISE EXCEPTION 'No inventory record for item % at source bin', v_item_id USING ERRCODE = '42501';
    END IF;
    IF v_current_qty < v_qty THEN
      RAISE EXCEPTION 'Insufficient warehouse stock for item % at source bin. Available %, requested %',
        v_item_id, v_current_qty, v_qty;
    END IF;

    UPDATE wms_inventory
       SET physical_qty = physical_qty - v_qty,
           updated_at   = NOW()
     WHERE org_id = v_org_id AND wms_item_id = v_item_id AND location_id = v_source_loc;

    INSERT INTO wms_dispatch_items (org_id, dispatch_id, wms_item_id, qty_sent, unit_cost)
    VALUES (v_org_id, v_dispatch_id, v_item_id, v_qty, v_avg_cost);

    PERFORM emit_stock_movement(
      v_org_id, v_item_id, v_source_loc, -v_qty, v_avg_cost,
      'dispatch', 'wms_dispatches', v_dispatch_id, NULL
    );

    -- Internal-shop bridge: credit destination location's retail stock.
    -- Cost-basis bridge to POS is DEFERRED — products.cost_per_unit is a
    -- GENERATED column (mig 055) that only reads recipe_cost_per_unit or
    -- package_price / qty_in_pack. Feeding warehouse avg_cost into POS
    -- requires a new products.warehouse_cost_per_unit column and a
    -- rewritten generated formula — its own scoped migration in Phase 4.
    -- For now the warehouse avg_cost lives on wms_dispatch_items.unit_cost
    -- + the stock_movements ledger, so warehouse COGS reporting works
    -- even though POS sale COGS still uses the pre-Tier2 sources.
    IF p_destination_type = 'Internal Shop' THEN
      SELECT product_id INTO v_product_id
        FROM wms_catalog WHERE id = v_item_id AND org_id = v_org_id;
      IF v_product_id IS NOT NULL THEN
        PERFORM add_product_stock_at_location(v_product_id, v_qty, p_destination_location_id);
      END IF;
    END IF;
  END LOOP;

  PERFORM store_rpc_idempotency_response(
    p_idempotency_key, v_org_id, 'create_wms_dispatch',
    jsonb_build_object('result', v_dispatch_id)
  );

  RETURN v_dispatch_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION create_wms_dispatch(TEXT, UUID, TEXT, JSONB, TEXT, TEXT, UUID, UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION create_wms_dispatch(TEXT, UUID, TEXT, JSONB, TEXT, TEXT, UUID, UUID) TO authenticated;

-- ============================================================
-- 6. record_wms_adjustment — adds location + ledger.
-- ============================================================
DROP FUNCTION IF EXISTS public.record_wms_adjustment(BIGINT, INT, TEXT, TEXT, TEXT, NUMERIC, UUID);

CREATE OR REPLACE FUNCTION record_wms_adjustment(
  p_wms_item_id     BIGINT,
  p_adjustment_qty  INT,
  p_reason          TEXT,
  p_notes           TEXT    DEFAULT NULL,
  p_recorded_by     TEXT    DEFAULT NULL,
  p_cost_price      NUMERIC DEFAULT NULL,
  p_idempotency_key UUID    DEFAULT NULL,
  p_location_id     UUID    DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id        UUID;
  v_adjustment_id BIGINT;
  v_cached        JSONB;
  v_location_id   UUID;
BEGIN
  IF p_adjustment_qty = 0 THEN
    RAISE EXCEPTION 'Adjustment qty cannot be zero';
  END IF;
  IF p_reason NOT IN ('Breakage', 'Expired', 'Theft', 'Correction', 'Other') THEN
    RAISE EXCEPTION 'Invalid reason %', p_reason USING ERRCODE = '22023';
  END IF;

  SELECT org_id INTO v_org_id FROM wms_catalog WHERE id = p_wms_item_id;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Unknown wms_item_id %', p_wms_item_id USING ERRCODE = '42501';
  END IF;

  PERFORM assert_org_writable(v_org_id);
  PERFORM assert_no_active_freeze(v_org_id, ARRAY[p_wms_item_id]::BIGINT[]);

  v_cached := claim_rpc_idempotency(p_idempotency_key, v_org_id, 'record_wms_adjustment');
  IF v_cached IS NOT NULL THEN
    RETURN (v_cached->>'result')::BIGINT;
  END IF;

  v_location_id := COALESCE(p_location_id, resolve_wms_main_location(v_org_id));

  INSERT INTO wms_adjustments (
    org_id, wms_item_id, reason, adjustment_qty, notes, recorded_by, cost_price
  ) VALUES (
    v_org_id, p_wms_item_id, p_reason, p_adjustment_qty,
    NULLIF(TRIM(p_notes), ''), p_recorded_by, p_cost_price
  )
  RETURNING id INTO v_adjustment_id;

  -- Adjust inventory at the target bin. GREATEST(...,0) guards against
  -- negative qty when downward adjustment exceeds bin stock — matches
  -- pre-Tier1 behaviour.
  UPDATE wms_inventory
     SET physical_qty = GREATEST(physical_qty + p_adjustment_qty, 0),
         updated_at   = NOW()
   WHERE org_id = v_org_id AND wms_item_id = p_wms_item_id AND location_id = v_location_id;

  PERFORM emit_stock_movement(
    v_org_id, p_wms_item_id, v_location_id, p_adjustment_qty, p_cost_price,
    'adjust', 'wms_adjustments', v_adjustment_id, p_reason
  );

  PERFORM store_rpc_idempotency_response(
    p_idempotency_key, v_org_id, 'record_wms_adjustment',
    jsonb_build_object('result', v_adjustment_id)
  );

  RETURN v_adjustment_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION record_wms_adjustment(BIGINT, INT, TEXT, TEXT, TEXT, NUMERIC, UUID, UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION record_wms_adjustment(BIGINT, INT, TEXT, TEXT, TEXT, NUMERIC, UUID, UUID) TO authenticated;

-- ============================================================
-- 7. receive_wms_purchase_order — adds location + ledger + moving-avg.
--    Signature unchanged (no new params); target bin is always MAIN in
--    Phase 1 to avoid frontend churn. Bin-scoped PO receipts follow in
--    Phase 3 alongside the pick/pack/ship state machine.
-- ============================================================
DROP FUNCTION IF EXISTS public.receive_wms_purchase_order(BIGINT, BIGINT[], INTEGER[], TEXT);

CREATE OR REPLACE FUNCTION receive_wms_purchase_order(
  p_po_id       BIGINT,
  p_po_item_ids BIGINT[],
  p_qtys        INTEGER[],
  p_recorded_by TEXT DEFAULT NULL
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

  SELECT org_id, po_number, supplier, status INTO v_org_id, v_po_number, v_supplier, v_status
    FROM wms_purchase_orders WHERE id = p_po_id;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Purchase order not found' USING ERRCODE = '42501';
  END IF;

  PERFORM assert_org_writable(v_org_id);

  IF v_status NOT IN ('Sent', 'Partially Received') THEN
    RAISE EXCEPTION 'Purchase order % cannot be received in status %', v_po_number, v_status USING ERRCODE = '22023';
  END IF;

  -- Freeze check across every wms_item on this PO (defensive: even
  -- lines the caller doesn't intend to receive would still block if
  -- covered by a frozen count session).
  PERFORM assert_no_active_freeze(v_org_id,
    (SELECT ARRAY_AGG(DISTINCT wms_item_id) FROM wms_po_items WHERE po_id = p_po_id));

  v_location_id := resolve_wms_main_location(v_org_id);

  INSERT INTO wms_receipts (org_id, receipt_date, supplier, notes, total_cost, recorded_by)
  VALUES (v_org_id, CURRENT_DATE, v_supplier, 'Received against ' || v_po_number, 0, p_recorded_by)
  RETURNING id INTO v_receipt_id;

  FOR v_i IN 1..array_length(p_po_item_ids, 1) LOOP
    v_item_id := p_po_item_ids[v_i];
    v_qty     := p_qtys[v_i];
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
      org_id, receipt_id, wms_item_id, packs, pack_size, total_units, unit_cost, line_total
    ) VALUES (
      v_org_id, v_receipt_id, v_wms_item, v_qty, 1, v_qty, v_unit_cost, v_qty * v_unit_cost
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

REVOKE EXECUTE ON FUNCTION receive_wms_purchase_order(BIGINT, BIGINT[], INTEGER[], TEXT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION receive_wms_purchase_order(BIGINT, BIGINT[], INTEGER[], TEXT) TO authenticated;

-- ============================================================
-- 8. apply_wms_stock_count — targets MAIN in Phase 1.
--    Bin-scoped counting arrives with Wave B12; for now Phase 1
--    guarantees every count writes to (org, item, MAIN) which matches
--    the state of every merchant's inventory since none have split
--    across bins yet.
-- ============================================================
CREATE OR REPLACE FUNCTION apply_wms_stock_count(p_session_id UUID)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r          RECORD;
  v_org_id   UUID;
  v_orgs     INT;
  v_location UUID;
  v_count    INT := 0;
  v_current  INT;
  v_delta    INT;
BEGIN
  SELECT COUNT(DISTINCT org_id) INTO v_orgs FROM wms_stock_counts WHERE session_id = p_session_id;
  IF v_orgs = 0 THEN
    RAISE EXCEPTION 'Stock count session % has no rows', p_session_id;
  END IF;
  IF v_orgs > 1 THEN
    RAISE EXCEPTION 'Stock count session % spans more than one organisation', p_session_id;
  END IF;

  SELECT org_id INTO v_org_id FROM wms_stock_counts WHERE session_id = p_session_id LIMIT 1;

  PERFORM assert_org_writable(v_org_id);

  v_location := resolve_wms_main_location(v_org_id);

  FOR r IN
    SELECT wms_item_id, counted_qty, org_id
      FROM wms_stock_counts
     WHERE session_id = p_session_id
  LOOP
    -- Capture pre-apply qty to derive the ledger delta.
    SELECT COALESCE(physical_qty, 0) INTO v_current
      FROM wms_inventory
     WHERE org_id = r.org_id AND wms_item_id = r.wms_item_id AND location_id = v_location
     FOR UPDATE;

    UPDATE wms_inventory
       SET physical_qty = r.counted_qty,
           updated_at   = NOW()
     WHERE org_id = r.org_id AND wms_item_id = r.wms_item_id AND location_id = v_location;

    -- If no row existed at MAIN yet, create it with the counted qty.
    IF NOT FOUND THEN
      INSERT INTO wms_inventory (org_id, wms_item_id, location_id, physical_qty)
      VALUES (r.org_id, r.wms_item_id, v_location, r.counted_qty)
      ON CONFLICT (org_id, wms_item_id, location_id) DO UPDATE
        SET physical_qty = r.counted_qty, updated_at = NOW();
      v_current := 0;
    END IF;

    UPDATE wms_catalog SET last_counted_at = NOW()
     WHERE id = r.wms_item_id AND org_id = r.org_id;

    v_delta := r.counted_qty - v_current;
    IF v_delta <> 0 THEN
      PERFORM emit_stock_movement(
        r.org_id, r.wms_item_id, v_location, v_delta, NULL,
        'count_apply', 'wms_stock_counts', NULL, 'session=' || p_session_id::text
      );
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION apply_wms_stock_count(UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION apply_wms_stock_count(UUID) TO authenticated;

-- ============================================================
-- Verification (run manually in SQL Editor after applying)
-- ============================================================
-- -- 1. Every RPC has exactly one overload with the expected arg count:
-- SELECT p.proname, count(*) AS overloads,
--        (SELECT pg_get_function_identity_arguments(pp.oid)
--           FROM pg_proc pp WHERE pp.proname = p.proname AND pp.pronamespace = p.pronamespace
--          LIMIT 1) AS sig
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname='public'
--    AND p.proname IN ('receive_wms_stock','create_wms_dispatch','record_wms_adjustment',
--                      'receive_wms_purchase_order','apply_wms_stock_count',
--                      'resolve_wms_main_location','emit_stock_movement','_wms_moving_avg')
--  GROUP BY p.proname, p.pronamespace
--  ORDER BY p.proname;
-- -- Expect: 8 rows, each overloads=1. receive_wms_stock sig ends in "..., p_idempotency_key uuid, p_location_id uuid".
--
-- -- 2. wms_dispatch_items.unit_cost exists:
-- SELECT column_name FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='wms_dispatch_items' AND column_name='unit_cost';
-- -- Expect: one row.
--
-- -- 3. End-to-end round trip against a test org (edit ids first):
-- --   Given <ITEM> = a wms_catalog.id in <ORG>, and <ORG> = an org UUID:
-- DO $$
-- DECLARE v_item BIGINT := <ITEM>;
--         v_org  UUID   := <ORG>;
--         v_rid  INT;
--         v_before INT;
--         v_after  INT;
--         v_ledger_rows INT;
-- BEGIN
--   SELECT physical_qty INTO v_before FROM wms_inventory
--    WHERE org_id = v_org AND wms_item_id = v_item AND location_id = resolve_wms_main_location(v_org);
--
--   v_rid := receive_wms_stock('TestSup', 'ledger-test', 'tester',
--     ARRAY[v_item::INT], ARRAY[1], ARRAY[10], ARRAY[5.00],
--     NULL, NULL, NULL, NULL, NULL);
--
--   SELECT physical_qty INTO v_after FROM wms_inventory
--    WHERE org_id = v_org AND wms_item_id = v_item AND location_id = resolve_wms_main_location(v_org);
--
--   SELECT COUNT(*) INTO v_ledger_rows FROM stock_movements
--    WHERE org_id = v_org AND ref_table = 'wms_receipts' AND ref_id = v_rid;
--
--   IF v_after - v_before <> 10 THEN
--     RAISE EXCEPTION 'FAIL: qty delta was %, expected 10', v_after - v_before;
--   END IF;
--   IF v_ledger_rows <> 1 THEN
--     RAISE EXCEPTION 'FAIL: ledger row count was %, expected 1', v_ledger_rows;
--   END IF;
--   RAISE NOTICE 'PASS: receive+ledger round trip clean (receipt id %, delta 10)', v_rid;
-- END $$;
