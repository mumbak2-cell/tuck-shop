-- ============================================================
-- Migration 061: Snapshot output VAT on each sale
--
-- Until now VAT existed only as a number back-calculated at receipt-render
-- time (components/pos/receipt.tsx): total / (1 + vat/100). It was never
-- stored, so it could not be reported, and a later change to
-- organizations.vat_percent would retroactively restate the VAT on every
-- historical sale — the same trap cost_price had before migration 034.
--
-- This captures the VAT at sale time, the same way 034 captured cost_price:
--   * sales.tax_rate   — the org's VAT rate in force when the sale was made
--   * sales.tax_amount — the VAT portion of total_amount (prices are
--                        VAT-INCLUSIVE, per migration 032), rounded to 2dp
--
-- Computed SERVER-SIDE inside submit_sale_batch from organizations.vat_percent,
-- so the client needs no change and an offline sale gets the correct VAT when
-- it replays. An org with no vat_percent (not VAT-registered) stores rate 0 and
-- amount 0 — the overwhelmingly common case today.
--
-- This is output-VAT capture ONLY. It does NOT change any profit figure and
-- does NOT touch input VAT on purchases — that is the next step and needs a
-- costing decision (whether COGS is carried ex-VAT). Nothing here is wrong if
-- that lands later; these columns are the foundation it will build on.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE, replay-safe.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Columns (NULLable for backward compat with existing rows)
-- ------------------------------------------------------------
ALTER TABLE sales ADD COLUMN IF NOT EXISTS tax_rate   NUMERIC(5,2);
ALTER TABLE sales ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(10,2);

-- ------------------------------------------------------------
-- 2. Backfill existing rows from the org's CURRENT vat_percent (best-effort,
--    exactly as 034 backfilled cost_price — not historically perfect, but
--    every VAT-registered org today has a single stable rate). Rows in orgs
--    with no vat_percent get rate 0 / amount 0.
-- ------------------------------------------------------------
UPDATE sales s
SET tax_rate = COALESCE(o.vat_percent, 0),
    tax_amount = CASE
      WHEN COALESCE(o.vat_percent, 0) > 0
        THEN ROUND(s.total_amount - s.total_amount / (1 + o.vat_percent / 100), 2)
      ELSE 0
    END
FROM organizations o
WHERE s.org_id = o.id
  AND s.tax_amount IS NULL;

-- ------------------------------------------------------------
-- 3. submit_sale_batch — body as migration 039 (the current definition:
--    040 only re-granted it, 051 dropped the legacy 12-arg overload), with
--    output-VAT capture added. Every 039 authorization guard is preserved.
--
--    NOTE: deduct_stock_at_location is called with THREE arguments, which
--    resolves to the 4-arg form from migration 058 via its p_source DEFAULT
--    'sale'. Do not "add" a source here — a sale is the default.
-- ------------------------------------------------------------
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
  v_vat_rate       NUMERIC;   -- 061: resolved once per batch
  v_tax            NUMERIC;   -- 061: per-line VAT portion
BEGIN
  -- Authorization first, before any read of another org's rows or any write.
  PERFORM assert_org_writable(p_org_id);

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

  -- Every referenced row must belong to p_org_id.
  IF NOT EXISTS (
    SELECT 1 FROM locations WHERE id = p_location_id AND org_id = p_org_id
  ) THEN
    RAISE EXCEPTION 'submit_sale_batch: location does not belong to this organisation'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(p_product_ids) AS pid
    WHERE NOT EXISTS (
      SELECT 1 FROM products p WHERE p.id = pid AND p.org_id = p_org_id
    )
  ) THEN
    RAISE EXCEPTION 'submit_sale_batch: one or more products do not belong to this organisation'
      USING ERRCODE = '42501';
  END IF;

  IF p_customer_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM customers WHERE id = p_customer_id AND org_id = p_org_id
  ) THEN
    RAISE EXCEPTION 'submit_sale_batch: customer does not belong to this organisation'
      USING ERRCODE = '42501';
  END IF;

  -- Idempotency: if ANY id already exists, treat the whole batch as a replay.
  SELECT EXISTS (SELECT 1 FROM sales WHERE id = ANY(p_sale_ids))
    INTO v_already_exists;
  IF v_already_exists THEN
    RETURN p_sale_ids;
  END IF;

  -- 061: resolve the org's VAT rate once. NULL (not registered) -> 0.
  SELECT COALESCE(vat_percent, 0) INTO v_vat_rate
    FROM organizations WHERE id = p_org_id;
  v_vat_rate := COALESCE(v_vat_rate, 0);

  FOR v_i IN 1..v_n LOOP
    -- Use provided cost_price if available, otherwise look up from product
    IF p_cost_prices IS NOT NULL AND array_length(p_cost_prices, 1) >= v_i THEN
      v_cost := p_cost_prices[v_i];
    ELSE
      SELECT CASE WHEN qty_in_pack > 0 THEN ROUND(package_price / qty_in_pack, 2) ELSE 0 END
        INTO v_cost
        FROM products WHERE id = p_product_ids[v_i];
    END IF;

    -- 061: VAT portion of this line's inclusive total.
    IF v_vat_rate > 0 THEN
      v_tax := ROUND(p_total_amounts[v_i] - p_total_amounts[v_i] / (1 + v_vat_rate / 100), 2);
    ELSE
      v_tax := 0;
    END IF;

    INSERT INTO sales (
      id, org_id, sale_date, product_id, quantity, unit_price, total_amount,
      payment_method, payment_reference, customer_id, location_id, created_at,
      cost_price, tax_rate, tax_amount
    ) VALUES (
      p_sale_ids[v_i], p_org_id, p_sale_date,
      p_product_ids[v_i], p_quantities[v_i], p_unit_prices[v_i], p_total_amounts[v_i],
      p_payment_method, NULLIF(p_payment_reference, ''), p_customer_id, p_location_id, p_created_at,
      v_cost, v_vat_rate, v_tax
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

-- CREATE OR REPLACE preserves the existing ACL, but re-issue the grant to match
-- the repo's pattern and keep it explicit (039/040).
REVOKE ALL ON FUNCTION submit_sale_batch(
  UUID[], UUID, UUID, UUID[], INTEGER[], NUMERIC[], NUMERIC[],
  TEXT, TEXT, UUID, DATE, TIMESTAMPTZ, NUMERIC[]
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION submit_sale_batch(
  UUID[], UUID, UUID, UUID[], INTEGER[], NUMERIC[], NUMERIC[],
  TEXT, TEXT, UUID, DATE, TIMESTAMPTZ, NUMERIC[]
) TO authenticated;

COMMIT;

-- PostgREST caches the schema; nudge it so the new columns are visible.
NOTIFY pgrst, 'reload schema';

-- ============================================================
-- VERIFY (run separately, after commit)
--
--   -- Columns landed:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'sales' AND column_name IN ('tax_rate','tax_amount');
--
--   -- Backfill is consistent for a VAT-registered org (should be ~rate/(100+rate)
--   -- of total). For orgs with no vat_percent, tax_amount must be 0:
--   SELECT o.name, o.vat_percent,
--          SUM(s.total_amount) AS gross, SUM(s.tax_amount) AS vat
--   FROM sales s JOIN organizations o ON o.id = s.org_id
--   GROUP BY 1,2 ORDER BY 1;
--
--   -- The real test: as a cashier on a VAT-registered writable org, complete a
--   -- sale and confirm the new row has tax_rate = vat_percent and a sensible
--   -- tax_amount. On a non-VAT org, both must be 0.
-- ============================================================
