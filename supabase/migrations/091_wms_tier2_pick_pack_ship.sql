-- ============================================================
-- 091_wms_tier2_pick_pack_ship.sql
--
-- Tier 2 Phase 3 (part 1/2) — pick / pack / ship state machine.
--
-- Adds a full-fidelity dispatch workflow ALONGSIDE the existing
-- instant-dispatch path. Merchants opt in by using the new
-- create_wms_dispatch_draft RPC; those who don't touch it continue
-- to use create_wms_dispatch and see zero behaviour change.
--
-- Instant flow (unchanged since Tier 1)
--     Pending → Dispatched → Received
-- Pick/pack/ship flow (new)
--     Draft → Picked → Packed → Shipped → Received
-- Cancelled is reachable from Draft only in this migration. Picked /
-- Packed / Shipped cancellation requires stock-refund + POS-uncredit
-- logic that will land as a scoped migration (Phase 4) — cancelling
-- from those states raises 'refund path not implemented'.
--
-- What each state means
--   Draft    — dispatch header + items created; NO stock deducted.
--              Warehouse quantity is untouched. The dispatch is a
--              picking plan, nothing more.
--   Picked   — pick_wms_dispatch locks + deducts warehouse inventory
--              per line, sets wms_dispatch_items.picked_qty, emits
--              a 'dispatch' ledger row per item. Freeze check applies.
--   Packed   — pack_wms_dispatch verifies packed_qty per line matches
--              picked_qty. No stock movement.
--   Shipped  — ship_wms_dispatch finalizes. For Internal Shop, this
--              is where the POS product_stock credit fires (matches
--              the instant flow's timing of the same bridge).
--              carrier_ref optional.
--   Received — set_wms_dispatch_status transition; already handled
--              by 085.
--
-- Additions
--   - wms_dispatches.carrier_ref             TEXT nullable
--   - wms_dispatch_items.picked_qty          INT nullable
--   - wms_dispatch_items.packed_qty          INT nullable
--   - wms_dispatches.status CHECK expanded to include the new states
--   - set_wms_dispatch_status updated with the new transition table
--   - RPCs: create_wms_dispatch_draft, pick_wms_dispatch,
--           pack_wms_dispatch, ship_wms_dispatch
--
-- Idempotent. Safe to re-run.
--
-- Depends on 083 (audit_logs reuse), 084 (freeze + idempotency),
-- 085 (set_wms_dispatch_status), 087-089 (ledger + bins + moving avg).
--
-- Record with:
--   node node_modules/supabase/dist/supabase.js migration repair \
--     --status applied 091
-- ============================================================

-- ------------------------------------------------------------
-- 1. Schema additions
-- ------------------------------------------------------------
ALTER TABLE wms_dispatches
  ADD COLUMN IF NOT EXISTS carrier_ref TEXT;

ALTER TABLE wms_dispatch_items
  ADD COLUMN IF NOT EXISTS picked_qty INT,
  ADD COLUMN IF NOT EXISTS packed_qty INT;

-- Expand the status CHECK to cover the new lifecycle. Old rows keep
-- their existing values ('Pending' | 'Dispatched' | 'Received'), which
-- remain valid under the new CHECK.
--
-- Postgres normalizes CHECK(col IN (...)) to CHECK(col = ANY(ARRAY[...]))
-- in pg_get_constraintdef, so an ILIKE '%status IN%' scan misses the
-- original. Drop by the auto-generated name directly instead — Postgres
-- names an inline column CHECK as <table>_<column>_check.
ALTER TABLE wms_dispatches
  DROP CONSTRAINT IF EXISTS wms_dispatches_status_check;

-- Also sweep any historically differently-named CHECK on this column
-- (defensive; a fresh install has only the default name).
DO $$
DECLARE v_cn TEXT;
BEGIN
  FOR v_cn IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'public.wms_dispatches'::regclass
       AND contype  = 'c'
       AND pg_get_constraintdef(oid) ~* '\mstatus\M'
  LOOP
    EXECUTE format('ALTER TABLE wms_dispatches DROP CONSTRAINT %I', v_cn);
  END LOOP;
END $$;

ALTER TABLE wms_dispatches
  ADD CONSTRAINT wms_dispatches_status_check
  CHECK (status IN (
    'Pending','Dispatched','Received','Cancelled',
    'Draft','Picked','Packed','Shipped'
  ));

-- ------------------------------------------------------------
-- 2. set_wms_dispatch_status — expanded transition table.
--    Instant + pick/pack/ship + narrow cancel path.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_wms_dispatch_status(
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

REVOKE EXECUTE ON FUNCTION set_wms_dispatch_status(BIGINT, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION set_wms_dispatch_status(BIGINT, TEXT, TEXT, UUID) TO authenticated;

-- ============================================================
-- 3. create_wms_dispatch_draft
--    Same params as create_wms_dispatch but inserts at Draft with no
--    stock deduction, no ledger row. The dispatch is a plan; pick
--    materializes it.
-- ============================================================
CREATE OR REPLACE FUNCTION create_wms_dispatch_draft(
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

REVOKE EXECUTE ON FUNCTION create_wms_dispatch_draft(TEXT, UUID, TEXT, JSONB, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION create_wms_dispatch_draft(TEXT, UUID, TEXT, JSONB, TEXT, TEXT, UUID) TO authenticated;

-- ============================================================
-- 4. pick_wms_dispatch
--    Sets picked_qty per line, deducts warehouse inventory, emits
--    ledger. Draft → Picked.
--
--    picks JSONB shape:
--      [{ "dispatch_item_id": bigint, "picked_qty": int,
--         "from_location_id": uuid? }]
--    from_location_id defaults to MAIN if omitted.
-- ============================================================
CREATE OR REPLACE FUNCTION pick_wms_dispatch(
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

REVOKE EXECUTE ON FUNCTION pick_wms_dispatch(BIGINT, JSONB, TEXT, UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION pick_wms_dispatch(BIGINT, JSONB, TEXT, UUID) TO authenticated;

-- ============================================================
-- 5. pack_wms_dispatch
--    Verifies packed_qty per line matches picked_qty; no stock
--    movement. Picked → Packed.
--
--    verifies JSONB shape:
--      [{ "dispatch_item_id": bigint, "packed_qty": int }]
-- ============================================================
CREATE OR REPLACE FUNCTION pack_wms_dispatch(
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

REVOKE EXECUTE ON FUNCTION pack_wms_dispatch(BIGINT, JSONB, TEXT, UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION pack_wms_dispatch(BIGINT, JSONB, TEXT, UUID) TO authenticated;

-- ============================================================
-- 6. ship_wms_dispatch
--    Records carrier_ref, fires POS bridge for Internal Shop,
--    advances Packed → Shipped.
-- ============================================================
CREATE OR REPLACE FUNCTION ship_wms_dispatch(
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

  v_cached := claim_rpc_idempotency(p_idempotency_key, v_org_id, 'ship_wms_dispatch');
  IF v_cached IS NOT NULL THEN RETURN; END IF;

  -- Internal Shop bridge — same timing as instant flow (right when
  -- the goods leave the warehouse for the destination shop).
  IF v_dest_type = 'Internal Shop' THEN
    FOR it IN
      SELECT di.wms_item_id, di.packed_qty
        FROM wms_dispatch_items di
       WHERE di.dispatch_id = p_dispatch_id AND di.packed_qty IS NOT NULL AND di.packed_qty > 0
    LOOP
      SELECT product_id INTO v_product_id
        FROM wms_catalog WHERE id = it.wms_item_id AND org_id = v_org_id;
      IF v_product_id IS NOT NULL THEN
        PERFORM add_product_stock_at_location(v_product_id, it.packed_qty, v_dest_loc);
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

REVOKE EXECUTE ON FUNCTION ship_wms_dispatch(BIGINT, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION ship_wms_dispatch(BIGINT, TEXT, TEXT, UUID) TO authenticated;

-- ============================================================
-- Verification (run manually in SQL Editor after applying)
-- ============================================================
-- -- 1. Schema + new RPCs:
-- SELECT 'wms_dispatches.carrier_ref',
--        EXISTS (SELECT 1 FROM information_schema.columns
--                 WHERE table_schema='public' AND table_name='wms_dispatches' AND column_name='carrier_ref')::text UNION ALL
-- SELECT 'wms_dispatch_items.picked_qty',
--        EXISTS (SELECT 1 FROM information_schema.columns
--                 WHERE table_schema='public' AND table_name='wms_dispatch_items' AND column_name='picked_qty')::text UNION ALL
-- SELECT 'wms_dispatch_items.packed_qty',
--        EXISTS (SELECT 1 FROM information_schema.columns
--                 WHERE table_schema='public' AND table_name='wms_dispatch_items' AND column_name='packed_qty')::text UNION ALL
-- SELECT 'status check accepts Draft',
--        (SELECT pg_get_constraintdef(oid) ILIKE '%Draft%'
--           FROM pg_constraint WHERE conname='wms_dispatches_status_check')::text UNION ALL
-- SELECT 'create_wms_dispatch_draft exists',
--        EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--                 WHERE n.nspname='public' AND p.proname='create_wms_dispatch_draft')::text UNION ALL
-- SELECT 'pick_wms_dispatch exists',
--        EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--                 WHERE n.nspname='public' AND p.proname='pick_wms_dispatch')::text UNION ALL
-- SELECT 'pack_wms_dispatch exists',
--        EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--                 WHERE n.nspname='public' AND p.proname='pack_wms_dispatch')::text UNION ALL
-- SELECT 'ship_wms_dispatch exists',
--        EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--                 WHERE n.nspname='public' AND p.proname='ship_wms_dispatch')::text
--  ORDER BY 1;
-- -- Expect: 8 rows all 'true'.
--
-- -- 2. Grants correct on new RPCs:
-- SELECT p.proname,
--        has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon,
--        has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth
--   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--  WHERE n.nspname='public'
--    AND p.proname IN ('create_wms_dispatch_draft','pick_wms_dispatch','pack_wms_dispatch','ship_wms_dispatch');
-- -- Expect: 4 rows, anon=false, auth=true for each.
--
-- -- 3. End-to-end round trip (edit <ITEM> to a wms_catalog.id in your org):
-- DO $$
-- DECLARE v_item BIGINT := <ITEM>;
--         v_org  UUID   := (SELECT org_id FROM wms_catalog WHERE id = v_item);
--         v_did  BIGINT;
--         v_di   BIGINT;
--         v_before INT;
--         v_after  INT;
-- BEGIN
--   -- Ensure some stock at MAIN.
--   PERFORM receive_wms_stock('TestSup','p3-test','tester',
--     ARRAY[v_item::INT], ARRAY[1], ARRAY[10], ARRAY[5.00],
--     NULL, NULL, NULL, NULL, NULL, NULL);
--
--   SELECT physical_qty INTO v_before FROM wms_inventory
--    WHERE org_id = v_org AND wms_item_id = v_item AND location_id = resolve_wms_main_location(v_org);
--
--   v_did := create_wms_dispatch_draft(
--     'External Client', NULL, 'PhaseThreeCo',
--     jsonb_build_array(jsonb_build_object('wms_item_id', v_item, 'qty', 3)),
--     'p3-e2e', 'tester', NULL);
--
--   SELECT physical_qty INTO v_after FROM wms_inventory
--    WHERE org_id = v_org AND wms_item_id = v_item AND location_id = resolve_wms_main_location(v_org);
--   IF v_after <> v_before THEN RAISE EXCEPTION 'FAIL: draft moved stock'; END IF;
--
--   SELECT id INTO v_di FROM wms_dispatch_items WHERE dispatch_id = v_did LIMIT 1;
--
--   PERFORM pick_wms_dispatch(v_did,
--     jsonb_build_array(jsonb_build_object('dispatch_item_id', v_di, 'picked_qty', 3)),
--     'tester', NULL);
--   SELECT physical_qty INTO v_after FROM wms_inventory
--    WHERE org_id = v_org AND wms_item_id = v_item AND location_id = resolve_wms_main_location(v_org);
--   IF v_after <> v_before - 3 THEN RAISE EXCEPTION 'FAIL: pick did not deduct 3 (before=% after=%)', v_before, v_after; END IF;
--
--   PERFORM pack_wms_dispatch(v_did,
--     jsonb_build_array(jsonb_build_object('dispatch_item_id', v_di, 'packed_qty', 3)),
--     'tester', NULL);
--
--   PERFORM ship_wms_dispatch(v_did, 'REF123', 'tester', NULL);
--
--   PERFORM set_wms_dispatch_status(v_did, 'Received', 'tester', NULL);
--
--   RAISE NOTICE 'PASS: Draft→Picked→Packed→Shipped→Received round trip clean (dispatch %)', v_did;
-- END $$;
