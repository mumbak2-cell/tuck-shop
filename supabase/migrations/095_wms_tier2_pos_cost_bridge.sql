-- ============================================================
-- 095_wms_tier2_pos_cost_bridge.sql
--
-- Tier 2 Phase 4 (part 3/3) — POS cost bridge.
--
-- Problem
-- -------
-- Warehouse dispatches to internal shops credit stock at the shop
-- location, but do not update the product's cost basis. Every
-- warehouse-sourced item therefore reaches the till at whatever cost
-- products.cost_per_unit was already computing — recipe cost (recipes)
-- or package_price / qty_in_pack (pack-based). Neither reflects what
-- the warehouse actually paid to move the goods in.
--
-- Bridge
-- ------
--   1. products.warehouse_cost_per_unit NUMERIC(12,4) new column.
--      Written only by WMS dispatch RPCs; read only via the generated
--      cost_per_unit fallback.
--   2. products.cost_per_unit's generated formula gains a middle
--      layer:  COALESCE(recipe_cost_per_unit,
--                       warehouse_cost_per_unit,
--                       package_price / qty_in_pack)
--   3. create_wms_dispatch (instant flow) and ship_wms_dispatch
--      (pick/pack/ship flow) both call
--        UPDATE products SET warehouse_cost_per_unit = <avg_cost>
--         WHERE id = <mapped product_id> AND org_id = <org>
--      after the existing add_product_stock_at_location bridge.
--      Recipes still WIN via the COALESCE priority — writing the
--      warehouse cost is safe even for recipe items, it just has no
--      visible effect until the recipe is removed.
--
-- Priority order (highest wins in the COALESCE)
--   recipe_cost_per_unit    — merchant-authored recipe (mig 055)
--   warehouse_cost_per_unit — moving-avg from WMS dispatch (this mig)
--   package_price/qty       — pack maths on the product itself
--
-- Ripple check
-- ------------
-- Only migration 001 and 055 define products.cost_per_unit; no view,
-- policy, index, or function references it (grep 2026-08-16). Safe to
-- DROP + re-ADD the generated column — the value is recomputed on the
-- fly for every existing row.
--
-- Idempotent. Safe to re-run.
--
-- Depends on 087-089 (bins, avg_cost, create_wms_dispatch),
-- 091 (ship_wms_dispatch).
--
-- Record with:
--   node node_modules/supabase/dist/supabase.js migration repair \
--     --status applied 095
-- ============================================================

-- ------------------------------------------------------------
-- 1. Add warehouse_cost_per_unit
-- ------------------------------------------------------------
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS warehouse_cost_per_unit NUMERIC(12,4);

COMMENT ON COLUMN products.warehouse_cost_per_unit IS
  'Moving-average cost per unit written by WMS dispatch RPCs on Internal Shop delivery. Read via the generated cost_per_unit fallback. Never write directly from the app — write via the WMS layer.';

-- ------------------------------------------------------------
-- 2. Rewrite cost_per_unit's generated formula.
--    DROP + ADD, mirroring migration 055's pattern (the expression
--    of a generated column cannot be altered in place).
-- ------------------------------------------------------------
ALTER TABLE products DROP COLUMN IF EXISTS cost_per_unit;

ALTER TABLE products
  ADD COLUMN cost_per_unit NUMERIC(12,4) GENERATED ALWAYS AS (
    COALESCE(
      recipe_cost_per_unit,
      warehouse_cost_per_unit,
      CASE WHEN qty_in_pack > 0 THEN package_price / qty_in_pack ELSE NULL END
    )
  ) STORED;

COMMENT ON COLUMN products.cost_per_unit IS
  'Effective cost per unit. Reads recipe cost first (mig 055), then warehouse-avg cost from WMS (mig 095), then package_price/qty. Never write directly — generated column.';

-- ------------------------------------------------------------
-- 3. Update create_wms_dispatch (instant flow) — Internal Shop
--    bridge now writes warehouse_cost_per_unit alongside crediting
--    per-location stock. Same signature; CREATE OR REPLACE keeps ACL.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_wms_dispatch(
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

-- ------------------------------------------------------------
-- 4. Update ship_wms_dispatch (pick/pack/ship flow) — same bridge.
-- ------------------------------------------------------------
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

-- ============================================================
-- Verification (run manually in SQL Editor after applying)
-- ============================================================
-- -- 1. warehouse_cost_per_unit column present + cost_per_unit formula updated:
-- SELECT column_name, data_type, generation_expression
--   FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='products'
--    AND column_name IN ('warehouse_cost_per_unit','cost_per_unit')
--  ORDER BY column_name;
-- -- Expect: two rows. cost_per_unit's generation_expression must
-- --         mention warehouse_cost_per_unit.
--
-- -- 2. Pattern proof — pick a non-recipe product with a WMS-linked catalog:
-- --   SELECT id, cost_per_unit, warehouse_cost_per_unit, recipe_cost_per_unit,
-- --          package_price, qty_in_pack
-- --     FROM products WHERE id = '<PRODUCT-UUID>';
-- --   Before dispatch: warehouse_cost_per_unit IS NULL, cost_per_unit ==
-- --     package_price / qty_in_pack.
-- --   After an Internal Shop dispatch: warehouse_cost_per_unit populated,
-- --     cost_per_unit == warehouse_cost_per_unit.
--
-- -- 3. Priority proof — for a RECIPE product:
-- --   recipe_cost_per_unit still wins; setting warehouse_cost_per_unit
-- --   changes nothing visible in cost_per_unit.
--
-- -- 4. RPCs still one overload each:
-- SELECT p.proname, COUNT(*) AS overloads
--   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--  WHERE n.nspname='public' AND p.proname IN ('create_wms_dispatch','ship_wms_dispatch')
--  GROUP BY p.proname;
-- -- Expect: 2 rows, each overloads=1.
