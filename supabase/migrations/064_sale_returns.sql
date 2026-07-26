-- ============================================================
-- Migration 064: Sale returns / credit notes
--
-- Tilify only had a full VOID (cancel a whole sale line). This adds partial
-- customer returns recorded as a NEGATIVE sales row linked to the original.
--
-- Why negative rows, not a separate table: Tilify's reporting is built on
-- per-row snapshots (unit_price, cost_price, tax_amount captured at sale time).
-- A negative row nets out AUTOMATICALLY in every existing sum — revenue, COGS,
-- output VAT, cash intake, Revenue-Assurance movement, the daily email — so no
-- report has to learn about returns. A return row is identified by
-- return_of_sale_id being set.
--
-- Cash-sale return  -> negative cash row (reduces the day's cash intake = money
--                      out of the till), goods restocked.
-- Credit-sale return-> customer balance reduced (they owe less); you don't cash-
--                      refund goods that were never paid for.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE, replay-safe.
-- ============================================================

BEGIN;

ALTER TABLE sales ADD COLUMN IF NOT EXISTS return_of_sale_id UUID REFERENCES sales(id);
ALTER TABLE sales ADD COLUMN IF NOT EXISTS credit_note_number TEXT;
CREATE INDEX IF NOT EXISTS idx_sales_return_of ON sales(return_of_sale_id);

-- Records a return of p_quantity units of an existing sale. Atomic:
-- inserts the negative snapshot row, restocks the branch, and reverses the
-- receivable for a credit sale. The reason rides on void_reason (unused on a
-- return row, which is never itself voided).
CREATE OR REPLACE FUNCTION record_sale_return(
  p_original_sale_id   UUID,
  p_quantity           INTEGER,
  p_reason             TEXT,
  p_credit_note_number TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  o                  sales%ROWTYPE;
  v_already_returned INTEGER;
  v_new_id           UUID;
  v_unit_tax         NUMERIC;
  v_return_total     NUMERIC;
  v_return_tax       NUMERIC;
BEGIN
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'record_sale_return: quantity must be positive' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO o FROM sales WHERE id = p_original_sale_id;
  IF o.id IS NULL THEN
    RAISE EXCEPTION 'Original sale not found' USING ERRCODE = '42501';
  END IF;
  IF o.return_of_sale_id IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot return a return' USING ERRCODE = '22023';
  END IF;
  IF o.voided THEN
    RAISE EXCEPTION 'Cannot return a voided sale' USING ERRCODE = '22023';
  END IF;

  PERFORM assert_org_writable(o.org_id);

  -- Units already returned against this sale (return rows store negative qty).
  SELECT COALESCE(SUM(-quantity), 0) INTO v_already_returned
    FROM sales
   WHERE return_of_sale_id = p_original_sale_id AND voided = false;

  IF p_quantity > (o.quantity - v_already_returned) THEN
    RAISE EXCEPTION 'Return exceeds remaining quantity: % of % already returned',
      v_already_returned, o.quantity USING ERRCODE = '22023';
  END IF;

  -- Proportional snapshot from the original line. Per-unit VAT is derived from
  -- the original's tax_amount so a zero-rated line reverses no VAT.
  v_return_total := ROUND(o.unit_price * p_quantity, 2);
  v_unit_tax     := CASE WHEN o.quantity > 0 THEN COALESCE(o.tax_amount, 0) / o.quantity ELSE 0 END;
  v_return_tax   := ROUND(v_unit_tax * p_quantity, 2);

  v_new_id := gen_random_uuid();

  INSERT INTO sales (
    id, org_id, sale_date, product_id, quantity, unit_price, total_amount,
    payment_method, customer_id, location_id, created_at,
    cost_price, tax_rate, tax_amount,
    return_of_sale_id, credit_note_number, void_reason
  ) VALUES (
    v_new_id, o.org_id, CURRENT_DATE, o.product_id, -p_quantity, o.unit_price, -v_return_total,
    o.payment_method, o.customer_id, o.location_id, NOW(),
    o.cost_price, o.tax_rate, -v_return_tax,
    p_original_sale_id, p_credit_note_number, NULLIF(TRIM(p_reason), '')
  );

  -- Put the goods back on the shelf (increment-only RPC, migration 060).
  IF o.location_id IS NOT NULL THEN
    PERFORM restock_at_location(o.product_id, p_quantity, o.location_id);
  END IF;

  -- Credit sale: reduce what the customer owes rather than pay out cash.
  IF lower(o.payment_method) LIKE '%credit%' AND o.customer_id IS NOT NULL THEN
    PERFORM adjust_customer_balance(o.customer_id, -v_return_total);
  END IF;

  RETURN v_new_id;
END;
$$;

REVOKE ALL ON FUNCTION record_sale_return(UUID, INTEGER, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_sale_return(UUID, INTEGER, TEXT, TEXT) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- VERIFY (run separately, after commit)
--
--   -- Columns + function exist:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'sales' AND column_name IN ('return_of_sale_id','credit_note_number');
--   SELECT proname FROM pg_proc WHERE proname = 'record_sale_return';
--
--   -- The real test is from the app: partial-return a cash sale and confirm the
--   -- negative row, the restock, and (for a credit sale) the reduced balance.
-- ============================================================
