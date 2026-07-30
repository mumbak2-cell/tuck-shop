-- ============================================================
-- Migration 073: Cash back on electronic sales
--
-- Shops hand physical cash to a customer who pays the card for more than
-- the goods. That cash leaves the drawer without being a sale, so the
-- end-of-shift expected cash was overstated by exactly the amount paid out.
--
-- A `sales` row is one CART LINE, but cash back belongs to the whole
-- transaction. It is therefore recorded once per batch, on the first line,
-- and read back with SUM() — writing it on every line would multiply it by
-- the basket size.
-- ============================================================

BEGIN;

ALTER TABLE sales ADD COLUMN IF NOT EXISTS cash_back NUMERIC(10,2) NOT NULL DEFAULT 0;

-- Drop the 072 signature before creating the wider one. Adding an argument
-- without this leaves two overloads and PostgREST cannot choose between
-- them — that is what broke the Destiny till earlier.
DROP FUNCTION IF EXISTS submit_sale_batch(
  UUID[], UUID, UUID, UUID[], INTEGER[], NUMERIC[], NUMERIC[],
  TEXT, TEXT, UUID, DATE, TIMESTAMPTZ, NUMERIC[], BOOLEAN[]
);

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
  p_created_at       TIMESTAMPTZ,
  p_cost_prices      NUMERIC[] DEFAULT NULL,
  p_is_wholesale     BOOLEAN[] DEFAULT NULL,
  p_cash_back        NUMERIC   DEFAULT 0
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
  v_cost           NUMERIC;
  v_wholesale      BOOLEAN;
BEGIN
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

  SELECT EXISTS (SELECT 1 FROM sales WHERE id = ANY(p_sale_ids))
    INTO v_already_exists;
  IF v_already_exists THEN
    RETURN p_sale_ids;
  END IF;

  FOR v_i IN 1..v_n LOOP
    -- Use provided cost_price if available, otherwise look up from product
    IF p_cost_prices IS NOT NULL AND array_length(p_cost_prices, 1) >= v_i THEN
      v_cost := p_cost_prices[v_i];
    ELSE
      SELECT CASE WHEN qty_in_pack > 0 THEN ROUND(package_price / qty_in_pack, 2) ELSE 0 END
        INTO v_cost
        FROM products WHERE id = p_product_ids[v_i];
    END IF;

    -- Use provided is_wholesale if available, otherwise default to false
    IF p_is_wholesale IS NOT NULL AND array_length(p_is_wholesale, 1) >= v_i THEN
      v_wholesale := p_is_wholesale[v_i];
    ELSE
      v_wholesale := FALSE;
    END IF;

    INSERT INTO sales (
      id, org_id, sale_date, product_id, quantity, unit_price, total_amount,
      payment_method, payment_reference, customer_id, location_id, created_at,
      cost_price, is_wholesale, cash_back
    ) VALUES (
      p_sale_ids[v_i], p_org_id, p_sale_date,
      p_product_ids[v_i], p_quantities[v_i], p_unit_prices[v_i], p_total_amounts[v_i],
      p_payment_method, NULLIF(p_payment_reference, ''), p_customer_id, p_location_id, p_created_at,
      v_cost, v_wholesale,
      -- Transaction-level, so only the first line carries it.
      CASE WHEN v_i = 1 THEN COALESCE(p_cash_back, 0) ELSE 0 END
    );

    PERFORM deduct_stock_at_location(
      p_product_ids[v_i],
      p_quantities[v_i],
      p_location_id
    );

    IF lower(p_payment_method) LIKE '%credit%' THEN
      v_credit_total := v_credit_total + p_total_amounts[v_i];
    END IF;
  END LOOP;

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
  TEXT, TEXT, UUID, DATE, TIMESTAMPTZ, NUMERIC[], BOOLEAN[], NUMERIC
) TO authenticated;

COMMIT;
