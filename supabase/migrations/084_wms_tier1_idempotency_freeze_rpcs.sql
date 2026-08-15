-- ============================================================
-- 084_wms_tier1_idempotency_freeze_rpcs.sql
--
-- Tier 1 — idempotency + freeze enforcement + RPC rewrites.
--
-- Introduces
--   - wms_rpc_idempotency          dedupe table (24h retention hint)
--   - claim_rpc_idempotency()      helper that returns cached response or claims a new slot
--   - assert_no_active_freeze()    raises stock_count_freeze when any listed item is
--                                  covered by a frozen, unclosed count session
--   - freeze_wms_count_session()   RPC to flip is_frozen TRUE
--   - unfreeze_wms_count_session() RPC to close the session (unfreeze + closed_at)
--
-- Rewrites (drop old signature, create wider one with DEFAULTs so pre-Tier1 callers
-- still work — same compat pattern as submit_sale_batch on migration 072).
--   - receive_wms_stock             (+ p_damage_qtys, p_tax_rates, p_tax_amounts,
--                                    p_idempotency_key)
--   - create_wms_dispatch           (+ p_idempotency_key)
--   - record_wms_adjustment         (+ p_cost_price, p_idempotency_key)
--
-- Freeze check
--   Every mutating RPC calls assert_no_active_freeze() on its wms_item_ids. Old
--   callers (no p_idempotency_key supplied) still get the freeze check — it lives
--   in the shared body, not in a new-caller branch. Hard block, not warn.
--
-- Idempotency
--   Only applied when the client supplies p_idempotency_key. Server-generated
--   keys are NOT stored (defeats the purpose). A replay with the same key returns
--   the cached response (INT receipt_id / dispatch_id / adjustment_id).
--
-- Depends on
--   083 (wms_stock_count_sessions must exist)
--
-- Idempotent. Safe to re-run.
--
-- Record with:
--   node node_modules/supabase/dist/supabase.js migration repair \
--     --status applied 084
-- ============================================================

-- ------------------------------------------------------------
-- 1. Idempotency dedupe table
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wms_rpc_idempotency (
  idempotency_key UUID        NOT NULL,
  org_id          UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  rpc_name        TEXT        NOT NULL,
  response        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (idempotency_key, org_id, rpc_name)
);

CREATE INDEX IF NOT EXISTS idx_wms_rpc_idem_org_created
  ON wms_rpc_idempotency (org_id, created_at DESC);

ALTER TABLE wms_rpc_idempotency ENABLE ROW LEVEL SECURITY;

-- No client policies — SECURITY DEFINER RPCs write; nobody reads directly.

-- ------------------------------------------------------------
-- 2. Idempotency helper
--    Returns cached JSONB response if the key is a replay; NULL if this is
--    the first claim. Insert-first, ON CONFLICT does the lookup.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_rpc_idempotency(
  p_key       UUID,
  p_org_id    UUID,
  p_rpc_name  TEXT
)
RETURNS JSONB    -- NULL => proceed; JSONB => return this to caller
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing JSONB;
BEGIN
  IF p_key IS NULL THEN
    RETURN NULL;   -- No idempotency requested.
  END IF;

  INSERT INTO wms_rpc_idempotency (idempotency_key, org_id, rpc_name)
  VALUES (p_key, p_org_id, p_rpc_name)
  ON CONFLICT (idempotency_key, org_id, rpc_name) DO NOTHING;

  IF FOUND THEN
    RETURN NULL;   -- We claimed the slot; proceed.
  END IF;

  SELECT response INTO v_existing
    FROM wms_rpc_idempotency
   WHERE idempotency_key = p_key AND org_id = p_org_id AND rpc_name = p_rpc_name;

  -- Row exists but response is still NULL: a concurrent caller is in flight.
  -- Treat as a duplicate replay and refuse cleanly.
  IF v_existing IS NULL THEN
    RAISE EXCEPTION 'Duplicate request in flight for idempotency key %', p_key
      USING ERRCODE = '40P01';   -- deadlock-adjacent; distinct signal
  END IF;

  RETURN v_existing;
