-- ============================================================
-- Migration 060: Return voided-sale stock to the branch it left
--
-- Voiding a sale (src/app/(dashboard)/sales/page.tsx) added the returned units
-- back to the LEGACY org-wide products.opening_stock column. But the sale
-- deducted from product_stock.quantity at the sale's location (migration 024,
-- via deduct_stock_at_location) — the per-branch figure the POS actually reads.
--
-- So a void reversed the money but not the branch stock: the location stayed
-- understated by the returned quantity, and Revenue Assurance read the gap as
-- phantom shrinkage. This adds the mirror of deduct_stock_at_location so a void
-- credits the correct branch row atomically.
--
-- Deliberately increment-only (p_quantity > 0). This is not a general stock
-- setter — it can only give stock back, never take it, so a client cannot use
-- it to inflate a branch's count arbitrarily.
--
-- Idempotent: safe to replay from the top (the SQL Editor runs a script as one
-- transaction — see 057/058).
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION restock_at_location(
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
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'restock_at_location: quantity must be positive'
      USING ERRCODE = '22023';
  END IF;

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

  -- Create the branch row if it does not exist, then add the returned units.
  INSERT INTO product_stock (product_id, location_id, quantity, org_id)
  VALUES (p_product_id, p_location_id, p_quantity, v_org_id)
  ON CONFLICT (product_id, location_id)
  DO UPDATE SET quantity = product_stock.quantity + EXCLUDED.quantity,
                last_updated = NOW();
END;
$$;

-- A freshly created function is executable by PUBLIC by default; mirror the
-- grant hardening the deduction path carries (040/058).
REVOKE ALL ON FUNCTION restock_at_location(UUID, INTEGER, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION restock_at_location(UUID, INTEGER, UUID) TO authenticated;

COMMIT;

-- PostgREST caches the schema; without this the new function is invisible until
-- it happens to reload (see 057).
NOTIFY pgrst, 'reload schema';
