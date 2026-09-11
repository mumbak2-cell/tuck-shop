-- ============================================================
-- Migration 123: Sale RPC integrity guards (Security Phase 2 — RPC layer)
-- Spec: docs/superpowers/specs/2026-09-11-definer-rpc-role-guards-design.md
--
-- void_sale_lines: migration 077 moved void_sales off the shared till PIN
-- onto the named manager's own permission grant, specifically for
-- accountability. The RPC itself never enforced this — a cashier calling
-- it directly over PostgREST bypassed the UI gate entirely. This adds
-- a permission check next to the existing per-row assertion call.
--
-- submit_sale_batch: cashiers ARE meant to sell — see that statement's own
-- header below for the location-scope fix.
--
-- Idempotent. Safe to re-run.
--
-- BEHAVIOUR CHANGE — read before applying:
--   An admin without the void_sales permission key (or any cashier) will
--   now be REJECTED by void_sale_lines even if called directly, not just
--   hidden from in the UI. No legitimate current user should be affected
--   (the UI already prevents them from reaching the void action), but
--   this is a live-sales-path function — apply outside trading hours,
--   after the verification in
--   docs/superpowers/plans/artifacts/2026-09-11-verification-123.sql
--   passes on a non-production org.
--
--   submit_sale_batch also gains a new rejection path: a sale queued
--   offline before a cashier's assigned_location_id is reassigned will
--   replay with the old branch and now raise 42501. It is not lost —
--   offline-sync.ts parks it after MAX_RETRIES_BEFORE_PARK attempts for
--   manual review — but it will not land until resubmitted. Narrow
--   window (requires a reassignment mid-outage), but real.
--
-- PRE-APPLY GATE — read before running this in the SQL Editor:
--   Both function bodies in this file were built from migration history,
--   not a live query (no DB connection was available while authoring
--   them). Before applying, run
--   SELECT pg_get_functiondef('public.void_sale_lines'::regproc);
--   SELECT pg_get_functiondef('public.submit_sale_batch'::regproc);
--   and diff each against the body in this file. void_sale_lines should
--   differ only by the added PERFORM assert_org_permission(...) line;
--   submit_sale_batch only by the two new DECLARE variables and the new
--   IF block. If a live body differs anywhere else, the live definition
--   is authoritative — rebase that statement on it before applying, the
--   same way migration 035 showed migration files can silently drift
--   from what's actually running.
--
-- Record with:
--   node node_modules/supabase/dist/supabase.js migration repair \
--     --status applied 123
-- ============================================================

-- STATEMENT 1: void_sale_lines — add assert_org_permission next to the
-- existing per-row assert_org_writable call. Body otherwise unchanged
-- from 074.
CREATE OR REPLACE FUNCTION public.void_sale_lines(
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
    PERFORM assert_org_permission(r.org_id, 'void_sales');

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

REVOKE ALL ON FUNCTION public.void_sale_lines(UUID[], TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_sale_lines(UUID[], TEXT, TEXT) TO authenticated;

-- STATEMENT 2: submit_sale_batch — add a location-scope check for
-- role='member' callers. Owner/admin unchanged. No new parameter,
-- same 15-argument signature as 114/101.
CREATE OR REPLACE FUNCTION public.submit_sale_batch(p_sale_ids uuid[], p_org_id uuid, p_location_id uuid, p_product_ids uuid[], p_quantities integer[], p_unit_prices numeric[], p_total_amounts numeric[], p_payment_method text, p_payment_reference text, p_customer_id uuid, p_sale_date date, p_created_at timestamp with time zone, p_cost_prices numeric[] DEFAULT NULL::numeric[], p_is_wholesale boolean[] DEFAULT NULL::boolean[], p_cash_back numeric DEFAULT 0)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_i              INTEGER;
  v_n              INTEGER;
  v_credit_total   NUMERIC := 0;
  v_existing_count INTEGER;
  v_undeducted     INTEGER;
  v_cost           NUMERIC;
  v_wholesale      BOOLEAN;
  v_txn_id         UUID;
  v_role           TEXT;
  v_assigned       UUID;
BEGIN
  PERFORM assert_org_writable(p_org_id);

  SELECT role, assigned_location_id INTO v_role, v_assigned
    FROM org_members
   WHERE org_id = p_org_id AND user_id = auth.uid();

  IF v_role = 'member' AND v_assigned IS NOT NULL AND v_assigned IS DISTINCT FROM p_location_id THEN
    RAISE EXCEPTION 'Not authorised to record sales at this location'
      USING ERRCODE = '42501';
  END IF;

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
$function$
;

NOTIFY pgrst, 'reload schema';