END;
$$;

CREATE OR REPLACE FUNCTION store_rpc_idempotency_response(
  p_key       UUID,
  p_org_id    UUID,
  p_rpc_name  TEXT,
  p_response  JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_key IS NULL THEN RETURN; END IF;
  UPDATE wms_rpc_idempotency
     SET response = p_response
   WHERE idempotency_key = p_key
     AND org_id = p_org_id
     AND rpc_name = p_rpc_name
     AND response IS NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION claim_rpc_idempotency(UUID, UUID, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION store_rpc_idempotency_response(UUID, UUID, TEXT, JSONB) FROM PUBLIC, anon;
-- Not granted to authenticated; only definer functions call these.

-- ------------------------------------------------------------
-- 3. Freeze-check helper
--    Raises stock_count_freeze if ANY listed item is covered by a
--    frozen, unclosed count session in p_org_id.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_no_active_freeze(
  p_org_id       UUID,
  p_wms_item_ids BIGINT[]
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_blocking_session UUID;
  v_blocking_label   TEXT;
BEGIN
  IF p_wms_item_ids IS NULL OR array_length(p_wms_item_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  SELECT s.id, s.label
    INTO v_blocking_session, v_blocking_label
    FROM wms_stock_count_sessions s
    JOIN wms_stock_counts sc ON sc.session_id = s.id
   WHERE s.org_id    = p_org_id
     AND s.is_frozen = TRUE
     AND s.closed_at IS NULL
     AND sc.wms_item_id = ANY(p_wms_item_ids)
   LIMIT 1;

  IF v_blocking_session IS NOT NULL THEN
    RAISE EXCEPTION
      'Stock movement blocked: item is frozen by count session "%" (%)',
      v_blocking_label, v_blocking_session
      USING ERRCODE = 'P0001',
            HINT    = 'Unfreeze or close the count session before recording stock movement.';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION assert_no_active_freeze(UUID, BIGINT[]) FROM PUBLIC, anon;

-- ------------------------------------------------------------
-- 4. Session freeze / unfreeze RPCs
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION freeze_wms_count_session(
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

  UPDATE wms_stock_count_sessions
     SET is_frozen = TRUE,
         frozen_at = COALESCE(frozen_at, NOW())
   WHERE id = p_session_id
     AND closed_at IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION unfreeze_wms_count_session(
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

  UPDATE wms_stock_count_sessions
     SET is_frozen = FALSE,
         closed_at = CASE WHEN p_close THEN NOW() ELSE closed_at END
   WHERE id = p_session_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION freeze_wms_count_session(UUID)         FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION unfreeze_wms_count_session(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION freeze_wms_count_session(UUID)         TO authenticated;
GRANT  EXECUTE ON FUNCTION unfreeze_wms_count_session(UUID, BOOLEAN) TO authenticated;

-- ============================================================
-- 5. Rewrite receive_wms_stock (wider signature; DEFAULTs on new params)
-- ============================================================
-- Old signature MUST be dropped first — PostgREST cannot choose between
-- overloads once both exist. Same lesson as submit_sale_batch/072.
DROP FUNCTION IF EXISTS public.receive_wms_stock(
  TEXT, TEXT, TEXT, INTEGER[], INTEGER[], INTEGER[], NUMERIC[]
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
  p_idempotency_key UUID      DEFAULT NULL
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
  v_n           INT;
  v_damage      INT;
  v_tax_rate    NUMERIC;
  v_tax_amount  NUMERIC;
  v_cached      JSONB;
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
  IF p_damage_qtys IS NOT NULL AND array_length(p_damage_qtys, 1) <> v_n THEN
    RAISE EXCEPTION 'p_damage_qtys length must match p_wms_item_ids';
  END IF;
  IF p_tax_rates IS NOT NULL AND array_length(p_tax_rates, 1) <> v_n THEN
    RAISE EXCEPTION 'p_tax_rates length must match p_wms_item_ids';
  END IF;
  IF p_tax_amounts IS NOT NULL AND array_length(p_tax_amounts, 1) <> v_n THEN
    RAISE EXCEPTION 'p_tax_amounts length must match p_wms_item_ids';
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
  PERFORM assert_no_active_freeze(v_org_id, p_wms_item_ids::BIGINT[]);

  -- Idempotency check (after all validation, before any write).
  v_cached := claim_rpc_idempotency(p_idempotency_key, v_org_id, 'receive_wms_stock');
  IF v_cached IS NOT NULL THEN
    RETURN (v_cached->>'result')::INTEGER;
  END IF;

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
    v_tax_rate    := CASE WHEN p_tax_rates    IS NULL THEN NULL ELSE p_tax_rates[v_i]   END;
    v_tax_amount  := CASE WHEN p_tax_amounts  IS NULL THEN NULL ELSE p_tax_amounts[v_i] END;

    INSERT INTO wms_receipt_items (
      org_id, receipt_id, wms_item_id, packs, pack_size, total_units, unit_cost,
      line_total, damage_qty, tax_rate, tax_amount
    ) VALUES (
      v_org_id, v_receipt_id, p_wms_item_ids[v_i], p_packs[v_i], p_pack_sizes[v_i],
      v_total_units, p_unit_costs[v_i], v_line_total, v_damage, v_tax_rate, v_tax_amount
    );

    -- Damage does not reach usable stock.
    INSERT INTO wms_inventory (org_id, wms_item_id, physical_qty)
    VALUES (v_org_id, p_wms_item_ids[v_i], v_total_units - v_damage)
    ON CONFLICT (org_id, wms_item_id) DO UPDATE
    SET physical_qty = wms_inventory.physical_qty + EXCLUDED.physical_qty,
        updated_at   = NOW();
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
  INTEGER[], NUMERIC[], NUMERIC[], UUID
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION receive_wms_stock(
  TEXT, TEXT, TEXT, INTEGER[], INTEGER[], INTEGER[], NUMERIC[],
  INTEGER[], NUMERIC[], NUMERIC[], UUID
) TO authenticated;

-- ============================================================
-- 6. Rewrite create_wms_dispatch (add p_idempotency_key)
-- ============================================================
DROP FUNCTION IF EXISTS public.create_wms_dispatch(TEXT, UUID, TEXT, JSONB, TEXT, TEXT);

CREATE OR REPLACE FUNCTION create_wms_dispatch(
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
  v_item_id     BIGINT;
  v_qty         INT;
  v_current_qty INT;
  v_product_id  UUID;
BEGIN
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'At least one dispatch item is required';
  END IF;

  IF p_destination_type NOT IN ('Internal Shop', 'External Client', 'Wholesale') THEN
    RAISE EXCEPTION 'Invalid destination type: %', p_destination_type USING ERRCODE = '22023';
  END IF;

  -- Collect + validate item ids share a single org.
  SELECT ARRAY_AGG((elem->>'wms_item_id')::BIGINT)
    INTO v_item_ids
    FROM jsonb_array_elements(p_items) AS elem;

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
    RAISE EXCEPTION 'Dispatch items span more than one organisation' USING ERRCODE = '42501';
  END IF;

  -- Resolve destination label + validate Internal Shop location.
  IF p_destination_type = 'Internal Shop' THEN
    IF p_destination_location_id IS NULL THEN
      RAISE EXCEPTION 'Internal Shop dispatch requires a destination location' USING ERRCODE = '22023';
    END IF;
    SELECT org_id, name INTO v_loc_org, v_dest_label
      FROM locations
     WHERE id = p_destination_location_id AND active;
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

  INSERT INTO wms_dispatches (
    org_id, destination_type, destination_id, destination_location_id,
    status, notes, created_by
  )
  VALUES (
    v_org_id, p_destination_type, v_dest_label, p_destination_location_id,
    'Dispatched', NULLIF(TRIM(p_notes), ''), p_created_by
  )
  RETURNING id INTO v_dispatch_id;

  FOR item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_item_id := (item->>'wms_item_id')::BIGINT;
    v_qty     := (item->>'qty')::INT;

    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'Quantity must be greater than zero for item %', v_item_id;
    END IF;

    -- Lock inventory row + verify sufficient warehouse stock.
    SELECT physical_qty INTO v_current_qty
      FROM wms_inventory
     WHERE org_id = v_org_id AND wms_item_id = v_item_id
     FOR UPDATE;

    IF v_current_qty IS NULL THEN
      RAISE EXCEPTION 'No inventory record for item %', v_item_id USING ERRCODE = '42501';
    END IF;
    IF v_current_qty < v_qty THEN
      RAISE EXCEPTION 'Insufficient warehouse stock for item %. Available %, requested %',
        v_item_id, v_current_qty, v_qty;
    END IF;

    UPDATE wms_inventory
       SET physical_qty = physical_qty - v_qty,
           updated_at   = NOW()
     WHERE org_id = v_org_id AND wms_item_id = v_item_id;

    INSERT INTO wms_dispatch_items (org_id, dispatch_id, wms_item_id, qty_sent)
    VALUES (v_org_id, v_dispatch_id, v_item_id, v_qty);

    -- Internal-shop bridge: credit destination location's retail stock.
    IF p_destination_type = 'Internal Shop' THEN
      SELECT product_id INTO v_product_id
        FROM wms_catalog
       WHERE id = v_item_id AND org_id = v_org_id;

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

REVOKE EXECUTE ON FUNCTION create_wms_dispatch(TEXT, UUID, TEXT, JSONB, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION create_wms_dispatch(TEXT, UUID, TEXT, JSONB, TEXT, TEXT, UUID) TO authenticated;

-- ============================================================
-- 7. Rewrite record_wms_adjustment (add p_cost_price + p_idempotency_key)
-- ============================================================
DROP FUNCTION IF EXISTS public.record_wms_adjustment(BIGINT, INT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION record_wms_adjustment(
  p_wms_item_id     BIGINT,
  p_adjustment_qty  INT,
  p_reason          TEXT,
  p_notes           TEXT    DEFAULT NULL,
  p_recorded_by     TEXT    DEFAULT NULL,
  p_cost_price      NUMERIC DEFAULT NULL,
  p_idempotency_key UUID    DEFAULT NULL
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
   WHERE org_id = v_org_id AND wms_item_id = p_wms_item_id;

  PERFORM store_rpc_idempotency_response(
    p_idempotency_key, v_org_id, 'record_wms_adjustment',
    jsonb_build_object('result', v_adjustment_id)
  );

  RETURN v_adjustment_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION record_wms_adjustment(BIGINT, INT, TEXT, TEXT, TEXT, NUMERIC, UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION record_wms_adjustment(BIGINT, INT, TEXT, TEXT, TEXT, NUMERIC, UUID) TO authenticated;

-- ============================================================
-- Verification (run manually in SQL Editor after applying)
-- ============================================================
-- -- 1. Only ONE overload should remain for each of the three RPCs:
-- SELECT p.proname, count(*) AS overloads
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname='public'
--    AND p.proname IN ('receive_wms_stock','create_wms_dispatch','record_wms_adjustment')
--  GROUP BY p.proname;
-- -- Expect: three rows, each overloads=1.
--
-- -- 2. Freeze check works (should raise):
-- --  a. INSERT INTO wms_stock_count_sessions(id, org_id, is_frozen) VALUES (
-- --      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', <your-org>, TRUE);
-- --  b. INSERT INTO wms_stock_counts(session_id, wms_item_id, org_id)
-- --      VALUES ('aaaaaaaa-…', <some_item>, <your-org>);
-- --  c. SELECT record_wms_adjustment(<some_item>, 1, 'Correction');
-- --      -- Expect: stock_count_freeze error.
-- --  d. Clean up: DELETE FROM wms_stock_count_sessions WHERE id='aaaaaaaa-…';
--
-- -- 3. Idempotency dedupe:
-- --  a. SELECT record_wms_adjustment(<item>, 1, 'Correction',
-- --                                   NULL, NULL, NULL,
-- --                                   'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
-- --  b. Same call again — must return the SAME id, must NOT create a second row.
