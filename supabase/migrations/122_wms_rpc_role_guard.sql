-- ============================================================
-- Migration 122: WMS admin-only RPC guard (Security Phase 2 — RPC layer)
-- Spec: docs/superpowers/specs/2026-09-11-definer-rpc-role-guards-design.md
--
-- Migrations 119-121 gated table-level RLS by role. SECURITY DEFINER RPCs
-- bypass RLS entirely, so a caller reaching data through an RPC instead of
-- a table was unaffected. This migration adds two helper functions and
-- applies the first to every WMS write RPC + record_wms_adjustment — all
-- of which already resolve an org-id variable and already call
-- assert_org_writable() on it once. One line is added next to that
-- existing call in each; no signature changes anywhere in this file.
--
-- No legitimate caller can ever fail the new check: the app UI never lets
-- a cashier reach the WMS module, so this closes a direct-PostgREST-call
-- backdoor only. No frontend deploy required.
--
-- Idempotent. Safe to re-run.
--
-- Apply: Supabase SQL Editor (project pkufxpyrvcygobrgneep), any time —
--   this migration only restricts a path the UI never exercises, so it
--   carries none of the trading-hours risk a table RLS change would.
--
-- PRE-APPLY GATE — read before running this in the SQL Editor:
--   Every function body in this file was built from migration history,
--   not a live query (no DB connection was available while authoring
--   it). Before applying, for each of the 18 guarded RPCs below (every
--   function in this file except assert_org_manager and
--   assert_org_permission, which are new — there is nothing live to diff
--   them against) run
--   SELECT pg_get_functiondef('public.<name>'::regproc);
--   and diff it against the body in this file. The only difference must
--   be the added PERFORM assert_org_manager(...) line. If a live body
--   differs anywhere else, the live definition is authoritative — rebase
--   that one statement on it before applying, the same way migration 035
--   showed migration files can silently drift from what's actually
--   running.
--
-- Record with:
--   node node_modules/supabase/dist/supabase.js migration repair \
--     --status applied 122
-- ============================================================

