-- ============================================================
-- 092_wms_tier2_warehouse_transfers.sql
--
-- Tier 2 Phase 3 (part 2/2) — warehouse-to-warehouse transfers
-- as a first-class object.
--
-- Scope
-- -----
--   Move stock between two wms_locations within the same org. This
--   is distinct from wms_dispatches (which crosses out of the
--   warehouse to a shop/client/wholesaler). Transfers stay inside
--   the warehouse world.
--
-- Model
-- -----
--   wms_transfers        header per transfer, one src bin → one dst bin
--   wms_transfer_items   qty per item, avg_cost snapshotted at ship
--
-- Lifecycle
--   create_wms_transfer  emits 'transfer_out' ledger at source,
--                        deducts source inventory, sets status
--                        'In Transit'. No separate Draft state
--                        in this migration (matches instant flow
--                        of create_wms_dispatch).
--   receive_wms_transfer emits 'transfer_in' at destination,
--                        upserts destination inventory (moving avg
--                        via _wms_moving_avg from 089), advances
--                        'In Transit' → 'Received'.
--   cancel_wms_transfer  if 'In Transit': refunds source by emitting
--                        a positive-delta 'transfer_in' at source,
--                        upserts source inventory back, advances
--                        'In Transit' → 'Cancelled'. Cancel from
--                        'Received' is refused (would need a
--                        return-transfer instead).
--
-- In-transit visibility
--   wms_inventory_in_transit VIEW aggregates the pending qty per
--   (org, item, source, destination) so dashboards can show units
--   currently moving between bins.
--
-- Idempotent. Safe to re-run.
--
-- Depends on 087 (wms_locations, stock_movements), 088 (wms_inventory
-- with location_id), 089 (moving-avg helper + emit_stock_movement).
--
-- Record with:
--   node node_modules/supabase/dist/supabase.js migration repair \
--     --status applied 092
-- ============================================================

-- ------------------------------------------------------------
-- 1. wms_transfers
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wms_transfers (
  id                  BIGSERIAL PRIMARY KEY,
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_location_id  UUID NOT NULL REFERENCES wms_locations(id) ON DELETE RESTRICT,
  dest_location_id    UUID NOT NULL REFERENCES wms_locations(id) ON DELETE RESTRICT,
  status              TEXT NOT NULL DEFAULT 'In Transit'
                      CHECK (status IN ('In Transit','Received','Cancelled')),
  notes               TEXT,
  created_by          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at        TIMESTAMPTZ,
  CHECK (source_location_id <> dest_location_id)
);

CREATE INDEX IF NOT EXISTS idx_wms_transfers_org             ON wms_transfers(org_id);
CREATE INDEX IF NOT EXISTS idx_wms_transfers_status          ON wms_transfers(org_id, status);
CREATE INDEX IF NOT EXISTS idx_wms_transfers_source          ON wms_transfers(source_location_id);
CREATE INDEX IF NOT EXISTS idx_wms_transfers_dest            ON wms_transfers(dest_location_id);
CREATE INDEX IF NOT EXISTS idx_wms_transfers_org_in_transit  ON wms_transfers(org_id) WHERE status = 'In Transit';

ALTER TABLE wms_transfers ALTER COLUMN org_id SET DEFAULT default_user_org_id();
ALTER TABLE wms_transfers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wms_transfers_org_read" ON wms_transfers;
CREATE POLICY "wms_transfers_org_read" ON wms_transfers FOR SELECT
  USING (org_id IN (SELECT current_user_org_ids()));

-- No client INSERT / UPDATE / DELETE policies — every write flows
-- through the RPCs below.

-- ------------------------------------------------------------
-- 2. wms_transfer_items
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wms_transfer_items (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID   NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  transfer_id   BIGINT NOT NULL REFERENCES wms_transfers(id) ON DELETE RESTRICT,
  wms_item_id   BIGINT NOT NULL REFERENCES wms_catalog(id)   ON DELETE RESTRICT,
  qty           INT    NOT NULL CHECK (qty > 0),
  avg_cost      NUMERIC(12,2)      -- source avg_cost snapshot at ship
);

