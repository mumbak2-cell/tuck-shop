-- ============================================================
-- ROLLBACK for migration 040. Restores the exact pre-040 function
-- bodies, extracted from the migrations that last defined them:
--   004, 006, 024, 0231, 0291, 036, 037, 034
--
-- Run this ONLY if 040 causes sales to fail. It reopens the
-- cross-tenant vulnerability, so treat it as a stop-the-bleeding
-- measure and re-apply a fixed 040 promptly.
--
-- It does NOT restore EXECUTE-to-PUBLIC: 040's REVOKE stays in
-- force, which is strictly safer and breaks nothing (the app calls
-- these as `authenticated`).
--
-- 039's guards on submit_sale_batch / adjust_customer_balance are
-- left in place too — they are already live in production and are
-- not what 040 changed.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION deduct_stock(
  p_product_id UUID,
  p_quantity   INT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE products
     SET opening_stock = GREATEST(opening_stock - p_quantity, 0)
   WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product % not found', p_product_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION add_product_stock(
  p_product_id UUID,
  p_quantity INT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE products
  SET opening_stock = opening_stock + p_quantity
  WHERE id = p_product_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product % not found', p_product_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION add_ingredient_stock(
  p_ingredient_id UUID,
  p_quantity DECIMAL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE ingredients
  SET current_stock = current_stock + p_quantity
  WHERE id = p_ingredient_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ingredient % not found', p_ingredient_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION deduct_stock_at_location(
  p_product_id UUID,
  p_quantity   INTEGER,
  p_location_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Ensure a row exists so we can decrement it; will create with 0 then go negative if needed
  INSERT INTO product_stock (product_id, location_id, quantity, org_id)
  SELECT p_product_id, p_location_id, 0, p.org_id
  FROM products p WHERE p.id = p_product_id
  ON CONFLICT (product_id, location_id) DO NOTHING;

  UPDATE product_stock
  SET quantity = GREATEST(quantity - p_quantity, 0),
      last_updated = NOW()
  WHERE product_id = p_product_id AND location_id = p_location_id;
END;
$$;

CREATE OR REPLACE FUNCTION add_product_stock_at_location(
  p_product_id UUID,
  p_quantity   INTEGER,
  p_location_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO product_stock (product_id, location_id, quantity, org_id)
  SELECT p_product_id, p_location_id, p_quantity, p.org_id
  FROM products p WHERE p.id = p_product_id
  ON CONFLICT (product_id, location_id) DO UPDATE
  SET quantity = product_stock.quantity + EXCLUDED.quantity,
      last_updated = NOW();
END;
$$;

CREATE OR REPLACE FUNCTION adjust_wms_inventory(
  p_org_id      UUID,
  p_wms_item_id BIGINT,
  p_adjustment  INT,      -- positive to add, negative to remove
  p_reason      TEXT
)
RETURNS INT  -- returns new physical_qty
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_qty INT;
BEGIN
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

CREATE OR REPLACE FUNCTION process_tilify_dispatch(
  p_org_id         UUID,
  p_destination_id TEXT,
  p_items          JSONB,   -- array of {"wms_item_id": bigint, "qty": int}
  p_notes          TEXT DEFAULT NULL,
  p_created_by     TEXT DEFAULT NULL
)
RETURNS BIGINT  -- returns the new dispatch ID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dispatch_id  BIGINT;
  item           JSONB;
  v_current_qty  INT;
  v_qty          INT;
  v_sku          TEXT;
BEGIN
  -- Create dispatch header
  INSERT INTO wms_dispatches (org_id, destination_type, destination_id, status, notes, created_by)
  VALUES (p_org_id, 'Internal Shop', p_destination_id, 'Dispatched', p_notes, p_created_by)
  RETURNING id INTO v_dispatch_id;

  -- Process each line item
  FOR item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_qty := (item->>'qty')::int;

    -- 1. Verify sufficient warehouse stock
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

    -- 2. Deduct from WMS inventory
    UPDATE wms_inventory
    SET physical_qty = physical_qty - v_qty,
        updated_at = NOW()
    WHERE org_id = p_org_id
      AND wms_item_id = (item->>'wms_item_id')::bigint;

    -- 3. Log dispatch line item
    INSERT INTO wms_dispatch_items (org_id, dispatch_id, wms_item_id, qty_sent)
    VALUES (p_org_id, v_dispatch_id, (item->>'wms_item_id')::bigint, v_qty);

    -- 4. Find matching retail product by SKU (wms_catalog.sku = products.inventory_id)
    SELECT sku INTO v_sku
    FROM wms_catalog
    WHERE id = (item->>'wms_item_id')::bigint
      AND org_id = p_org_id;

    -- 5. Increment retail stock if a matching product exists
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

CREATE OR REPLACE FUNCTION apply_wms_stock_count(
  p_session_id UUID
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INT := 0;
  r RECORD;
BEGIN
  FOR r IN
    SELECT wms_item_id, counted_qty, org_id
    FROM wms_stock_counts
    WHERE session_id = p_session_id
  LOOP
    -- Update inventory quantity
    UPDATE wms_inventory
    SET physical_qty = r.counted_qty,
        updated_at = NOW()
    WHERE wms_item_id = r.wms_item_id
      AND org_id = r.org_id;

    -- Mark catalog item as counted
    UPDATE wms_catalog
    SET last_counted_at = NOW()
    WHERE id = r.wms_item_id
      AND org_id = r.org_id;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION receive_wms_stock(
  p_supplier TEXT,
  p_notes TEXT,
  p_recorded_by TEXT,
  p_wms_item_ids INTEGER[],
  p_packs INTEGER[],
  p_pack_sizes INTEGER[],
  p_unit_costs NUMERIC[]
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_receipt_id INTEGER;
  v_total_cost NUMERIC := 0;
  v_i INTEGER;
  v_total_units INTEGER;
  v_line_total NUMERIC;
BEGIN
  IF array_length(p_wms_item_ids, 1) IS NULL OR array_length(p_wms_item_ids, 1) = 0 THEN
    RAISE EXCEPTION 'At least one line item is required';
  END IF;
  IF array_length(p_wms_item_ids, 1) <> array_length(p_packs, 1)
     OR array_length(p_wms_item_ids, 1) <> array_length(p_pack_sizes, 1)
     OR array_length(p_wms_item_ids, 1) <> array_length(p_unit_costs, 1) THEN
    RAISE EXCEPTION 'All arrays must have the same length';
  END IF;

  -- Calculate total cost
  FOR v_i IN 1..array_length(p_wms_item_ids, 1) LOOP
    v_total_cost := v_total_cost + (p_packs[v_i] * p_pack_sizes[v_i] * p_unit_costs[v_i]);
  END LOOP;

  -- 1. Insert receipt header
  INSERT INTO wms_receipts (receipt_date, supplier, notes, total_cost, recorded_by)
  VALUES (CURRENT_DATE, NULLIF(TRIM(p_supplier), ''), NULLIF(TRIM(p_notes), ''), v_total_cost, p_recorded_by)
  RETURNING id INTO v_receipt_id;

  -- 2. Insert line items + update inventory
  FOR v_i IN 1..array_length(p_wms_item_ids, 1) LOOP
    v_total_units := p_packs[v_i] * p_pack_sizes[v_i];
    v_line_total := v_total_units * p_unit_costs[v_i];

    INSERT INTO wms_receipt_items (receipt_id, wms_item_id, packs, pack_size, total_units, unit_cost, line_total)
    VALUES (v_receipt_id, p_wms_item_ids[v_i], p_packs[v_i], p_pack_sizes[v_i], v_total_units, p_unit_costs[v_i], v_line_total);

    -- Atomic inventory increment (no read-then-write)
    UPDATE wms_inventory
    SET physical_qty = physical_qty + v_total_units,
        updated_at = NOW()
    WHERE wms_item_id = p_wms_item_ids[v_i];
  END LOOP;

  RETURN v_receipt_id;
END;
$$;

CREATE OR REPLACE FUNCTION transfer_stock(
  p_product_id UUID,
  p_from_location_id UUID,
  p_to_location_id UUID,
  p_quantity INTEGER,
  p_notes TEXT DEFAULT NULL,
  p_transferred_by TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID;
  v_org_id UUID;
  v_available INTEGER;
  v_transfer_id UUID;
  v_caller_role TEXT;
BEGIN
  -- Auth
  v_caller := auth.uid();
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Validate inputs
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity must be greater than zero';
  END IF;
  IF p_from_location_id = p_to_location_id THEN
    RAISE EXCEPTION 'Source and destination must differ';
  END IF;

  -- Find the product's org
  SELECT org_id INTO v_org_id FROM products WHERE id = p_product_id;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Product not found';
  END IF;

  -- Permission: caller must be owner or admin in this org
  SELECT role INTO v_caller_role
  FROM org_members
  WHERE user_id = v_caller AND org_id = v_org_id;
  IF v_caller_role IS NULL THEN
    RAISE EXCEPTION 'You are not a member of this organisation';
  END IF;
  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only owners and admins can transfer stock';
  END IF;

  -- Both locations must belong to the same org
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

  -- Check available stock at source WITH ROW LOCK (H4 fix)
  SELECT COALESCE(quantity, 0) INTO v_available
  FROM product_stock
  WHERE product_id = p_product_id AND location_id = p_from_location_id
  FOR UPDATE;

  IF v_available IS NULL OR v_available < p_quantity THEN
    RAISE EXCEPTION 'Insufficient stock at source: only % available, % requested',
      COALESCE(v_available, 0), p_quantity;
  END IF;

  -- Decrement source
  UPDATE product_stock
  SET quantity = quantity - p_quantity, last_updated = NOW()
  WHERE product_id = p_product_id AND location_id = p_from_location_id;

  -- Increment destination (insert if missing, else add)
  INSERT INTO product_stock (org_id, product_id, location_id, quantity)
  VALUES (v_org_id, p_product_id, p_to_location_id, p_quantity)
  ON CONFLICT (product_id, location_id) DO UPDATE
  SET quantity = product_stock.quantity + EXCLUDED.quantity,
      last_updated = NOW();

  -- Audit row
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

COMMIT;
