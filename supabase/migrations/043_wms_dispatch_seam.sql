-- ============================================================
-- Migration 043: WMS ↔ POS dispatch seam
--
-- Makes the internal-shop dispatch the single, explicit, location-aware
-- integration point between the warehouse (WMS) and retail (POS) layers,
-- and replaces the broken implicit bridge that shipped in 0231/040.
--
-- What was wrong before:
--   - process_tilify_dispatch credited products.opening_stock directly, but
--     that column is a trigger-derived cache of SUM(product_stock.quantity)
--     (migration 024). POS reads product_stock PER LOCATION, so dispatched
--     stock never became sellable at the destination shop and the write was
--     overwritten by sync_product_opening_stock on the next stock change.
--   - The destination was free text (destination_id), so there was no way to
--     know which branch to credit.
--   - Retail was matched by the fragile string equality
--     wms_catalog.sku = products.inventory_id.
--   - The dispatch page called it with p_org_id => NULL, so every internal
--     dispatch raised in assert_org_writable and failed outright.
--   - External / wholesale dispatch bypassed RPCs entirely with non-atomic,
--     racy client-side writes that skipped the subscription gate and could
--     drive physical_qty negative.
--
-- What this migration does:
--   1. Adds wms_catalog.product_id      — explicit warehouse→retail link.
--   2. Adds wms_dispatches.destination_location_id — the branch a dispatch
--      targets, with a CHECK tying it to the 'Internal Shop' type.
--   3. Adds a CHECK so warehouse stock can never go negative.
--   4. Replaces the dispatch RPC with create_wms_dispatch, which handles
--      every destination type in ONE transaction, derives the org from the
--      catalog items (no caller-supplied org), and — for internal shops —
--      credits the destination location's product_stock via the audited
--      add_product_stock_at_location RPC (which keeps opening_stock correct
--      through the existing trigger).
--   5. Drops process_tilify_dispatch and fixes grant hygiene.
--
-- Blast radius: all wms_* tables are EMPTY in production (see 040), so the
-- new CHECK constraints and the backfill below touch no live rows.
--
-- Unit contract: 1 warehouse unit == 1 retail sellable unit. physical_qty is
-- already stored in individual units (receive_wms_stock expands packs into
-- total_units), so qty flows 1:1 into product_stock. If a different
-- granularity is ever needed, promote the link to a table with a conversion
-- factor rather than fudging it here.
--
-- After applying by hand, record it:
--   node node_modules/supabase/dist/supabase.js migration repair --status applied 043
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Explicit warehouse-item → retail-product link.
--    Nullable: warehouse-only items (bulk / wholesale-only) have no link and
--    simply skip the retail step on dispatch.
-- ------------------------------------------------------------
ALTER TABLE wms_catalog
  ADD COLUMN product_id UUID REFERENCES products(id) ON DELETE SET NULL;

CREATE INDEX idx_wms_catalog_product ON wms_catalog(product_id);

-- One-time backfill from the old implicit contract, only where a product in
-- the SAME org has a matching inventory_id (so it can never link across orgs).
UPDATE wms_catalog c
   SET product_id = p.id
  FROM products p
 WHERE p.org_id = c.org_id
   AND p.inventory_id = c.sku
   AND c.product_id IS NULL;

-- ------------------------------------------------------------
-- 2. Location target on dispatch headers.
--    Internal Shop  <=>  destination_location_id IS NOT NULL.
--    destination_id (TEXT) is kept as the human label the history view shows.
-- ------------------------------------------------------------
ALTER TABLE wms_dispatches
  ADD COLUMN destination_location_id UUID REFERENCES locations(id) ON DELETE SET NULL;

ALTER TABLE wms_dispatches
  ADD CONSTRAINT wms_dispatch_location_ck
  CHECK ((destination_type = 'Internal Shop') = (destination_location_id IS NOT NULL));

CREATE INDEX idx_wms_dispatches_location ON wms_dispatches(destination_location_id);

-- ------------------------------------------------------------
-- 3. Warehouse stock can never go negative.
-- ------------------------------------------------------------
ALTER TABLE wms_inventory
  ADD CONSTRAINT wms_inventory_qty_nonneg CHECK (physical_qty >= 0);