CREATE INDEX IF NOT EXISTS idx_wms_transfer_items_transfer ON wms_transfer_items(transfer_id);
CREATE INDEX IF NOT EXISTS idx_wms_transfer_items_org      ON wms_transfer_items(org_id);
CREATE INDEX IF NOT EXISTS idx_wms_transfer_items_item     ON wms_transfer_items(wms_item_id);

ALTER TABLE wms_transfer_items ALTER COLUMN org_id SET DEFAULT default_user_org_id();
ALTER TABLE wms_transfer_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wms_transfer_items_org_read" ON wms_transfer_items;
CREATE POLICY "wms_transfer_items_org_read" ON wms_transfer_items FOR SELECT
  USING (org_id IN (SELECT current_user_org_ids()));

-- ------------------------------------------------------------
-- 3. create_wms_transfer
--    items JSONB shape: [{ "wms_item_id": bigint, "qty": int }]
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_wms_transfer(
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

REVOKE EXECUTE ON FUNCTION create_wms_transfer(UUID, UUID, JSONB, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION create_wms_transfer(UUID, UUID, JSONB, TEXT, TEXT, UUID) TO authenticated;

-- ------------------------------------------------------------
-- 4. receive_wms_transfer
--    Adds destination inventory (moving-avg maintained), emits
--    'transfer_in' per item, advances 'In Transit' → 'Received'.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION receive_wms_transfer(
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

REVOKE EXECUTE ON FUNCTION receive_wms_transfer(BIGINT, TEXT, UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION receive_wms_transfer(BIGINT, TEXT, UUID) TO authenticated;

-- ------------------------------------------------------------
-- 5. cancel_wms_transfer
--    From 'In Transit' only. Refunds source, emits 'transfer_in'
--    (positive delta) back to source location, advances to
--    'Cancelled'.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION cancel_wms_transfer(
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

REVOKE EXECUTE ON FUNCTION cancel_wms_transfer(BIGINT, TEXT, UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION cancel_wms_transfer(BIGINT, TEXT, UUID) TO authenticated;

-- ------------------------------------------------------------
-- 6. wms_inventory_in_transit — read-only view of pending transfers.
--    Per (org, item, source, destination), sums units currently
--    In Transit. Enables dashboard "goods in flight" tiles and
--    stops merchants counting the same units twice.
-- ------------------------------------------------------------
DROP VIEW IF EXISTS wms_inventory_in_transit;

CREATE VIEW wms_inventory_in_transit AS
SELECT t.org_id,
       ti.wms_item_id,
       t.source_location_id,
       t.dest_location_id,
       SUM(ti.qty)::INT AS qty_in_transit,
       MIN(t.created_at) AS earliest_departed_at
  FROM wms_transfers t
  JOIN wms_transfer_items ti ON ti.transfer_id = t.id
 WHERE t.status = 'In Transit'
 GROUP BY t.org_id, ti.wms_item_id, t.source_location_id, t.dest_location_id;

-- RLS inherits from wms_transfers + wms_transfer_items (both org-scoped).

-- ============================================================
-- Verification (run manually in SQL Editor after applying)
-- ============================================================
-- -- 1. Tables + RPCs + view exist:
-- SELECT 'wms_transfers',
--        EXISTS (SELECT 1 FROM information_schema.tables
--                 WHERE table_schema='public' AND table_name='wms_transfers')::text UNION ALL
-- SELECT 'wms_transfer_items',
--        EXISTS (SELECT 1 FROM information_schema.tables
--                 WHERE table_schema='public' AND table_name='wms_transfer_items')::text UNION ALL
-- SELECT 'wms_inventory_in_transit view',
--        EXISTS (SELECT 1 FROM information_schema.views
--                 WHERE table_schema='public' AND table_name='wms_inventory_in_transit')::text UNION ALL
-- SELECT 'create_wms_transfer',
--        EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--                 WHERE n.nspname='public' AND p.proname='create_wms_transfer')::text UNION ALL
-- SELECT 'receive_wms_transfer',
--        EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--                 WHERE n.nspname='public' AND p.proname='receive_wms_transfer')::text UNION ALL
-- SELECT 'cancel_wms_transfer',
--        EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--                 WHERE n.nspname='public' AND p.proname='cancel_wms_transfer')::text
--  ORDER BY 1;
-- -- Expect: 6 rows all 'true'.
--
-- -- 2. Grants — anon must have no EXECUTE, authenticated must:
-- SELECT p.proname,
--        has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon,
--        has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth
--   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--  WHERE n.nspname='public'
--    AND p.proname IN ('create_wms_transfer','receive_wms_transfer','cancel_wms_transfer');
-- -- Expect: 3 rows, anon=false, auth=true.
--
-- -- 3. End-to-end round trip (edit <ITEM> and <SECOND_BIN>):
-- --    Requires TWO bins for the org — create a second one first via:
-- --      INSERT INTO wms_locations (org_id, code, label, kind, active)
-- --      VALUES ((SELECT org_id FROM wms_catalog WHERE id=<ITEM>),
-- --              'SHELF-A', 'Shelf A', 'bin', TRUE);
-- DO $$
-- DECLARE v_item BIGINT := <ITEM>;
--         v_org  UUID   := (SELECT org_id FROM wms_catalog WHERE id = v_item);
--         v_src  UUID   := resolve_wms_main_location(v_org);
--         v_dst  UUID   := (SELECT id FROM wms_locations WHERE org_id = v_org AND code = 'SHELF-A');
--         v_tid  BIGINT;
--         v_src_before INT; v_src_after INT;
--         v_dst_before INT; v_dst_after INT;
-- BEGIN
--   IF v_dst IS NULL THEN RAISE EXCEPTION 'Create a SHELF-A location first (see comment above)'; END IF;
--
--   -- Ensure stock at source.
--   PERFORM receive_wms_stock('TestSup','p3-xfer','tester',
--     ARRAY[v_item::INT], ARRAY[1], ARRAY[10], ARRAY[5.00],
--     NULL, NULL, NULL, NULL, v_src, NULL);
--
--   SELECT physical_qty INTO v_src_before FROM wms_inventory
--    WHERE org_id = v_org AND wms_item_id = v_item AND location_id = v_src;
--   SELECT COALESCE(physical_qty, 0) INTO v_dst_before FROM wms_inventory
--    WHERE org_id = v_org AND wms_item_id = v_item AND location_id = v_dst;
--
--   v_tid := create_wms_transfer(v_src, v_dst,
--     jsonb_build_array(jsonb_build_object('wms_item_id', v_item, 'qty', 4)),
--     'p3-xfer-test', 'tester', NULL);
--
--   PERFORM receive_wms_transfer(v_tid, 'tester', NULL);
--
--   SELECT physical_qty INTO v_src_after FROM wms_inventory
--    WHERE org_id = v_org AND wms_item_id = v_item AND location_id = v_src;
--   SELECT COALESCE(physical_qty, 0) INTO v_dst_after FROM wms_inventory
--    WHERE org_id = v_org AND wms_item_id = v_item AND location_id = v_dst;
--
--   IF v_src_after <> v_src_before - 4 THEN
--     RAISE EXCEPTION 'FAIL: source did not shrink by 4 (before=% after=%)', v_src_before, v_src_after;
--   END IF;
--   IF v_dst_after <> v_dst_before + 4 THEN
--     RAISE EXCEPTION 'FAIL: destination did not grow by 4 (before=% after=%)', v_dst_before, v_dst_after;
--   END IF;
--
--   RAISE NOTICE 'PASS: transfer % round trip (source -4, destination +4)', v_tid;
-- END $$;
