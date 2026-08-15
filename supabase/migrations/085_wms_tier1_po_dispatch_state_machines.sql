-- ============================================================
-- 085_wms_tier1_po_dispatch_state_machines.sql
--
-- Tier 1 — PO / dispatch state-machine RPCs + atomic PO creation.
--
-- Adds
--   - create_wms_purchase_order()   atomic header + lines insert
--                                   (replaces two-step client insert)
--   - set_wms_po_status()           enforces explicit PO transitions
--   - set_wms_dispatch_status()     enforces explicit dispatch transitions
--
-- Design
--   Manual status transitions are the only path clients may take. The
--   quantity-driven transitions Sent→Partially Received and Sent/Partially
--   Received→Received continue to happen inside receive_wms_purchase_order
--   as before — this migration explicitly REFUSES manual setting to those
--   two states, so the receipt is the only way in.
--
--   Dispatch transitions are forward-only.
--     Pending → Dispatched → Received
--   No back-transitions, no skips.
--
--   Every accepted transition writes to audit_logs (migration 079). Since
--   audit_logs.entity_id is UUID and both PO/dispatch ids are BIGINT, the
--   numeric id lives in details JSONB and entity_id is left NULL.
--
-- Idempotent. Safe to re-run.
--
-- Depends on 083 (schema), 084 (idempotency helpers).
--
-- Record with:
--   node node_modules/supabase/dist/supabase.js migration repair \
--     --status applied 085
-- ============================================================

-- ------------------------------------------------------------
-- 1. create_wms_purchase_order (atomic)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_wms_purchase_order(
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

REVOKE EXECUTE ON FUNCTION create_wms_purchase_order(TEXT, TEXT, DATE, TEXT, JSONB, TEXT, UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION create_wms_purchase_order(TEXT, TEXT, DATE, TEXT, JSONB, TEXT, UUID) TO authenticated;

-- ------------------------------------------------------------
-- 2. set_wms_po_status
--    Allowed manual transitions:
--      Draft              → Sent | Cancelled
--      Sent               → Cancelled
--      Partially Received → Cancelled
--    REFUSED manually (only receive_wms_purchase_order may set these):
--      * → Partially Received
--      * → Received
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_wms_po_status(
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

REVOKE EXECUTE ON FUNCTION set_wms_po_status(BIGINT, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION set_wms_po_status(BIGINT, TEXT, TEXT, UUID) TO authenticated;

-- ------------------------------------------------------------
-- 3. set_wms_dispatch_status
--    Forward-only:
--      Pending    → Dispatched
--      Dispatched → Received
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
  IF p_next_status NOT IN ('Pending', 'Dispatched', 'Received') THEN
    RAISE EXCEPTION 'Invalid target status %', p_next_status USING ERRCODE = '22023';
  END IF;

  SELECT org_id, status INTO v_org_id, v_current
    FROM wms_dispatches
   WHERE id = p_dispatch_id
   FOR UPDATE;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Dispatch % not found', p_dispatch_id USING ERRCODE = 'P0002';
  END IF;

  PERFORM assert_org_writable(v_org_id);

  v_allowed := (v_current, p_next_status) IN (
    ('Pending',    'Dispatched'),
    ('Dispatched', 'Received')
  );

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Illegal dispatch transition: % → %', v_current, p_next_status
      USING ERRCODE = '22023';
  END IF;

  v_cached := claim_rpc_idempotency(p_idempotency_key, v_org_id, 'set_wms_dispatch_status');
  IF v_cached IS NOT NULL THEN
    RETURN;
  END IF;

  UPDATE wms_dispatches
     SET status = p_next_status
   WHERE id = p_dispatch_id;

  INSERT INTO audit_logs (org_id, actor_user_id, action, entity_table, details)
  VALUES (
    v_org_id,
    auth.uid(),
    'wms_dispatch_status_changed',
    'wms_dispatches',
    jsonb_build_object(
      'id', p_dispatch_id,
      'from_status', v_current,
      'to_status',   p_next_status,
      'actor_label', p_actor
    )
  );

  PERFORM store_rpc_idempotency_response(
    p_idempotency_key, v_org_id, 'set_wms_dispatch_status',
    jsonb_build_object('result', TRUE)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION set_wms_dispatch_status(BIGINT, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION set_wms_dispatch_status(BIGINT, TEXT, TEXT, UUID) TO authenticated;

-- ============================================================
-- Verification (run manually in SQL Editor after applying)
-- ============================================================
-- -- 1. State machines refuse illegal transitions:
-- --   Given a Received PO, calling set_wms_po_status(id,'Draft') must raise
-- --   "Illegal PO transition: Received → Draft".
-- --   Same for calling with 'Received' or 'Partially Received' target:
-- --   must raise "Status … is set by receive_wms_purchase_order only".
-- --
-- -- 2. Dispatch reverse is refused:
-- --   Given a Received dispatch, set_wms_dispatch_status(id,'Dispatched')
-- --   must raise "Illegal dispatch transition: Received → Dispatched".
-- --
-- -- 3. Audit trail:
-- --   Every successful set_* call must append exactly one row to audit_logs
-- --   for that org with action = 'wms_po_status_changed' or
-- --   'wms_dispatch_status_changed' and details.from_status/to_status set.
--
-- -- 4. Grants:
-- SELECT p.proname, has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_exec,
--                    has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname='public'
--    AND p.proname IN ('create_wms_purchase_order','set_wms_po_status','set_wms_dispatch_status');
-- -- anon_exec = FALSE, auth_exec = TRUE for all three.