-- STATEMENT 1: assert_org_manager — raises unless caller is owner/admin.
CREATE OR REPLACE FUNCTION public.assert_org_manager(p_org_id UUID)
RETURNS VOID
LANGUAGE plpgsql STABLE
SET search_path = public
AS $$
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'assert_org_manager: org_id is required' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM current_user_manager_org_ids() m WHERE m = p_org_id
  ) THEN
    RAISE EXCEPTION 'Not authorised: this action requires an owner or manager role'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_org_manager(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assert_org_manager(UUID) TO authenticated;

-- STATEMENT 2: assert_org_permission — owner always; admin unless the
-- named permission key is explicitly false (077's absence-or-not-false
-- rule). Generalises 094's is_wms_adjustment_approver to the caller's own
-- auth.uid() instead of an externally supplied approver id.
CREATE OR REPLACE FUNCTION public.assert_org_permission(p_org_id UUID, p_permission TEXT)
RETURNS VOID
LANGUAGE plpgsql STABLE
SET search_path = public
AS $$
DECLARE
  v_role  TEXT;
  v_perms JSONB;
BEGIN
  SELECT role, permissions INTO v_role, v_perms
    FROM org_members
   WHERE org_id = p_org_id AND user_id = auth.uid();

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Not authorised for this organisation' USING ERRCODE = '42501';
  END IF;

  IF v_role = 'owner' THEN
    RETURN;
  END IF;

  IF v_role = 'admin'
     AND COALESCE((v_perms ->> p_permission)::BOOLEAN IS DISTINCT FROM FALSE, TRUE) THEN
    RETURN;
  END IF;

  RAISE EXCEPTION 'Not authorised: requires the % permission', p_permission
    USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.assert_org_permission(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assert_org_permission(UUID, TEXT) TO authenticated;
-- STATEMENT 3: record_wms_adjustment -- add assert_org_manager next to the
-- existing assert_org_writable call.
CREATE OR REPLACE FUNCTION public.record_wms_adjustment(
  p_wms_item_id     BIGINT,
  p_adjustment_qty  INT,
  p_reason          TEXT,
  p_notes           TEXT    DEFAULT NULL,
  p_recorded_by     TEXT    DEFAULT NULL,
  p_cost_price      NUMERIC DEFAULT NULL,
  p_idempotency_key UUID    DEFAULT NULL,
  p_location_id     UUID    DEFAULT NULL,
  p_approver_user_id UUID   DEFAULT NULL
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
  v_threshold     NUMERIC;
  v_effective_cost NUMERIC;
  v_value         NUMERIC;
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
  PERFORM assert_org_manager(v_org_id);
  PERFORM assert_no_active_freeze(v_org_id, ARRAY[p_wms_item_id]::BIGINT[]);

  v_location_id := COALESCE(p_location_id, resolve_wms_main_location(v_org_id));

  -- ------------------------------------------------------------
  -- Approval gate
  -- ------------------------------------------------------------
  SELECT adjustment_approval_threshold INTO v_threshold
    FROM wms_org_settings WHERE org_id = v_org_id;

  IF v_threshold IS NOT NULL AND v_threshold > 0 THEN
    -- Resolve effective cost: caller-supplied → inventory avg_cost.
    v_effective_cost := p_cost_price;
    IF v_effective_cost IS NULL THEN
      SELECT avg_cost INTO v_effective_cost
        FROM wms_inventory
       WHERE org_id = v_org_id
         AND wms_item_id = p_wms_item_id
         AND location_id = v_location_id;
    END IF;

    IF v_effective_cost IS NOT NULL THEN
      v_value := abs(p_adjustment_qty) * v_effective_cost;

      IF v_value > v_threshold THEN
        IF p_approver_user_id IS NULL THEN
          RAISE EXCEPTION 'Approval required: R% exceeds threshold R%', v_value, v_threshold
            USING ERRCODE = 'P0001',
                  HINT    = 'Have an owner or manager with void permission approve this adjustment.';
        END IF;
        IF NOT is_wms_adjustment_approver(v_org_id, p_approver_user_id) THEN
          RAISE EXCEPTION 'Supplied approver is not authorized to approve WMS adjustments for this org'
            USING ERRCODE = '42501';
        END IF;
      END IF;
    END IF;
    -- If cost is completely unknown (no p_cost_price + no avg_cost),
    -- the threshold is bypassed — value-unknown correction proceeds.
  END IF;

  v_cached := claim_rpc_idempotency(p_idempotency_key, v_org_id, 'record_wms_adjustment');
  IF v_cached IS NOT NULL THEN
    RETURN (v_cached->>'result')::BIGINT;
  END IF;

  INSERT INTO wms_adjustments (
    org_id, wms_item_id, reason, adjustment_qty, notes, recorded_by, cost_price
  ) VALUES (
    v_org_id, p_wms_item_id, p_reason, p_adjustment_qty,
    NULLIF(TRIM(p_notes), ''), p_recorded_by, p_cost_price
  )
  RETURNING id INTO v_adjustment_id;

  UPDATE wms_inventory
     SET physical_qty = GREATEST(physical_qty + p_adjustment_qty, 0),
         updated_at   = NOW()
   WHERE org_id = v_org_id AND wms_item_id = p_wms_item_id AND location_id = v_location_id;

  PERFORM emit_stock_movement(
    v_org_id, p_wms_item_id, v_location_id, p_adjustment_qty, p_cost_price,
    'adjust', 'wms_adjustments', v_adjustment_id, p_reason
  );

  -- Audit the approval (only when it actually gated).
  IF p_approver_user_id IS NOT NULL AND v_threshold IS NOT NULL AND v_effective_cost IS NOT NULL
     AND abs(p_adjustment_qty) * v_effective_cost > v_threshold THEN
    INSERT INTO audit_logs (org_id, actor_user_id, action, entity_table, details)
    VALUES (v_org_id, auth.uid(), 'wms_adjustment_approved', 'wms_adjustments',
            jsonb_build_object(
              'id', v_adjustment_id,
              'approver_user_id', p_approver_user_id,
              'value', abs(p_adjustment_qty) * v_effective_cost,
              'threshold', v_threshold
            ));
  END IF;

  PERFORM store_rpc_idempotency_response(
    p_idempotency_key, v_org_id, 'record_wms_adjustment',
    jsonb_build_object('result', v_adjustment_id)
  );

  RETURN v_adjustment_id;
END;
$$;

-- STATEMENT 4: adjust_wms_inventory -- add assert_org_manager next to the
-- existing assert_org_writable call.
CREATE OR REPLACE FUNCTION public.adjust_wms_inventory(
  p_org_id      UUID,
  p_wms_item_id BIGINT,
  p_adjustment  INT,
  p_reason      TEXT
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_qty INT;
BEGIN
  PERFORM assert_org_writable(p_org_id);
  PERFORM assert_org_manager(p_org_id);

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

-- STATEMENT 5: apply_wms_stock_count -- add assert_org_manager next to the
-- existing assert_org_writable call.
CREATE OR REPLACE FUNCTION public.apply_wms_stock_count(p_session_id UUID)
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
  PERFORM assert_org_manager(v_org_id);

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

-- STATEMENT 6: cancel_wms_transfer -- add assert_org_manager next to the
-- existing assert_org_writable call.
CREATE OR REPLACE FUNCTION public.cancel_wms_transfer(
  p_transfer_id     BIGINT,
  p_actor           TEXT DEFAULT NULL,
  p_idempotency_key UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id     UUID;
  v_status     TEXT;
  v_source_loc UUID;
  v_cached     JSONB;
  it           RECORD;
BEGIN
  SELECT org_id, status, source_location_id
    INTO v_org_id, v_status, v_source_loc
    FROM wms_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Transfer % not found', p_transfer_id USING ERRCODE = 'P0002';
  END IF;
  IF v_status = 'Cancelled' THEN
    RETURN;   -- already cancelled; idempotent
  END IF;
  IF v_status <> 'In Transit' THEN
    RAISE EXCEPTION 'Cannot cancel a transfer in status % — use a return transfer instead', v_status
      USING ERRCODE = '22023';
  END IF;

  PERFORM assert_org_writable(v_org_id);
  PERFORM assert_org_manager(v_org_id);

  v_cached := claim_rpc_idempotency(p_idempotency_key, v_org_id, 'cancel_wms_transfer');
  IF v_cached IS NOT NULL THEN RETURN; END IF;

  FOR it IN
    SELECT wms_item_id, qty, avg_cost
      FROM wms_transfer_items
     WHERE transfer_id = p_transfer_id AND org_id = v_org_id
  LOOP
    -- Refund source bin. No moving-avg recomputation — the cost
    -- basis being returned is the same it left with.
    UPDATE wms_inventory
       SET physical_qty = physical_qty + it.qty,
           updated_at   = NOW()
     WHERE org_id = v_org_id AND wms_item_id = it.wms_item_id AND location_id = v_source_loc;
    -- If the source row was somehow deleted (impossible under
    -- current cascade rules but defensive), re-create it.
    IF NOT FOUND THEN
      INSERT INTO wms_inventory (org_id, wms_item_id, location_id, physical_qty, avg_cost)
      VALUES (v_org_id, it.wms_item_id, v_source_loc, it.qty, it.avg_cost)
      ON CONFLICT (org_id, wms_item_id, location_id) DO UPDATE
      SET physical_qty = wms_inventory.physical_qty + EXCLUDED.physical_qty,
          updated_at   = NOW();
    END IF;

    -- Cancellation ledger: positive-delta 'transfer_in' at source
    -- (accounting-clean — reversal of the original transfer_out).
    PERFORM emit_stock_movement(
      v_org_id, it.wms_item_id, v_source_loc, it.qty, it.avg_cost,
      'transfer_in', 'wms_transfers', p_transfer_id, 'cancel'
    );
  END LOOP;

  UPDATE wms_transfers
     SET status       = 'Cancelled',
         completed_at = NOW()
   WHERE id = p_transfer_id;

  INSERT INTO audit_logs (org_id, actor_user_id, action, entity_table, details)
  VALUES (v_org_id, auth.uid(), 'wms_transfer_cancelled', 'wms_transfers',
          jsonb_build_object('id', p_transfer_id, 'actor_label', p_actor));

  PERFORM store_rpc_idempotency_response(
    p_idempotency_key, v_org_id, 'cancel_wms_transfer',
    jsonb_build_object('result', TRUE)
  );
END;
$$;

-- STATEMENT 7: create_wms_dispatch -- add assert_org_manager next to the
-- existing assert_org_writable call.
CREATE OR REPLACE FUNCTION public.create_wms_dispatch(
  p_destination_type        TEXT,
  p_destination_location_id UUID,
  p_destination_name        TEXT,
  p_items                   JSONB,
  p_notes                   TEXT DEFAULT NULL,
  p_created_by              TEXT DEFAULT NULL,
  p_idempotency_key         UUID DEFAULT NULL,
  p_source_location_id      UUID DEFAULT NULL
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
  PERFORM assert_org_manager(v_org_id);
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

    IF p_destination_type = 'Internal Shop' THEN
      SELECT product_id INTO v_product_id
        FROM wms_catalog WHERE id = v_item_id AND org_id = v_org_id;
      IF v_product_id IS NOT NULL THEN
        PERFORM add_product_stock_at_location(v_product_id, v_qty, p_destination_location_id);

        -- POS cost bridge (mig 095). Recipe items are unaffected — their
        -- recipe_cost_per_unit wins via the COALESCE priority. This write
        -- gives non-recipe warehouse-sourced products a real cost basis.
        IF v_avg_cost IS NOT NULL THEN
          UPDATE products
             SET warehouse_cost_per_unit = v_avg_cost
           WHERE id = v_product_id AND org_id = v_org_id;
        END IF;
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

-- STATEMENT 8: create_wms_dispatch_draft -- add assert_org_manager next to the
-- existing assert_org_writable call.
CREATE OR REPLACE FUNCTION public.create_wms_dispatch_draft(
  p_destination_type        TEXT,
  p_destination_location_id UUID,
  p_destination_name        TEXT,
  p_items                   JSONB,
  p_notes                   TEXT DEFAULT NULL,
  p_created_by              TEXT DEFAULT NULL,
  p_idempotency_key         UUID DEFAULT NULL
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
  v_qty         INT;
BEGIN
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'At least one dispatch item is required';
  END IF;
  IF p_destination_type NOT IN ('Internal Shop','External Client','Wholesale') THEN
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
  PERFORM assert_org_manager(v_org_id);
  -- No freeze check here — draft creates no stock movement. Freeze
  -- gate fires when pick_wms_dispatch actually deducts stock.

  v_cached := claim_rpc_idempotency(p_idempotency_key, v_org_id, 'create_wms_dispatch_draft');
  IF v_cached IS NOT NULL THEN
    RETURN (v_cached->>'result')::BIGINT;
  END IF;

  INSERT INTO wms_dispatches (
    org_id, destination_type, destination_id, destination_location_id,
    status, notes, created_by
  )
  VALUES (
    v_org_id, p_destination_type, v_dest_label, p_destination_location_id,
    'Draft', NULLIF(TRIM(p_notes), ''), p_created_by
  )
  RETURNING id INTO v_dispatch_id;

  FOR item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty := (item->>'qty')::INT;
    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'Quantity must be greater than zero for item %', (item->>'wms_item_id');
    END IF;
    INSERT INTO wms_dispatch_items (org_id, dispatch_id, wms_item_id, qty_sent)
    VALUES (v_org_id, v_dispatch_id, (item->>'wms_item_id')::BIGINT, v_qty);
  END LOOP;

  INSERT INTO audit_logs (org_id, actor_user_id, action, entity_table, details)
  VALUES (v_org_id, auth.uid(), 'wms_dispatch_draft_created', 'wms_dispatches',
          jsonb_build_object('id', v_dispatch_id, 'destination_type', p_destination_type));

  PERFORM store_rpc_idempotency_response(
    p_idempotency_key, v_org_id, 'create_wms_dispatch_draft',
    jsonb_build_object('result', v_dispatch_id)
  );

  RETURN v_dispatch_id;
END;
$$;

-- STATEMENT 9: create_wms_purchase_order -- add assert_org_manager next to the
-- existing assert_org_writable call.
CREATE OR REPLACE FUNCTION public.create_wms_purchase_order(
  p_supplier        TEXT,
  p_po_number       TEXT,
  p_expected_date   DATE,
  p_notes           TEXT,
  p_lines           JSONB,     -- [{wms_item_id, qty_ordered, unit_cost, tax_rate?, tax_amount?}]
  p_created_by      TEXT    DEFAULT NULL,
  p_idempotency_key UUID    DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_po_id      BIGINT;
  v_org_id     UUID;
  v_item_ids   BIGINT[];
  v_cached     JSONB;
  v_line       JSONB;
  v_supplier   TEXT;
  v_po_number  TEXT;
BEGIN
  v_supplier  := NULLIF(TRIM(p_supplier), '');
  v_po_number := NULLIF(TRIM(p_po_number), '');

  IF v_supplier  IS NULL THEN RAISE EXCEPTION 'Supplier is required'  USING ERRCODE = '22023'; END IF;
  IF v_po_number IS NULL THEN RAISE EXCEPTION 'PO number is required' USING ERRCODE = '22023'; END IF;
  IF p_lines IS NULL OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'At least one line is required';
  END IF;

  SELECT ARRAY_AGG((elem->>'wms_item_id')::BIGINT)
    INTO v_item_ids
    FROM jsonb_array_elements(p_lines) AS elem;

  SELECT c.org_id INTO v_org_id
    FROM wms_catalog c
   WHERE c.id = v_item_ids[1];

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Unknown wms_item_id %', v_item_ids[1] USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM wms_catalog c
     WHERE c.id = ANY(v_item_ids) AND c.org_id <> v_org_id
  ) THEN
    RAISE EXCEPTION 'PO lines span more than one organisation' USING ERRCODE = '42501';
  END IF;

  PERFORM assert_org_writable(v_org_id);
  PERFORM assert_org_manager(v_org_id);
  -- No freeze check on PO create — a PO is a plan, not a stock movement.

  v_cached := claim_rpc_idempotency(p_idempotency_key, v_org_id, 'create_wms_purchase_order');
  IF v_cached IS NOT NULL THEN
    RETURN (v_cached->>'result')::BIGINT;
  END IF;

  INSERT INTO wms_purchase_orders (
    org_id, po_number, supplier, expected_date, notes, created_by, status
  ) VALUES (
    v_org_id, v_po_number, v_supplier, p_expected_date,
    NULLIF(TRIM(p_notes), ''), p_created_by, 'Draft'
  )
  RETURNING id INTO v_po_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    INSERT INTO wms_po_items (
      org_id, po_id, wms_item_id, qty_ordered, unit_cost, tax_rate, tax_amount
    ) VALUES (
      v_org_id,
      v_po_id,
      (v_line->>'wms_item_id')::BIGINT,
      (v_line->>'qty_ordered')::INT,
      COALESCE((v_line->>'unit_cost')::NUMERIC, 0),
      CASE WHEN v_line ? 'tax_rate'   THEN (v_line->>'tax_rate'  )::NUMERIC END,
      CASE WHEN v_line ? 'tax_amount' THEN (v_line->>'tax_amount')::NUMERIC END
    );
  END LOOP;

  INSERT INTO audit_logs (org_id, actor_user_id, action, entity_table, details)
  VALUES (
    v_org_id,
    auth.uid(),
    'wms_po_created',
    'wms_purchase_orders',
    jsonb_build_object('id', v_po_id, 'po_number', v_po_number, 'supplier', v_supplier)
  );

  PERFORM store_rpc_idempotency_response(
    p_idempotency_key, v_org_id, 'create_wms_purchase_order',
    jsonb_build_object('result', v_po_id)
  );

  RETURN v_po_id;
END;
$$;

-- STATEMENT 10: create_wms_transfer -- add assert_org_manager next to the
-- existing assert_org_writable call.
CREATE OR REPLACE FUNCTION public.create_wms_transfer(
  p_source_location_id UUID,
  p_dest_location_id   UUID,
  p_items              JSONB,
  p_notes              TEXT DEFAULT NULL,
  p_created_by         TEXT DEFAULT NULL,
  p_idempotency_key    UUID DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_transfer_id BIGINT;
  v_org_id      UUID;
  v_src_org     UUID;
  v_dst_org     UUID;
  v_item_ids    BIGINT[];
  v_cached      JSONB;
  item          JSONB;
  v_item_id     BIGINT;
  v_qty         INT;
  v_current_qty INT;
  v_avg_cost    NUMERIC;
BEGIN
  IF p_source_location_id IS NULL OR p_dest_location_id IS NULL THEN
    RAISE EXCEPTION 'Source and destination locations are both required' USING ERRCODE = '22023';
  END IF;
  IF p_source_location_id = p_dest_location_id THEN
    RAISE EXCEPTION 'Source and destination locations must differ' USING ERRCODE = '22023';
  END IF;
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'At least one transfer item is required';
  END IF;

  SELECT org_id INTO v_src_org FROM wms_locations WHERE id = p_source_location_id;
  SELECT org_id INTO v_dst_org FROM wms_locations WHERE id = p_dest_location_id;
  IF v_src_org IS NULL THEN
    RAISE EXCEPTION 'Source location not found' USING ERRCODE = '42501';
  END IF;
  IF v_dst_org IS NULL THEN
    RAISE EXCEPTION 'Destination location not found' USING ERRCODE = '42501';
  END IF;
  IF v_src_org <> v_dst_org THEN
    RAISE EXCEPTION 'Source and destination belong to different organisations' USING ERRCODE = '42501';
  END IF;
  v_org_id := v_src_org;

  SELECT ARRAY_AGG((elem->>'wms_item_id')::BIGINT) INTO v_item_ids
    FROM jsonb_array_elements(p_items) AS elem;

  IF EXISTS (
    SELECT 1 FROM wms_catalog c WHERE c.id = ANY(v_item_ids) AND c.org_id <> v_org_id
  ) THEN
    RAISE EXCEPTION 'Transfer items span more than one organisation' USING ERRCODE = '42501';
  END IF;

  PERFORM assert_org_writable(v_org_id);
  PERFORM assert_org_manager(v_org_id);
  PERFORM assert_no_active_freeze(v_org_id, v_item_ids);

  v_cached := claim_rpc_idempotency(p_idempotency_key, v_org_id, 'create_wms_transfer');
  IF v_cached IS NOT NULL THEN
    RETURN (v_cached->>'result')::BIGINT;
  END IF;

  INSERT INTO wms_transfers (org_id, source_location_id, dest_location_id, status, notes, created_by)
  VALUES (v_org_id, p_source_location_id, p_dest_location_id, 'In Transit',
          NULLIF(TRIM(p_notes), ''), p_created_by)
  RETURNING id INTO v_transfer_id;

  FOR item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_item_id := (item->>'wms_item_id')::BIGINT;
    v_qty     := (item->>'qty')::INT;
    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'Quantity must be greater than zero for item %', v_item_id;
    END IF;

    -- Lock + verify + deduct source inventory.
    SELECT physical_qty, avg_cost INTO v_current_qty, v_avg_cost
      FROM wms_inventory
     WHERE org_id = v_org_id AND wms_item_id = v_item_id AND location_id = p_source_location_id
     FOR UPDATE;
    IF v_current_qty IS NULL THEN
      RAISE EXCEPTION 'No inventory for item % at source bin', v_item_id USING ERRCODE = '42501';
    END IF;
    IF v_current_qty < v_qty THEN
      RAISE EXCEPTION 'Insufficient stock for item % at source bin. Available %, requested %',
        v_item_id, v_current_qty, v_qty;
    END IF;

    UPDATE wms_inventory
       SET physical_qty = physical_qty - v_qty,
           updated_at   = NOW()
     WHERE org_id = v_org_id AND wms_item_id = v_item_id AND location_id = p_source_location_id;

    INSERT INTO wms_transfer_items (org_id, transfer_id, wms_item_id, qty, avg_cost)
    VALUES (v_org_id, v_transfer_id, v_item_id, v_qty, v_avg_cost);

    PERFORM emit_stock_movement(
      v_org_id, v_item_id, p_source_location_id, -v_qty, v_avg_cost,
      'transfer_out', 'wms_transfers', v_transfer_id, NULL
    );
  END LOOP;

  INSERT INTO audit_logs (org_id, actor_user_id, action, entity_table, details)
  VALUES (v_org_id, auth.uid(), 'wms_transfer_created', 'wms_transfers',
          jsonb_build_object(
            'id', v_transfer_id,
            'source_location_id', p_source_location_id,
            'dest_location_id',   p_dest_location_id
          ));

  PERFORM store_rpc_idempotency_response(
    p_idempotency_key, v_org_id, 'create_wms_transfer',
    jsonb_build_object('result', v_transfer_id)
  );

  RETURN v_transfer_id;
END;
$$;

-- STATEMENT 11: freeze_wms_count_session -- add assert_org_manager next to the
-- existing assert_org_writable call.
CREATE OR REPLACE FUNCTION public.freeze_wms_count_session(
  p_session_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org UUID;
BEGIN
  SELECT org_id INTO v_org FROM wms_stock_count_sessions WHERE id = p_session_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Count session % not found', p_session_id USING ERRCODE = 'P0002';
  END IF;
  PERFORM assert_org_writable(v_org);
  PERFORM assert_org_manager(v_org);

  UPDATE wms_stock_count_sessions
     SET is_frozen = TRUE,
         frozen_at = COALESCE(frozen_at, NOW())
   WHERE id = p_session_id
     AND closed_at IS NULL;
END;
$$;

-- STATEMENT 12: unfreeze_wms_count_session -- add assert_org_manager next to the
-- existing assert_org_writable call.
CREATE OR REPLACE FUNCTION public.unfreeze_wms_count_session(
  p_session_id UUID,
  p_close      BOOLEAN DEFAULT FALSE
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org UUID;
BEGIN
  SELECT org_id INTO v_org FROM wms_stock_count_sessions WHERE id = p_session_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Count session % not found', p_session_id USING ERRCODE = 'P0002';
  END IF;
  PERFORM assert_org_writable(v_org);
  PERFORM assert_org_manager(v_org);

  UPDATE wms_stock_count_sessions
     SET is_frozen = FALSE,
         closed_at = CASE WHEN p_close THEN NOW() ELSE closed_at END
   WHERE id = p_session_id;
END;
$$;

-- STATEMENT 13: pack_wms_dispatch -- add assert_org_manager next to the
-- existing assert_org_writable call.
CREATE OR REPLACE FUNCTION public.pack_wms_dispatch(
  p_dispatch_id     BIGINT,
  p_verifies        JSONB,
  p_actor           TEXT DEFAULT NULL,
  p_idempotency_key UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id       UUID;
  v_status       TEXT;
  v_cached       JSONB;
  v_all_matched  BOOLEAN;
  verify         JSONB;
  v_dispatch_it  BIGINT;
  v_packed_qty   INT;
  v_picked_qty   INT;
BEGIN
  IF p_verifies IS NULL OR jsonb_array_length(p_verifies) = 0 THEN
    RAISE EXCEPTION 'At least one pack verification is required';
  END IF;

  SELECT org_id, status INTO v_org_id, v_status
    FROM wms_dispatches WHERE id = p_dispatch_id FOR UPDATE;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Dispatch % not found', p_dispatch_id USING ERRCODE = 'P0002';
  END IF;
  IF v_status <> 'Picked' THEN
    RAISE EXCEPTION 'Cannot pack a dispatch in status %', v_status USING ERRCODE = '22023';
  END IF;

  PERFORM assert_org_writable(v_org_id);
  PERFORM assert_org_manager(v_org_id);

  v_cached := claim_rpc_idempotency(p_idempotency_key, v_org_id, 'pack_wms_dispatch');
  IF v_cached IS NOT NULL THEN RETURN; END IF;

  FOR verify IN SELECT * FROM jsonb_array_elements(p_verifies) LOOP
    v_dispatch_it := (verify->>'dispatch_item_id')::BIGINT;
    v_packed_qty  := (verify->>'packed_qty')::INT;

    SELECT picked_qty INTO v_picked_qty
      FROM wms_dispatch_items
     WHERE id = v_dispatch_it AND dispatch_id = p_dispatch_id AND org_id = v_org_id
     FOR UPDATE;
    IF v_picked_qty IS NULL THEN
      RAISE EXCEPTION 'dispatch_item % not part of dispatch % or was never picked',
        v_dispatch_it, p_dispatch_id USING ERRCODE = '42501';
    END IF;
    IF v_packed_qty IS NULL OR v_packed_qty <> v_picked_qty THEN
      RAISE EXCEPTION 'packed_qty % does not match picked_qty % on dispatch_item %',
        v_packed_qty, v_picked_qty, v_dispatch_it USING ERRCODE = '22023';
    END IF;

    UPDATE wms_dispatch_items SET packed_qty = v_packed_qty WHERE id = v_dispatch_it;
  END LOOP;

  -- Every picked line must have a matching packed verification.
  SELECT bool_and(packed_qty IS NOT NULL) INTO v_all_matched
    FROM wms_dispatch_items
   WHERE dispatch_id = p_dispatch_id AND picked_qty IS NOT NULL;

  IF NOT v_all_matched THEN
    RAISE EXCEPTION 'Not every picked line has been packed — pack all lines in one call' USING ERRCODE = '22023';
  END IF;

  UPDATE wms_dispatches SET status = 'Packed' WHERE id = p_dispatch_id;

  INSERT INTO audit_logs (org_id, actor_user_id, action, entity_table, details)
  VALUES (v_org_id, auth.uid(), 'wms_dispatch_packed', 'wms_dispatches',
          jsonb_build_object('id', p_dispatch_id, 'actor_label', p_actor));

  PERFORM store_rpc_idempotency_response(
    p_idempotency_key, v_org_id, 'pack_wms_dispatch',
    jsonb_build_object('result', TRUE)
  );
END;
$$;

-- STATEMENT 14: pick_wms_dispatch -- add assert_org_manager next to the
-- existing assert_org_writable call.
CREATE OR REPLACE FUNCTION public.pick_wms_dispatch(
  p_dispatch_id     BIGINT,
  p_picks           JSONB,
  p_actor           TEXT DEFAULT NULL,
  p_idempotency_key UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id       UUID;
  v_status       TEXT;
  v_cached       JSONB;
  v_item_ids     BIGINT[];
  pick           JSONB;
  v_dispatch_it  BIGINT;
  v_picked_qty   INT;
  v_from_loc     UUID;
  v_qty_sent     INT;
  v_wms_item     BIGINT;
  v_current_qty  INT;
  v_avg_cost     NUMERIC;
BEGIN
  IF p_picks IS NULL OR jsonb_array_length(p_picks) = 0 THEN
    RAISE EXCEPTION 'At least one pick is required';
  END IF;

  SELECT org_id, status INTO v_org_id, v_status
    FROM wms_dispatches WHERE id = p_dispatch_id FOR UPDATE;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Dispatch % not found', p_dispatch_id USING ERRCODE = 'P0002';
  END IF;
  IF v_status <> 'Draft' THEN
    RAISE EXCEPTION 'Cannot pick a dispatch in status %', v_status USING ERRCODE = '22023';
  END IF;

  PERFORM assert_org_writable(v_org_id);
  PERFORM assert_org_manager(v_org_id);

  -- Collect wms_item_ids covered by the picks for the freeze check.
  SELECT ARRAY_AGG(DISTINCT di.wms_item_id)
    INTO v_item_ids
    FROM wms_dispatch_items di
    JOIN jsonb_array_elements(p_picks) AS p(elem)
      ON di.id = (p.elem->>'dispatch_item_id')::BIGINT
   WHERE di.dispatch_id = p_dispatch_id;

  PERFORM assert_no_active_freeze(v_org_id, v_item_ids);

  v_cached := claim_rpc_idempotency(p_idempotency_key, v_org_id, 'pick_wms_dispatch');
  IF v_cached IS NOT NULL THEN RETURN; END IF;

  FOR pick IN SELECT * FROM jsonb_array_elements(p_picks) LOOP
    v_dispatch_it := (pick->>'dispatch_item_id')::BIGINT;
    v_picked_qty  := (pick->>'picked_qty')::INT;
    v_from_loc    := NULLIF(pick->>'from_location_id','')::UUID;
    IF v_from_loc IS NULL THEN
      v_from_loc := resolve_wms_main_location(v_org_id);
    END IF;

    IF v_picked_qty IS NULL OR v_picked_qty <= 0 THEN
      RAISE EXCEPTION 'picked_qty must be > 0 for dispatch_item %', v_dispatch_it;
    END IF;

    -- Line must belong to this dispatch and this org.
    SELECT wms_item_id, qty_sent
      INTO v_wms_item, v_qty_sent
      FROM wms_dispatch_items
     WHERE id = v_dispatch_it AND dispatch_id = p_dispatch_id AND org_id = v_org_id
     FOR UPDATE;
    IF v_wms_item IS NULL THEN
      RAISE EXCEPTION 'dispatch_item % not part of dispatch %', v_dispatch_it, p_dispatch_id USING ERRCODE = '42501';
    END IF;
    IF v_picked_qty > v_qty_sent THEN
      RAISE EXCEPTION 'picked_qty % exceeds qty_sent % on dispatch_item %', v_picked_qty, v_qty_sent, v_dispatch_it;
    END IF;

    -- Lock + verify + deduct source-bin inventory.
    SELECT physical_qty, avg_cost INTO v_current_qty, v_avg_cost
      FROM wms_inventory
     WHERE org_id = v_org_id AND wms_item_id = v_wms_item AND location_id = v_from_loc
     FOR UPDATE;
    IF v_current_qty IS NULL THEN
      RAISE EXCEPTION 'No inventory for item % at source bin', v_wms_item USING ERRCODE = '42501';
    END IF;
    IF v_current_qty < v_picked_qty THEN
      RAISE EXCEPTION 'Insufficient warehouse stock for item % at source bin. Available %, requested %',
        v_wms_item, v_current_qty, v_picked_qty;
    END IF;

    UPDATE wms_inventory
       SET physical_qty = physical_qty - v_picked_qty,
           updated_at   = NOW()
     WHERE org_id = v_org_id AND wms_item_id = v_wms_item AND location_id = v_from_loc;

    UPDATE wms_dispatch_items
       SET picked_qty = v_picked_qty,
           unit_cost  = v_avg_cost   -- snapshot cost at pick time
     WHERE id = v_dispatch_it;

    PERFORM emit_stock_movement(
      v_org_id, v_wms_item, v_from_loc, -v_picked_qty, v_avg_cost,
      'dispatch', 'wms_dispatches', p_dispatch_id, 'pick'
    );
  END LOOP;

  UPDATE wms_dispatches SET status = 'Picked' WHERE id = p_dispatch_id;

  INSERT INTO audit_logs (org_id, actor_user_id, action, entity_table, details)
  VALUES (v_org_id, auth.uid(), 'wms_dispatch_picked', 'wms_dispatches',
          jsonb_build_object('id', p_dispatch_id, 'actor_label', p_actor));

  PERFORM store_rpc_idempotency_response(
    p_idempotency_key, v_org_id, 'pick_wms_dispatch',
    jsonb_build_object('result', TRUE)
  );
END;
$$;

-- STATEMENT 15: ship_wms_dispatch -- add assert_org_manager next to the
-- existing assert_org_writable call.
CREATE OR REPLACE FUNCTION public.ship_wms_dispatch(
  p_dispatch_id     BIGINT,
  p_carrier_ref     TEXT DEFAULT NULL,
  p_actor           TEXT DEFAULT NULL,
  p_idempotency_key UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id        UUID;
  v_status        TEXT;
  v_dest_type     TEXT;
  v_dest_loc      UUID;
  v_cached        JSONB;
  it              RECORD;
  v_product_id    UUID;
BEGIN
  SELECT org_id, status, destination_type, destination_location_id
    INTO v_org_id, v_status, v_dest_type, v_dest_loc
    FROM wms_dispatches WHERE id = p_dispatch_id FOR UPDATE;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Dispatch % not found', p_dispatch_id USING ERRCODE = 'P0002';
  END IF;
  IF v_status <> 'Packed' THEN
    RAISE EXCEPTION 'Cannot ship a dispatch in status %', v_status USING ERRCODE = '22023';
  END IF;

  PERFORM assert_org_writable(v_org_id);
  PERFORM assert_org_manager(v_org_id);

  v_cached := claim_rpc_idempotency(p_idempotency_key, v_org_id, 'ship_wms_dispatch');
  IF v_cached IS NOT NULL THEN RETURN; END IF;

  IF v_dest_type = 'Internal Shop' THEN
    FOR it IN
      SELECT di.wms_item_id, di.packed_qty, di.unit_cost
        FROM wms_dispatch_items di
       WHERE di.dispatch_id = p_dispatch_id AND di.packed_qty IS NOT NULL AND di.packed_qty > 0
    LOOP
      SELECT product_id INTO v_product_id
        FROM wms_catalog WHERE id = it.wms_item_id AND org_id = v_org_id;
      IF v_product_id IS NOT NULL THEN
        PERFORM add_product_stock_at_location(v_product_id, it.packed_qty, v_dest_loc);

        -- POS cost bridge (mig 095). di.unit_cost was snapshotted at
        -- pick time from wms_inventory.avg_cost, so it's the cost basis
        -- of the units actually being shipped.
        IF it.unit_cost IS NOT NULL THEN
          UPDATE products
             SET warehouse_cost_per_unit = it.unit_cost
           WHERE id = v_product_id AND org_id = v_org_id;
        END IF;
      END IF;
    END LOOP;
  END IF;

  UPDATE wms_dispatches
     SET status      = 'Shipped',
         carrier_ref = COALESCE(NULLIF(TRIM(p_carrier_ref), ''), carrier_ref)
   WHERE id = p_dispatch_id;

  INSERT INTO audit_logs (org_id, actor_user_id, action, entity_table, details)
  VALUES (v_org_id, auth.uid(), 'wms_dispatch_shipped', 'wms_dispatches',
          jsonb_build_object(
            'id', p_dispatch_id, 'carrier_ref', p_carrier_ref, 'actor_label', p_actor
          ));

  PERFORM store_rpc_idempotency_response(
    p_idempotency_key, v_org_id, 'ship_wms_dispatch',
    jsonb_build_object('result', TRUE)
  );
END;
$$;

-- STATEMENT 16: receive_wms_purchase_order -- add assert_org_manager next to the
-- existing assert_org_writable call.
CREATE OR REPLACE FUNCTION public.receive_wms_purchase_order(
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
  PERFORM assert_org_manager(v_org_id);

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

-- STATEMENT 17: receive_wms_stock -- add assert_org_manager next to the
-- existing assert_org_writable call.
CREATE OR REPLACE FUNCTION public.receive_wms_stock(
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
  PERFORM assert_org_manager(v_org_id);
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

-- STATEMENT 18: receive_wms_transfer -- add assert_org_manager next to the
-- existing assert_org_writable call.
CREATE OR REPLACE FUNCTION public.receive_wms_transfer(
  p_transfer_id     BIGINT,
  p_actor           TEXT DEFAULT NULL,
  p_idempotency_key UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id      UUID;
  v_status      TEXT;
  v_source_loc  UUID;
  v_dest_loc    UUID;
  v_cached      JSONB;
  it            RECORD;
  v_old_qty     INT;
  v_old_avg     NUMERIC;
  v_new_avg     NUMERIC;
BEGIN
  SELECT org_id, status, source_location_id, dest_location_id
    INTO v_org_id, v_status, v_source_loc, v_dest_loc
    FROM wms_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Transfer % not found', p_transfer_id USING ERRCODE = 'P0002';
  END IF;
  IF v_status <> 'In Transit' THEN
    RAISE EXCEPTION 'Cannot receive a transfer in status %', v_status USING ERRCODE = '22023';
  END IF;

  PERFORM assert_org_writable(v_org_id);
  PERFORM assert_org_manager(v_org_id);

  -- Freeze check: destination bin's items must not be frozen.
  PERFORM assert_no_active_freeze(v_org_id,
    (SELECT ARRAY_AGG(DISTINCT wms_item_id) FROM wms_transfer_items WHERE transfer_id = p_transfer_id));

  v_cached := claim_rpc_idempotency(p_idempotency_key, v_org_id, 'receive_wms_transfer');
  IF v_cached IS NOT NULL THEN RETURN; END IF;

  FOR it IN
    SELECT wms_item_id, qty, avg_cost
      FROM wms_transfer_items
     WHERE transfer_id = p_transfer_id AND org_id = v_org_id
  LOOP
    -- Lock destination row for moving-avg computation.
    SELECT physical_qty, avg_cost INTO v_old_qty, v_old_avg
      FROM wms_inventory
     WHERE org_id = v_org_id AND wms_item_id = it.wms_item_id AND location_id = v_dest_loc
     FOR UPDATE;

    v_new_avg := _wms_moving_avg(COALESCE(v_old_qty, 0), v_old_avg, it.qty, it.avg_cost);

    INSERT INTO wms_inventory (org_id, wms_item_id, location_id, physical_qty, avg_cost)
    VALUES (v_org_id, it.wms_item_id, v_dest_loc, it.qty, v_new_avg)
    ON CONFLICT (org_id, wms_item_id, location_id) DO UPDATE
    SET physical_qty = wms_inventory.physical_qty + EXCLUDED.physical_qty,
        avg_cost     = v_new_avg,
        updated_at   = NOW();

    PERFORM emit_stock_movement(
      v_org_id, it.wms_item_id, v_dest_loc, it.qty, it.avg_cost,
      'transfer_in', 'wms_transfers', p_transfer_id, NULL
    );
  END LOOP;

  UPDATE wms_transfers
     SET status       = 'Received',
         completed_at = NOW()
   WHERE id = p_transfer_id;

  INSERT INTO audit_logs (org_id, actor_user_id, action, entity_table, details)
  VALUES (v_org_id, auth.uid(), 'wms_transfer_received', 'wms_transfers',
          jsonb_build_object('id', p_transfer_id, 'actor_label', p_actor));

  PERFORM store_rpc_idempotency_response(
    p_idempotency_key, v_org_id, 'receive_wms_transfer',
    jsonb_build_object('result', TRUE)
  );
END;
$$;

-- STATEMENT 19: set_wms_dispatch_status -- add assert_org_manager next to the
-- existing assert_org_writable call.
CREATE OR REPLACE FUNCTION public.set_wms_dispatch_status(
  p_dispatch_id     BIGINT,
  p_next_status     TEXT,
  p_actor           TEXT DEFAULT NULL,
  p_idempotency_key UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id  UUID;
  v_current TEXT;
  v_allowed BOOLEAN;
  v_cached  JSONB;
BEGIN
  IF p_next_status NOT IN (
    'Pending','Dispatched','Received','Cancelled',
    'Draft','Picked','Packed','Shipped'
  ) THEN
    RAISE EXCEPTION 'Invalid target status %', p_next_status USING ERRCODE = '22023';
  END IF;

  SELECT org_id, status INTO v_org_id, v_current
    FROM wms_dispatches WHERE id = p_dispatch_id FOR UPDATE;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Dispatch % not found', p_dispatch_id USING ERRCODE = 'P0002';
  END IF;

  PERFORM assert_org_writable(v_org_id);
  PERFORM assert_org_manager(v_org_id);

  -- Allowed transitions:
  --   instant path:     Pending→Dispatched, Dispatched→Received
  --   pick/pack/ship:   Shipped→Received (Draft/Picked/Packed advance via dedicated RPCs)
  --   cancel:           Draft→Cancelled only (mid-flow cancel deferred to Phase 4)
  --
  -- pick_wms_dispatch, pack_wms_dispatch, ship_wms_dispatch each
  -- perform their own status flip; they do NOT go through this RPC.
  v_allowed := (v_current, p_next_status) IN (
    ('Pending',    'Dispatched'),
    ('Dispatched', 'Received'),
    ('Shipped',    'Received'),
    ('Draft',      'Cancelled')
  );

  IF NOT v_allowed THEN
    IF v_current IN ('Picked','Packed','Shipped') AND p_next_status = 'Cancelled' THEN
      RAISE EXCEPTION 'Cancel from % is not implemented — requires stock refund + POS uncredit path (Phase 4)', v_current
        USING ERRCODE = '0A000';   -- feature_not_supported
    END IF;
    RAISE EXCEPTION 'Illegal dispatch transition: % → %', v_current, p_next_status USING ERRCODE = '22023';
  END IF;

  v_cached := claim_rpc_idempotency(p_idempotency_key, v_org_id, 'set_wms_dispatch_status');
  IF v_cached IS NOT NULL THEN RETURN; END IF;

  UPDATE wms_dispatches SET status = p_next_status WHERE id = p_dispatch_id;

  INSERT INTO audit_logs (org_id, actor_user_id, action, entity_table, details)
  VALUES (v_org_id, auth.uid(), 'wms_dispatch_status_changed', 'wms_dispatches',
          jsonb_build_object(
            'id', p_dispatch_id, 'from_status', v_current, 'to_status', p_next_status,
            'actor_label', p_actor
          ));

  PERFORM store_rpc_idempotency_response(
    p_idempotency_key, v_org_id, 'set_wms_dispatch_status',
    jsonb_build_object('result', TRUE)
  );
END;
$$;

-- STATEMENT 20: set_wms_po_status -- add assert_org_manager next to the
-- existing assert_org_writable call.
CREATE OR REPLACE FUNCTION public.set_wms_po_status(
  p_po_id           BIGINT,
  p_next_status     TEXT,
  p_actor           TEXT DEFAULT NULL,
  p_idempotency_key UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id      UUID;
  v_current     TEXT;
  v_allowed     BOOLEAN;
  v_cached      JSONB;
BEGIN
  IF p_next_status IN ('Partially Received', 'Received') THEN
    RAISE EXCEPTION 'Status "%" is set by receive_wms_purchase_order only', p_next_status
      USING ERRCODE = '22023',
            HINT    = 'Record a receipt against this PO instead of setting the status directly.';
  END IF;

  IF p_next_status NOT IN ('Draft', 'Sent', 'Cancelled') THEN
    RAISE EXCEPTION 'Invalid target status %', p_next_status USING ERRCODE = '22023';
  END IF;

  SELECT org_id, status INTO v_org_id, v_current
    FROM wms_purchase_orders
   WHERE id = p_po_id
   FOR UPDATE;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Purchase order % not found', p_po_id USING ERRCODE = 'P0002';
  END IF;

  PERFORM assert_org_writable(v_org_id);
  PERFORM assert_org_manager(v_org_id);

  v_allowed := (v_current, p_next_status) IN (
    ('Draft',              'Sent'),
    ('Draft',              'Cancelled'),
    ('Sent',               'Cancelled'),
    ('Partially Received', 'Cancelled')
  );

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Illegal PO transition: % → %', v_current, p_next_status
      USING ERRCODE = '22023';
  END IF;

  v_cached := claim_rpc_idempotency(p_idempotency_key, v_org_id, 'set_wms_po_status');
  IF v_cached IS NOT NULL THEN
    RETURN;   -- Already applied.
  END IF;

  UPDATE wms_purchase_orders
     SET status     = p_next_status,
         updated_at = NOW()
   WHERE id = p_po_id;

  INSERT INTO audit_logs (org_id, actor_user_id, action, entity_table, details)
  VALUES (
    v_org_id,
    auth.uid(),
    'wms_po_status_changed',
    'wms_purchase_orders',
    jsonb_build_object(
      'id', p_po_id,
      'from_status', v_current,
      'to_status',   p_next_status,
      'actor_label', p_actor
    )
  );

  PERFORM store_rpc_idempotency_response(
    p_idempotency_key, v_org_id, 'set_wms_po_status',
    jsonb_build_object('result', TRUE)
  );
END;
$$;
