-- ============================================================
-- Migration 062: Per-product zero-rating for VAT
--
-- Builds on 061 (which snapshots output VAT on every sale from the org's
-- single vat_percent). Some goods are ZERO-RATED even for a VAT-registered
-- seller — in RSA, brown bread and milk are the classic examples. A flat org
-- rate over-charges VAT on those lines.
--
-- Model: products.zero_rated BOOLEAN. When TRUE, that product's sales carry
-- tax_rate 0 / tax_amount 0 regardless of the org rate — so the snapshot on
-- `sales` distinguishes standard-rated (tax_rate = vat_percent) from
-- zero-rated (tax_rate = 0) lines, which a VAT return reports separately.
--
-- Exempt supplies are not modelled separately; for a tuck-shop's output VAT
-- they behave the same as zero-rated (no VAT charged). Revisit only if input-VAT
-- apportionment is ever needed.
--
-- APPLY ORDER: run this BEFORE any org sets vat_percent > 0. The product form
-- only sends `zero_rated` once an org is VAT-registered, so a non-VAT fleet is
-- unaffected either way — but enabling VAT before this lands would make product
-- saves reference a missing column.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE, replay-safe.
-- ============================================================

BEGIN;

ALTER TABLE products ADD COLUMN IF NOT EXISTS zero_rated BOOLEAN NOT NULL DEFAULT FALSE;

-- Redefine submit_sale_batch (13-arg, current definition from 061) so a
-- zero-rated line records no VAT. Only the per-line VAT block changes from 061.
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
  v_vat_rate       NUMERIC;   -- org rate, resolved once per batch
  v_line_rate      NUMERIC;   -- 0 for a zero-rated product, else v_vat_rate
  v_tax            NUMERIC;   -- per-line VAT portion
  v_zero_rated     BOOLEAN;   -- 062: per-line zero-rating flag
BEGIN
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

  SELECT EXISTS (SELECT 1 FROM sales WHERE id = ANY(p_sale_ids))
    INTO v_already_exists;
  IF v_already_exists THEN
    RETURN p_sale_ids;
  END IF;

  SELECT COALESCE(vat_percent, 0) INTO v_vat_rate
    FROM organizations WHERE id = p_org_id;
  v_vat_rate := COALESCE(v_vat_rate, 0);

  FOR v_i IN 1..v_n LOOP
    IF p_cost_prices IS NOT NULL AND array_length(p_cost_prices, 1) >= v_i THEN
      v_cost := p_cost_prices[v_i];
    ELSE
      SELECT CASE WHEN qty_in_pack > 0 THEN ROUND(package_price / qty_in_pack, 2) ELSE 0 END
        INTO v_cost
        FROM products WHERE id = p_product_ids[v_i];
    END IF;

    -- 062: a zero-rated product charges no VAT even in a VAT-registered org.
    SELECT COALESCE(zero_rated, FALSE) INTO v_zero_rated
      FROM products WHERE id = p_product_ids[v_i];

    IF v_vat_rate > 0 AND NOT v_zero_rated THEN
      v_line_rate := v_vat_rate;
      v_tax := ROUND(p_total_amounts[v_i] - p_total_amounts[v_i] / (1 + v_vat_rate / 100), 2);
    ELSE
      v_line_rate := 0;
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
      v_cost, v_line_rate, v_tax
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

REVOKE ALL ON FUNCTION submit_sale_batch(
  UUID[], UUID, UUID, UUID[], INTEGER[], NUMERIC[], NUMERIC[],
  TEXT, TEXT, UUID, DATE, TIMESTAMPTZ, NUMERIC[]
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION submit_sale_batch(
  UUID[], UUID, UUID, UUID[], INTEGER[], NUMERIC[], NUMERIC[],
  TEXT, TEXT, UUID, DATE, TIMESTAMPTZ, NUMERIC[]
) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
