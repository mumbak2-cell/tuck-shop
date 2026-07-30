-- ============================================================
-- Migration 074: Group sale lines into transactions
--
-- A `sales` row is one CART LINE. Nothing tied the lines of a single basket
-- together, so the app could only ever show and void one line at a time —
-- there was no way to see "the sale" or its total.
--
-- The lines of a basket already share an exact created_at, because
-- submit_sale_batch writes one client timestamp to every row. That makes the
-- historic grouping recoverable, so this backfills a real transaction_id
-- rather than leaving the app to infer baskets from timestamps forever.
--
-- submit_sale_batch generates the id itself, so its signature is UNCHANGED —
-- no new overload, and none of the breakage that came with widening it before.
-- ============================================================

BEGIN;

ALTER TABLE sales ADD COLUMN IF NOT EXISTS transaction_id UUID;
CREATE INDEX IF NOT EXISTS idx_sales_transaction ON sales(transaction_id);

-- Backfill. IS NOT DISTINCT FROM so NULL location/method still groups, rather
-- than every such row falling out of the join and keeping a NULL id.
WITH grouped AS (
  SELECT org_id, location_id, created_at, payment_method, gen_random_uuid() AS txn
    FROM sales
   WHERE transaction_id IS NULL
   GROUP BY org_id, location_id, created_at, payment_method
)
UPDATE sales s
   SET transaction_id = g.txn
  FROM grouped g
 WHERE s.transaction_id IS NULL
   AND s.org_id IS NOT DISTINCT FROM g.org_id
   AND s.location_id IS NOT DISTINCT FROM g.location_id
   AND s.created_at = g.created_at
   AND s.payment_method IS NOT DISTINCT FROM g.payment_method;

-- Same signature as 073. Only the body changes: one transaction_id per batch.
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
  v_txn_id         UUID;
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

  -- One id for the whole basket. Generated here rather than passed in, so the
  -- function signature stays put and offline replays of older queued payloads
  -- keep working untouched.
  v_txn_id := gen_random_uuid();

  FOR v_i IN 1..v_n LOOP
    IF p_cost_prices IS NOT NULL AND array_length(p_cost_prices, 1) >= v_i THEN
      v_cost := p_cost_prices[v_i];
    ELSE
      SELECT CASE WHEN qty_in_pack > 0 THEN ROUND(package_price / qty_in_pack, 2) ELSE 0 END
        INTO v_cost
        FROM products WHERE id = p_product_ids[v_i];
    END IF;

    IF p_is_wholesale IS NOT NULL AND array_length(p_is_wholesale, 1) >= v_i THEN
      v_wholesale := p_is_wholesale[v_i];
    ELSE
      v_wholesale := FALSE;
    END IF;

    INSERT INTO sales (
      id, org_id, sale_date, product_id, quantity, unit_price, total_amount,
      payment_method, payment_reference, customer_id, location_id, created_at,
      cost_price, is_wholesale, cash_back, transaction_id
    ) VALUES (
      p_sale_ids[v_i], p_org_id, p_sale_date,
      p_product_ids[v_i], p_quantities[v_i], p_unit_prices[v_i], p_total_amounts[v_i],
      p_payment_method, NULLIF(p_payment_reference, ''), p_customer_id, p_location_id, p_created_at,
      v_cost, v_wholesale,
      -- Transaction-level, so only the first line carries it.
      CASE WHEN v_i = 1 THEN COALESCE(p_cash_back, 0) ELSE 0 END,
      v_txn_id
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

-- Void a set of lines as one action: marks them voided, puts the stock back at
-- the BRANCH, and reverses any credit. The app previously voided from the
-- client and restocked products.opening_stock, the pre-per-location field, so
-- a void at a multi-branch shop never restored the branch's stock.
CREATE OR REPLACE FUNCTION void_sale_lines(
  p_sale_ids UUID[],
  p_reason   TEXT,
  p_voided_by TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r        sales%ROWTYPE;
  v_count  INTEGER := 0;
BEGIN
  IF p_sale_ids IS NULL OR array_length(p_sale_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'void_sale_lines: no lines given' USING ERRCODE = '22023';
  END IF;

  FOR r IN SELECT * FROM sales WHERE id = ANY(p_sale_ids) LOOP
    IF r.voided THEN
      CONTINUE;  -- already voided; keep the call idempotent
    END IF;
    IF r.return_of_sale_id IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot void a return' USING ERRCODE = '22023';
    END IF;

    PERFORM assert_org_writable(r.org_id);

    UPDATE sales
       SET voided = TRUE,
           voided_at = NOW(),
           voided_by = p_voided_by,
           void_reason = NULLIF(TRIM(p_reason), '')
     WHERE id = r.id;

    IF r.location_id IS NOT NULL THEN
      PERFORM restock_at_location(r.product_id, r.quantity, r.location_id);
    END IF;

    IF lower(r.payment_method) LIKE '%credit%' AND r.customer_id IS NOT NULL THEN
      PERFORM adjust_customer_balance(r.customer_id, -r.total_amount);
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION void_sale_lines(UUID[], TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION void_sale_lines(UUID[], TEXT, TEXT) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
