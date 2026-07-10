-- ============================================================
-- Migration 0290: Idempotent submit_sale_batch RPC (Slice 9 — Offline POS)
--
-- The POS today does three operations per sale:
--   1. INSERT into sales (one row per line item)
--   2. PERFORM deduct_stock_at_location for each line
--   3. UPDATE customers.balance for credit sales
--
-- For an offline-first POS we need this whole transaction to be safely
-- retriable. If the cashier's phone enqueues a sale and replays it after
-- reconnect, replaying it twice must NOT double-deduct stock or double-add
-- to the customer balance.
--
-- This RPC accepts client-generated sale IDs and short-circuits the entire
-- batch if the first ID already exists in the sales table. Combined with the
-- sales.id PRIMARY KEY this gives us idempotency without any extra schema.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION submit_sale_batch(
  p_sale_ids         UUID[],
  p_org_id           UUID,
  p_location_id      UUID,
  p_product_ids      UUID[],
  p_quantities       INTEGER[],
  p_unit_prices      NUMERIC[],
  p_total_amounts    NUMERIC[],
  p_payment_method   TEXT,
  p_payment_reference TEXT,
  p_customer_id      UUID,
  p_sale_date        DATE,
  p_created_at       TIMESTAMPTZ
)
RETURNS UUID[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_i              INTEGER;
  v_n              INTEGER;
  v_credit_total   NUMERIC := 0;
  v_already_exists BOOLEAN;
BEGIN
  -- Sanity
  IF array_length(p_sale_ids, 1) IS NULL OR array_length(p_sale_ids, 1) = 0 THEN
    RAISE EXCEPTION 'submit_sale_batch: at least one sale row required';
  END IF;
  v_n := array_length(p_sale_ids, 1);
  IF array_length(p_product_ids, 1) <> v_n
     OR array_length(p_quantities, 1) <> v_n
     OR array_length(p_unit_prices, 1) <> v_n
     OR array_length(p_total_amounts, 1) <> v_n THEN
    RAISE EXCEPTION 'submit_sale_batch: array lengths mismatch';
  END IF;

  -- Idempotency: if any sale_id from the batch is already in sales, treat
  -- the whole batch as already processed. The client-generated UUIDs make
  -- this safe — collisions across distinct batches are vanishingly rare.
  SELECT EXISTS (SELECT 1 FROM sales WHERE id = ANY(p_sale_ids))
    INTO v_already_exists;
  IF v_already_exists THEN
    RETURN p_sale_ids;
  END IF;

  -- Insert all line items
  FOR v_i IN 1..v_n LOOP
    INSERT INTO sales (
      id, org_id, sale_date, product_id, quantity, unit_price, total_amount,
      payment_method, payment_reference, customer_id, location_id, created_at
    ) VALUES (
      p_sale_ids[v_i], p_org_id, p_sale_date,
      p_product_ids[v_i], p_quantities[v_i], p_unit_prices[v_i], p_total_amounts[v_i],
      p_payment_method, NULLIF(p_payment_reference, ''), p_customer_id, p_location_id, p_created_at
    );

    -- Stock deduction at the source location
    PERFORM deduct_stock_at_location(
      p_product_ids[v_i],
      p_quantities[v_i],
      p_location_id
    );

    IF lower(p_payment_method) LIKE '%credit%' THEN
      v_credit_total := v_credit_total + p_total_amounts[v_i];
    END IF;
  END LOOP;

  -- Customer balance for credit sales
  IF v_credit_total > 0 AND p_customer_id IS NOT NULL THEN
    UPDATE customers
       SET balance = COALESCE(balance, 0) + v_credit_total
     WHERE id = p_customer_id;
  END IF;

  RETURN p_sale_ids;
END;
$$;

GRANT EXECUTE ON FUNCTION submit_sale_batch(
  UUID[], UUID, UUID, UUID[], INTEGER[], NUMERIC[], NUMERIC[],
  TEXT, TEXT, UUID, DATE, TIMESTAMPTZ
) TO authenticated;

COMMIT;
