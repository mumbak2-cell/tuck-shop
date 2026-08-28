-- ============================================================
-- Migration 101: Track stock-deduction state independently of sale existence
--
-- submit_sale_batch's idempotency check conflates "sale row exists" with
-- "stock was deducted": if ANY p_sale_ids exist it returns early, skipping
-- deduction entirely. In normal operation PL/pgSQL atomicity means both
-- always succeed or fail together — but after a stock count overwrites
-- product_stock, the deduction effect is absorbed into the new baseline
-- and there is no audit trail of whether it happened.
--
-- This migration:
--   1. Adds sales.stock_deducted_at (nullable TIMESTAMPTZ).
--   2. Backfills existing rows (all historical sales had stock deducted).
--   3. Rewrites submit_sale_batch with two-phase idempotency:
--      - Sale exists + stock_deducted_at set → return early (fully processed)
--      - Sale exists + stock_deducted_at NULL → deduct stock only, set flag
--      - New sale → insert + deduct + set flag
--
-- Signature is UNCHANGED — no new arguments, no overload risk.
--
-- Idempotent. Safe to re-run.
--
-- Record with:
--   node node_modules/supabase/dist/supabase.js migration repair \
--     --status applied 101
-- ============================================================

-- STATEMENT 1: Add column
ALTER TABLE sales ADD COLUMN IF NOT EXISTS stock_deducted_at TIMESTAMPTZ;

-- STATEMENT 2: Backfill — all existing sales had stock deducted at sale time.
-- Only touch rows where it's NULL to make this idempotent.
UPDATE sales
   SET stock_deducted_at = created_at
 WHERE stock_deducted_at IS NULL
   AND voided = FALSE
   AND return_of_sale_id IS NULL;

-- Returns (credit notes) and voided rows intentionally left NULL:
-- returns restock via restock_at_location, not deduct_stock_at_location,
-- and voided rows had their deduction reversed.

-- STATEMENT 3: Index for the two-phase idempotency query
CREATE INDEX IF NOT EXISTS idx_sales_deduction_pending
  ON sales (id) WHERE stock_deducted_at IS NULL;

-- STATEMENT 4: Rewrite submit_sale_batch with two-phase idempotency.
-- Same signature as 074 (073 compat). Only body changes.
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
  v_existing_count INTEGER;
  v_undeducted     INTEGER;
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

  -- Two-phase idempotency: check sale existence AND deduction state separately.
  SELECT COUNT(*),
         COUNT(*) FILTER (WHERE stock_deducted_at IS NULL)
    INTO v_existing_count, v_undeducted
    FROM sales
   WHERE id = ANY(p_sale_ids);

  -- Phase 1: All rows exist and all were deducted — fully processed, return early.
  IF v_existing_count = v_n AND v_undeducted = 0 THEN
    RETURN p_sale_ids;
  END IF;

  -- Phase 2: All rows exist but some lack deduction — deduct only, then return.
  IF v_existing_count = v_n AND v_undeducted > 0 THEN
    FOR v_i IN 1..v_n LOOP
      IF EXISTS (
        SELECT 1 FROM sales
         WHERE id = p_sale_ids[v_i] AND stock_deducted_at IS NULL
      ) THEN
        PERFORM deduct_stock_at_location(
          p_product_ids[v_i],
          p_quantities[v_i],
          p_location_id
        );

        UPDATE sales
           SET stock_deducted_at = NOW()
         WHERE id = p_sale_ids[v_i];
      END IF;
    END LOOP;
    RETURN p_sale_ids;
  END IF;

  -- Phase 3: New sale — full insert + deduct path.
  -- Guard against partial overlap (some IDs exist, some don't) — this should
  -- never happen with properly generated UUIDs, but refuse rather than corrupt.
  IF v_existing_count > 0 THEN
    RAISE EXCEPTION 'submit_sale_batch: partial overlap — % of % sale IDs already exist',
      v_existing_count, v_n
      USING ERRCODE = '23505';
  END IF;

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
      cost_price, is_wholesale, cash_back, transaction_id, stock_deducted_at
    ) VALUES (
      p_sale_ids[v_i], p_org_id, p_sale_date,
      p_product_ids[v_i], p_quantities[v_i], p_unit_prices[v_i], p_total_amounts[v_i],
      p_payment_method, NULLIF(p_payment_reference, ''), p_customer_id, p_location_id, p_created_at,
      v_cost, v_wholesale,
      CASE WHEN v_i = 1 THEN COALESCE(p_cash_back, 0) ELSE 0 END,
      v_txn_id,
      NOW()
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

NOTIFY pgrst, 'reload schema';
