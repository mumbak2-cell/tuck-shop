-- ============================================================
-- Migration 040: Authorization guards on the remaining SECURITY DEFINER RPCs
--
-- Migration 039 guarded submit_sale_batch and adjust_customer_balance.
-- This completes the sweep over every SECURITY DEFINER function that
-- mutates tenant data, and fixes the grant hygiene underneath them.
--
-- The grant problem: no migration in this repo has ever issued a REVOKE,
-- so every function here retained PostgreSQL's default EXECUTE-to-PUBLIC.
-- Only submit_sale_batch was ever explicitly granted. PUBLIC includes the
-- `anon` role, so several of these were callable without signing in at all.
--
-- The authorization problem: each took a caller-supplied id and never
-- asked who was calling, so any caller could name another org's product,
-- ingredient, or warehouse item and mutate that org's stock.
--
-- Functions changed, and how the org is derived:
--
--   deduct_stock                    products.org_id
--   add_product_stock               products.org_id
--   add_ingredient_stock            ingredients.org_id
--   deduct_stock_at_location        products.org_id (+ location must match)
--   add_product_stock_at_location   products.org_id (+ location must match)
--   adjust_wms_inventory            p_org_id argument
--   apply_wms_stock_count           wms_stock_counts.org_id for the session
--   receive_wms_stock               wms_catalog.org_id for the line items
--   process_tilify_dispatch         p_org_id argument
--   transfer_stock                  products.org_id (already authorized;
--                                   gains only the subscription gate)
--
-- Deliberately NOT guarded:
--   create_organization_for_user  — must work for a user who has no org yet
--   current_user_org_ids, current_user_writable_org_ids,
--   current_user_location_ids, default_user_org_id, is_platform_admin
--                                 — read-only helpers used inside RLS
--                                   policies; guarding them would recurse
--   generate_inventory_id         — pure, mutates nothing
--
-- CORRECTION to the note left at the foot of migration 039: transfer_stock
-- was described there as one of the sharpest unguarded functions. That was
-- wrong. It already called auth.uid() and required an owner/admin
-- org_members row. It was missing only the trial/subscription gate, added
-- below. Conversely, 039's list omitted legacy `deduct_stock`, which was
-- genuinely unguarded. It is included here.
--
-- BEHAVIOUR CHANGE: all ten now enforce the subscription gate via
-- assert_org_writable(). An org whose trial has lapsed can no longer adjust
-- stock, receive stock, or transfer between locations. This is the intent —
-- migration 018 always meant to gate these tables, and the RPCs were the
-- hole. Extend any live customer's lapsed trial before running this.
--
-- Blast radius at time of writing: wms_catalog, wms_inventory,
-- wms_receipts, wms_dispatches, wms_stock_counts and ingredients are all
-- EMPTY in production. Only the product_stock paths
-- (deduct_stock_at_location, add_product_stock_at_location, transfer_stock)
-- touch live data.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Retail stock, whole-org (legacy, pre-locations)
--
--    Both write products.opening_stock, which the sync_product_opening_stock
--    trigger recomputes from SUM(product_stock.quantity). They are kept only
--    for the single-location code paths that predate migration 024.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION deduct_stock(
  p_product_id UUID,
  p_quantity   INT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id UUID;
BEGIN
  SELECT org_id INTO v_org_id FROM products WHERE id = p_product_id;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Product % not found', p_product_id USING ERRCODE = '42501';
  END IF;
  PERFORM assert_org_writable(v_org_id);

  UPDATE products
     SET opening_stock = GREATEST(opening_stock - p_quantity, 0)
   WHERE id = p_product_id;
END;
$$;

CREATE OR REPLACE FUNCTION add_product_stock(
  p_product_id UUID,
  p_quantity   INT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id UUID;
BEGIN
  SELECT org_id INTO v_org_id FROM products WHERE id = p_product_id;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Product % not found', p_product_id USING ERRCODE = '42501';
  END IF;
  PERFORM assert_org_writable(v_org_id);

  UPDATE products
     SET opening_stock = opening_stock + p_quantity
   WHERE id = p_product_id;
END;
$$;

CREATE OR REPLACE FUNCTION add_ingredient_stock(
  p_ingredient_id UUID,
  p_quantity      DECIMAL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id UUID;
BEGIN
  SELECT org_id INTO v_org_id FROM ingredients WHERE id = p_ingredient_id;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Ingredient % not found', p_ingredient_id USING ERRCODE = '42501';
  END IF;
  PERFORM assert_org_writable(v_org_id);

  UPDATE ingredients
     SET current_stock = current_stock + p_quantity
   WHERE id = p_ingredient_id;
END;
$$;

-- ------------------------------------------------------------
-- 2. Retail stock, per location (migration 024). These are the live paths:
--    deduct_stock_at_location is called by submit_sale_batch on every sale
--    line, and add_product_stock_at_location by CSV import and receive-stock.
--
--    Called from inside submit_sale_batch, which is itself SECURITY DEFINER.
--    auth.uid() reads the request JWT rather than the SQL role, so the guard
--    still identifies the cashier there, and passes for a writable org.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION deduct_stock_at_location(
  p_product_id  UUID,
  p_quantity    INTEGER,
  p_location_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id UUID;
BEGIN
  SELECT org_id INTO v_org_id FROM products WHERE id = p_product_id;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Product % not found', p_product_id USING ERRCODE = '42501';
  END IF;
  PERFORM assert_org_writable(v_org_id);

  IF NOT EXISTS (
    SELECT 1 FROM locations WHERE id = p_location_id AND org_id = v_org_id
  ) THEN
    RAISE EXCEPTION 'Location does not belong to this organisation'
      USING ERRCODE = '42501';
  END IF;

  -- Ensure a row exists so we can decrement it
  INSERT INTO product_stock (product_id, location_id, quantity, org_id)
  VALUES (p_product_id, p_location_id, 0, v_org_id)
  ON CONFLICT (product_id, location_id) DO NOTHING;

  UPDATE product_stock
     SET quantity = GREATEST(quantity - p_quantity, 0),
         last_updated = NOW()
   WHERE product_id = p_product_id AND location_id = p_location_id;
END;
$$;

CREATE OR REPLACE FUNCTION add_product_stock_at_location(
  p_product_id  UUID,
  p_quantity    INTEGER,
  p_location_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id UUID;
BEGIN
  SELECT org_id INTO v_org_id FROM products WHERE id = p_product_id;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Product % not found', p_product_id USING ERRCODE = '42501';
  END IF;
  PERFORM assert_org_writable(v_org_id);

  IF NOT EXISTS (
    SELECT 1 FROM locations WHERE id = p_location_id AND org_id = v_org_id
  ) THEN
    RAISE EXCEPTION 'Location does not belong to this organisation'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO product_stock (product_id, location_id, quantity, org_id)
  VALUES (p_product_id, p_location_id, p_quantity, v_org_id)
  ON CONFLICT (product_id, location_id) DO UPDATE
  SET quantity = product_stock.quantity + EXCLUDED.quantity,
      last_updated = NOW();
END;
$$;

-- ------------------------------------------------------------
-- 3. transfer_stock — body unchanged from migration 036 except for the
--    single assert_org_writable() call. It already authenticated the caller
--    and required an owner/admin membership; it did not honour the trial
--    and subscription gate.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION transfer_stock(
  p_product_id       UUID,
  p_from_location_id UUID,
  p_to_location_id   UUID,
  p_quantity         INTEGER,
  p_notes            TEXT DEFAULT NULL,
  p_transferred_by   TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller      UUID;
  v_org_id      UUID;
  v_available   INTEGER;
  v_transfer_id UUID;
  v_caller_role TEXT;
BEGIN
  v_caller := auth.uid();
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity must be greater than zero';
  END IF;
  IF p_from_location_id = p_to_location_id THEN
    RAISE EXCEPTION 'Source and destination must differ';
  END IF;

  SELECT org_id INTO v_org_id FROM products WHERE id = p_product_id;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Product not found';
  END IF;

  SELECT role INTO v_caller_role
  FROM org_members
  WHERE user_id = v_caller AND org_id = v_org_id;
  IF v_caller_role IS NULL THEN
    RAISE EXCEPTION 'You are not a member of this organisation';
  END IF;
  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only owners and admins can transfer stock';
  END IF;

  -- >>> Added in 040: honour the trial / subscription gate.
  PERFORM assert_org_writable(v_org_id);

  IF NOT EXISTS (
    SELECT 1 FROM locations WHERE id = p_from_location_id AND org_id = v_org_id AND active
  ) THEN
    RAISE EXCEPTION 'Source location is not in this organisation or is inactive';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM locations WHERE id = p_to_location_id AND org_id = v_org_id AND active
  ) THEN
    RAISE EXCEPTION 'Destination location is not in this organisation or is inactive';
  END IF;

  SELECT COALESCE(quantity, 0) INTO v_available
  FROM product_stock
  WHERE product_id = p_product_id AND location_id = p_from_location_id
  FOR UPDATE;

  IF v_available IS NULL OR v_available < p_quantity THEN
    RAISE EXCEPTION 'Insufficient stock at source: only % available, % requested',
      COALESCE(v_available, 0), p_quantity;
  END IF;

  UPDATE product_stock
     SET quantity = quantity - p_quantity, last_updated = NOW()
   WHERE product_id = p_product_id AND location_id = p_from_location_id;

  INSERT INTO product_stock (org_id, product_id, location_id, quantity)
  VALUES (v_org_id, p_product_id, p_to_location_id, p_quantity)
  ON CONFLICT (product_id, location_id) DO UPDATE
  SET quantity = product_stock.quantity + EXCLUDED.quantity,
      last_updated = NOW();

  INSERT INTO stock_transfers (
    org_id, product_id, from_location_id, to_location_id,
    quantity, notes, transferred_by
  ) VALUES (
    v_org_id, p_product_id, p_from_location_id, p_to_location_id,
    p_quantity, NULLIF(TRIM(p_notes), ''), p_transferred_by
  )
  RETURNING id INTO v_transfer_id;

  RETURN v_transfer_id;
END;
$$;

-- ------------------------------------------------------------
-- 4. Warehouse (WMS). All currently empty in production.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION adjust_wms_inventory(
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

-- The session id is the only argument, so derive the org from its rows and
-- refuse a session that somehow spans more than one.
CREATE OR REPLACE FUNCTION apply_wms_stock_count(
  p_session_id UUID
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count   INT := 0;
  v_org_id  UUID;
  v_orgs    INT;
  r         RECORD;
BEGIN
  -- No MIN()/MAX() aggregate exists for uuid in Postgres, so count first and
  -- pick the single org with a separate LIMIT 1 read.
  SELECT COUNT(DISTINCT org_id) INTO v_orgs
    FROM wms_stock_counts
   WHERE session_id = p_session_id;

  IF v_orgs = 0 THEN
    RAISE EXCEPTION 'Stock count session % not found', p_session_id USING ERRCODE = '42501';
  END IF;
  IF v_orgs > 1 THEN
    RAISE EXCEPTION 'Stock count session % spans more than one organisation', p_session_id;
  END IF;

  SELECT org_id INTO v_org_id
    FROM wms_stock_counts
   WHERE session_id = p_session_id
   LIMIT 1;

  PERFORM assert_org_writable(v_org_id);

  FOR r IN
    SELECT wms_item_id, counted_qty, org_id
    FROM wms_stock_counts
    WHERE session_id = p_session_id
  LOOP
    UPDATE wms_inventory
       SET physical_qty = r.counted_qty,
           updated_at = NOW()
     WHERE wms_item_id = r.wms_item_id
       AND org_id = r.org_id;

    UPDATE wms_catalog
       SET last_counted_at = NOW()
     WHERE id = r.wms_item_id
       AND org_id = r.org_id;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

-- receive_wms_stock took no org at all: it relied on the org_id column
-- DEFAULT for its inserts, and updated wms_inventory by wms_item_id with no
-- org predicate. Now the org is derived from the catalog rows being received,
-- every insert states it explicitly, and the inventory update is org-scoped.
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

  -- Every catalog item must exist and share one org. Counts DISTINCT ids so a
  -- duplicated id in the request cannot mask a missing one. No MIN()/MAX()
  -- aggregate exists for uuid in Postgres, so the org is read separately.
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

    UPDATE wms_inventory
       SET physical_qty = physical_qty + v_total_units,
           updated_at = NOW()
     WHERE wms_item_id = p_wms_item_ids[v_i]
       AND org_id = v_org_id;
  END LOOP;

  RETURN v_receipt_id;
END;
$$;

-- process_tilify_dispatch already scoped every statement by p_org_id, so it
-- could not reach across orgs. It simply never checked that the caller
-- belonged to p_org_id, nor that the org could write.
CREATE OR REPLACE FUNCTION process_tilify_dispatch(
  p_org_id         UUID,
  p_destination_id TEXT,
  p_items          JSONB,
  p_notes          TEXT DEFAULT NULL,
  p_created_by     TEXT DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dispatch_id BIGINT;
  item          JSONB;
  v_current_qty INT;
  v_qty         INT;
  v_sku         TEXT;
BEGIN
  PERFORM assert_org_writable(p_org_id);

  INSERT INTO wms_dispatches (org_id, destination_type, destination_id, status, notes, created_by)
  VALUES (p_org_id, 'Internal Shop', p_destination_id, 'Dispatched', p_notes, p_created_by)
  RETURNING id INTO v_dispatch_id;

  FOR item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_qty := (item->>'qty')::int;

    SELECT physical_qty INTO v_current_qty
    FROM wms_inventory
    WHERE org_id = p_org_id
      AND wms_item_id = (item->>'wms_item_id')::bigint
    FOR UPDATE;

    IF v_current_qty IS NULL THEN
      RAISE EXCEPTION 'WMS inventory row not found for item %', (item->>'wms_item_id');
    END IF;

    IF v_current_qty < v_qty THEN
      RAISE EXCEPTION 'Insufficient warehouse stock for item %. Available: %, Requested: %',
        (item->>'wms_item_id'), v_current_qty, v_qty;
    END IF;

    UPDATE wms_inventory
       SET physical_qty = physical_qty - v_qty,
           updated_at = NOW()
     WHERE org_id = p_org_id
       AND wms_item_id = (item->>'wms_item_id')::bigint;

    INSERT INTO wms_dispatch_items (org_id, dispatch_id, wms_item_id, qty_sent)
    VALUES (p_org_id, v_dispatch_id, (item->>'wms_item_id')::bigint, v_qty);

    SELECT sku INTO v_sku
    FROM wms_catalog
    WHERE id = (item->>'wms_item_id')::bigint
      AND org_id = p_org_id;

    IF v_sku IS NOT NULL THEN
      UPDATE products
         SET opening_stock = opening_stock + v_qty
       WHERE org_id = p_org_id
         AND inventory_id = v_sku;
    END IF;
  END LOOP;

  RETURN v_dispatch_id;
END;
$$;

-- ------------------------------------------------------------
-- 5. Grant hygiene.
--
--    Strip the implicit EXECUTE-to-PUBLIC (which includes `anon`) and hand
--    it back to `authenticated` only. The guards above are the real defence;
--    this stops an unauthenticated caller from even reaching them.
--
--    Functions invoked from inside other SECURITY DEFINER functions — e.g.
--    deduct_stock_at_location, called by submit_sale_batch — keep working,
--    because there the current role is the function owner, not the caller.
-- ------------------------------------------------------------
DO $$
DECLARE
  sig TEXT;
  sigs TEXT[] := ARRAY[
    'deduct_stock(UUID, INT)',
    'add_product_stock(UUID, INT)',
    'add_ingredient_stock(UUID, DECIMAL)',
    'deduct_stock_at_location(UUID, INTEGER, UUID)',
    'add_product_stock_at_location(UUID, INTEGER, UUID)',
    'transfer_stock(UUID, UUID, UUID, INTEGER, TEXT, TEXT)',
    'adjust_wms_inventory(UUID, BIGINT, INT, TEXT)',
    'apply_wms_stock_count(UUID)',
    'receive_wms_stock(TEXT, TEXT, TEXT, INTEGER[], INTEGER[], INTEGER[], NUMERIC[])',
    'process_tilify_dispatch(UUID, TEXT, JSONB, TEXT, TEXT)',
    -- 039's pair, which were never revoked from PUBLIC either
    'adjust_customer_balance(UUID, NUMERIC)',
    'assert_org_writable(UUID)'
  ];
BEGIN
  FOREACH sig IN ARRAY sigs LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', sig);
  END LOOP;
END $$;

-- submit_sale_batch was explicitly granted in 034; revoke PUBLIC from it too.
REVOKE ALL ON FUNCTION submit_sale_batch(
  UUID[], UUID, UUID, UUID[], INTEGER[], NUMERIC[], NUMERIC[],
  TEXT, TEXT, UUID, DATE, TIMESTAMPTZ, NUMERIC[]
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION submit_sale_batch(
  UUID[], UUID, UUID, UUID[], INTEGER[], NUMERIC[], NUMERIC[],
  TEXT, TEXT, UUID, DATE, TIMESTAMPTZ, NUMERIC[]
) TO authenticated;

COMMIT;


-- ============================================================
-- VERIFY (run separately, after commit)
--
-- 1. No mutating RPC should still be executable by PUBLIC or anon:
--
--   SELECT p.proname, p.prosecdef AS security_definer,
--          coalesce(array_to_string(p.proacl, ', '), 'DEFAULT (PUBLIC!)') AS acl
--   FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public'
--     AND p.proname IN ('deduct_stock','add_product_stock','add_ingredient_stock',
--       'deduct_stock_at_location','add_product_stock_at_location','transfer_stock',
--       'adjust_wms_inventory','apply_wms_stock_count','receive_wms_stock',
--       'process_tilify_dispatch','submit_sale_batch','adjust_customer_balance')
--   ORDER BY 1;
--
--   Every acl should mention `authenticated=X` and must NOT start with `=X/`
--   (a leading `=X` is the PUBLIC grant).
--
-- 2. Every one should have prosecdef = true and a pinned search_path:
--
--   SELECT proname, proconfig FROM pg_proc
--   WHERE pronamespace = 'public'::regnamespace
--     AND proname IN (...) AND proconfig IS NULL;   -- expect zero rows
--
-- 3. The real test is from the app, as a cashier on a writable org:
--    complete a sale (submit_sale_batch -> deduct_stock_at_location),
--    receive stock, and transfer between two locations. All must succeed.
-- ============================================================
