-- Migration 102: Enforce non-negative stock at DB level
--
-- Three fixes:
-- 1. CHECK constraint on product_stock.quantity >= 0
-- 2. FOR UPDATE lock on transfer_stock availability check (race guard)
-- 3. GREATEST clamp on transfer decrement (belt-and-suspenders)
--
-- Idempotent: uses IF NOT EXISTS / CREATE OR REPLACE throughout.

-- STATEMENT 1: CHECK constraint on product_stock
-- Guard: only add if not already present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'product_stock'::regclass
      AND conname = 'product_stock_qty_nonneg'
  ) THEN
    ALTER TABLE product_stock
      ADD CONSTRAINT product_stock_qty_nonneg CHECK (quantity >= 0);
  END IF;
END $$;

-- STATEMENT 2: Rewrite transfer_stock with FOR UPDATE + GREATEST clamp
-- Must DROP first — same signature, but CREATE OR REPLACE on a SECURITY
-- DEFINER function keeps the old body if the signature matches, and we
-- need the grant fixup anyway.
DROP FUNCTION IF EXISTS transfer_stock(UUID, UUID, UUID, INTEGER, TEXT, TEXT);

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

  -- Lock the source row to prevent concurrent transfers racing past the check
  SELECT COALESCE(quantity, 0) INTO v_available
  FROM product_stock
  WHERE product_id = p_product_id AND location_id = p_from_location_id
  FOR UPDATE;

  IF v_available < p_quantity THEN
    RAISE EXCEPTION 'Insufficient stock at source: only % available, % requested', v_available, p_quantity;
  END IF;

  -- Decrement source — GREATEST as belt-and-suspenders behind the CHECK
  UPDATE product_stock
  SET quantity = GREATEST(quantity - p_quantity, 0), last_updated = NOW()
  WHERE product_id = p_product_id AND location_id = p_from_location_id;

  -- Increment destination
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

-- Re-apply grants (DROP restores PUBLIC EXECUTE — see migration 058 comment)
REVOKE ALL ON FUNCTION transfer_stock(UUID, UUID, UUID, INTEGER, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION transfer_stock(UUID, UUID, UUID, INTEGER, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION transfer_stock(UUID, UUID, UUID, INTEGER, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION transfer_stock(UUID, UUID, UUID, INTEGER, TEXT, TEXT) TO service_role;
