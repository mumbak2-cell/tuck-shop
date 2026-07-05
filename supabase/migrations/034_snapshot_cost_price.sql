-- ============================================================
-- Migration 034: Snapshot cost_price on sales rows
--
-- Problem: P&L currently joins products.package_price at query time.
-- When a supplier price changes, ALL historical margins are retroactively
-- corrupted. This migration adds cost_price to the sales table so each
-- sale remembers the cost at the time it was made.
--
-- Safe rollout:
--   - Column is NULLable, so existing rows remain valid
--   - Backfill sets cost_price on existing sales using CURRENT product cost
--     (best-effort — not historically accurate, but better than nothing)
--   - submit_sale_batch is updated to populate cost_price going forward
-- ============================================================

BEGIN;

-- 1. Add column (NULLable for backward compat with existing rows)
ALTER TABLE sales ADD COLUMN IF NOT EXISTS cost_price DECIMAL(10,2);

-- 2. Backfill from current product costs (best-effort)
UPDATE sales s
SET cost_price = CASE
  WHEN p.qty_in_pack > 0 THEN ROUND(p.package_price / p.qty_in_pack, 2)
  ELSE 0
END
FROM products p
WHERE s.product_id = p.id
  AND s.cost_price IS NULL;

-- 3. Update submit_sale_batch to accept and store cost_price
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
  p_cost_prices      NUMERIC[] DEFAULT NULL
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

    INSERT INTO sales (
      id, org_id, sale_date, product_id, quantity, unit_price, total_amount,
      payment_method, payment_reference, customer_id, location_id, created_at,
      cost_price
    ) VALUES (
      p_sale_ids[v_i], p_org_id, p_sale_date,
      p_product_ids[v_i], p_quantities[v_i], p_unit_prices[v_i], p_total_amounts[v_i],
      p_payment_method, NULLIF(p_payment_reference, ''), p_customer_id, p_location_id, p_created_at,
      v_cost
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
  TEXT, TEXT, UUID, DATE, TIMESTAMPTZ, NUMERIC[]
) TO authenticated;

-- 4. Index for P&L and daily report performance (also fixes H9)
CREATE INDEX IF NOT EXISTS idx_sales_org_date ON sales(org_id, sale_date);

COMMIT;
