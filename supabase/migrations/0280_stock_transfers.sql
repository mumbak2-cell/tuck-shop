-- ============================================================
-- Migration 0280: Inter-branch stock transfers (Slice 5 follow-up)
--
-- Lets owners and admins move N units of a product from one shop to
-- another, atomically. Decrements source product_stock, increments
-- destination product_stock, and writes an audit row to stock_transfers.
--
-- Cashiers (org_members.role = 'member') are pinned to a single
-- location and cannot transfer stock — the RPC enforces this.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. stock_transfers — one row per transfer, immutable audit trail
-- ------------------------------------------------------------

CREATE TABLE stock_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  from_location_id UUID NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  to_location_id UUID NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  notes TEXT,
  transferred_by TEXT,
  transferred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (from_location_id <> to_location_id)
);

CREATE INDEX idx_stock_transfers_org ON stock_transfers(org_id);
CREATE INDEX idx_stock_transfers_product ON stock_transfers(product_id);
CREATE INDEX idx_stock_transfers_from ON stock_transfers(from_location_id);
CREATE INDEX idx_stock_transfers_to ON stock_transfers(to_location_id);
CREATE INDEX idx_stock_transfers_when ON stock_transfers(transferred_at DESC);

ALTER TABLE stock_transfers ENABLE ROW LEVEL SECURITY;

-- Read: any user who can see either the source or destination location
CREATE POLICY "stock_transfers_read" ON stock_transfers
  FOR SELECT USING (
    org_id IN (SELECT current_user_org_ids())
    AND (
      from_location_id IN (SELECT current_user_location_ids())
      OR to_location_id IN (SELECT current_user_location_ids())
    )
  );

-- No client-side writes — the RPC inserts via SECURITY DEFINER.
-- We leave INSERT/UPDATE/DELETE policies absent so direct writes are blocked.

-- Default org_id from helper so RLS works on inserts done via the admin client
ALTER TABLE stock_transfers ALTER COLUMN org_id SET DEFAULT default_user_org_id();

-- ------------------------------------------------------------
-- 2. transfer_stock RPC — atomic move with permission check
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

  -- Check available stock at source
  SELECT COALESCE(quantity, 0) INTO v_available
  FROM product_stock
  WHERE product_id = p_product_id AND location_id = p_from_location_id;

  IF v_available < p_quantity THEN
    RAISE EXCEPTION 'Insufficient stock at source: only % available, % requested', v_available, p_quantity;
  END IF;

  -- Decrement source (must exist after the check above)
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
