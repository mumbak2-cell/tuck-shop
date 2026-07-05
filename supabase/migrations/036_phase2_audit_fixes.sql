-- ============================================================
-- Migration 036: Phase 2 audit fixes (H1, H4, H5, H9)
--
-- H1  — Atomic customer balance update RPC (eliminates race condition)
-- H4  — Add FOR UPDATE lock to transfer_stock RPC (fixes TOCTOU)
-- H5  — Atomic receive_wms_stock RPC (replaces client-side loop)
-- H9  — Add composite index on sales(org_id, sale_date)
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- H1: Atomic customer balance adjustment
-- Uses SQL arithmetic instead of read-then-write.
-- Negative delta = payment (decreases balance owed).
-- Positive delta = new credit (increases balance owed).
-- Returns the new balance.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION adjust_customer_balance(
  p_customer_id UUID,
  p_delta NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_balance NUMERIC;
BEGIN
  UPDATE customers
  SET balance = GREATEST(balance + p_delta, 0)
  WHERE id = p_customer_id
  RETURNING balance INTO v_new_balance;

  IF v_new_balance IS NULL THEN
    RAISE EXCEPTION 'Customer not found: %', p_customer_id;
  END IF;

  RETURN v_new_balance;
END;
$$;

-- ------------------------------------------------------------
-- H4: Fix TOCTOU in transfer_stock — add FOR UPDATE on the
-- source stock row so concurrent transfers block rather than
-- both reading the same available quantity.
-- ------------------------------------------------------------

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

-- ------------------------------------------------------------
-- H5: Atomic receive-stock RPC for WMS
-- Inserts header + line items + updates inventory in one tx.
-- ------------------------------------------------------------

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

-- ------------------------------------------------------------
-- H9: Missing composite index on sales
-- Daily reports and P&L query by (org_id, sale_date) constantly.
-- Without this, performance degrades linearly with volume.
-- ------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_sales_org_date ON sales(org_id, sale_date);

COMMIT;
