-- ============================================================
-- Migration 004: deduct_stock RPC function
-- Called by payment-modal.tsx after each sale to decrement
-- the product's opening_stock by the quantity sold.
-- ============================================================

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