-- ------------------------------------------------------------
-- 4. create_wms_dispatch — one atomic entry point for all dispatch types.
--
--    Org is derived from the catalog items (like receive_wms_stock), so there
--    is no caller-supplied p_org_id to get wrong. assert_org_writable is the
--    single authorization + subscription gate. auth.uid() inside the nested
--    add_product_stock_at_location still identifies the real caller (it reads
--    the request JWT, not the SQL role), so the gate holds end to end.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_wms_dispatch(
  p_destination_type        TEXT,
  p_destination_location_id UUID,     -- required iff Internal Shop, else NULL
  p_destination_name        TEXT,     -- required iff not Internal Shop
  p_items                   JSONB,    -- [{ "wms_item_id": bigint, "qty": int }]
  p_notes                   TEXT DEFAULT NULL,
  p_created_by              TEXT DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id      UUID;
  v_dest_label  TEXT;
  v_dispatch_id BIGINT;
  v_item_ids    BIGINT[];
  v_orgs        INT;
  v_found       INT;
  v_loc_org     UUID;
  item          JSONB;
  v_item_id     BIGINT;
  v_qty         INT;
  v_current_qty INT;
  v_product_id  UUID;
BEGIN
  IF p_destination_type NOT IN ('Internal Shop', 'External Client', 'Wholesale') THEN
    RAISE EXCEPTION 'Invalid destination type: %', p_destination_type USING ERRCODE = '22023';
  END IF;
  IF COALESCE(jsonb_array_length(p_items), 0) = 0 THEN
    RAISE EXCEPTION 'At least one line item is required' USING ERRCODE = '22023';
  END IF;

  -- Collect the catalog ids and validate them: every id must exist and all
  -- must belong to exactly one org. COUNT(DISTINCT id) vs the distinct request
  -- ids means a duplicated id cannot mask a missing one.
  SELECT array_agg((elem->>'wms_item_id')::bigint)
    INTO v_item_ids
    FROM jsonb_array_elements(p_items) elem;

  SELECT COUNT(DISTINCT org_id), COUNT(DISTINCT id)
    INTO v_orgs, v_found
    FROM wms_catalog
   WHERE id = ANY(v_item_ids);

  IF v_found <> (SELECT COUNT(DISTINCT x) FROM unnest(v_item_ids) AS x) THEN
    RAISE EXCEPTION 'One or more warehouse items do not exist' USING ERRCODE = '42501';
  END IF;
  IF v_orgs <> 1 THEN
    RAISE EXCEPTION 'Line items span more than one organisation' USING ERRCODE = '42501';
  END IF;

  SELECT org_id INTO v_org_id FROM wms_catalog WHERE id = ANY(v_item_ids) LIMIT 1;

  -- Resolve the destination label; for internal shops validate the location
  -- belongs to this org and is active.
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

  -- Single authorization + subscription gate.
  PERFORM assert_org_writable(v_org_id);

  INSERT INTO wms_dispatches (
    org_id, destination_type, destination_id, destination_location_id,
    status, notes, created_by
  ) VALUES (
    v_org_id, p_destination_type, v_dest_label, p_destination_location_id,
    'Dispatched', NULLIF(TRIM(p_notes), ''), p_created_by
  )
  RETURNING id INTO v_dispatch_id;

  FOR item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_item_id := (item->>'wms_item_id')::bigint;
    v_qty     := (item->>'qty')::int;

    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'Quantity must be greater than zero for item %', v_item_id;
    END IF;

    -- Lock the inventory row and verify sufficient warehouse stock.
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
           updated_at = NOW()
     WHERE org_id = v_org_id AND wms_item_id = v_item_id;

    INSERT INTO wms_dispatch_items (org_id, dispatch_id, wms_item_id, qty_sent)
    VALUES (v_org_id, v_dispatch_id, v_item_id, v_qty);

    -- The bridge: internal shops credit the destination location's retail
    -- stock via the audited per-location RPC. Unlinked items skip this.
    IF p_destination_type = 'Internal Shop' THEN
      SELECT product_id INTO v_product_id
        FROM wms_catalog
       WHERE id = v_item_id AND org_id = v_org_id;

      IF v_product_id IS NOT NULL THEN
        PERFORM add_product_stock_at_location(v_product_id, v_qty, p_destination_location_id);
      END IF;
    END IF;
  END LOOP;

  RETURN v_dispatch_id;
END;
$$;

-- ------------------------------------------------------------
-- 5. Grant hygiene + retire the old RPC.
-- ------------------------------------------------------------
REVOKE ALL    ON FUNCTION create_wms_dispatch(TEXT, UUID, TEXT, JSONB, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_wms_dispatch(TEXT, UUID, TEXT, JSONB, TEXT, TEXT) TO authenticated;

DROP FUNCTION IF EXISTS process_tilify_dispatch(UUID, TEXT, JSONB, TEXT, TEXT);

COMMIT;

-- ============================================================
-- VERIFY (run separately, after commit)
--
-- 1. New RPC is not PUBLIC/anon-executable:
--
--   SELECT p.proname, coalesce(array_to_string(p.proacl, ', '), 'DEFAULT (PUBLIC!)') AS acl
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.proname = 'create_wms_dispatch';
--   -- acl must mention authenticated=X and must NOT start with =X/ (PUBLIC).
--
-- 2. Old RPC is gone:
--   SELECT 1 FROM pg_proc WHERE proname = 'process_tilify_dispatch';  -- expect 0 rows
--
-- 3. End to end, as an admin on a writable org that has >= 1 location:
--    a. link a wms_catalog item to a product (set product_id),
--    b. receive warehouse stock for it,
--    c. dispatch it to an Internal Shop location,
--    d. confirm product_stock.quantity rose at that location and the item is
--       sellable in POS there, and wms_inventory.physical_qty fell by the same.
--    e. dispatch to an External Client — warehouse falls, no retail change.
-- ============================================================
