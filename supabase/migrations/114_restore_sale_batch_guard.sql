-- ============================================================
-- Migration 114: Restore the authorization guard on submit_sale_batch,
-- and stop anon EXECUTE on SECURITY DEFINER functions from recurring
--
-- Migration 039 added `PERFORM assert_org_writable(p_org_id);` as the
-- first statement of submit_sale_batch — required so a caller can't
-- pass another org's p_org_id and write sales rows into it. Migration
-- 101 rewrote the function with CREATE OR REPLACE (two-phase
-- idempotency, new p_cost_prices/p_is_wholesale/p_cash_back params)
-- and did not carry the guard forward. Confirmed against the live
-- definition dumped via pg_get_functiondef: identical to 101 apart
-- from formatting, no assert_org_writable call, no auth.uid() anywhere
-- in the body. submit_sale_batch is SECURITY DEFINER, so RLS never
-- applied inside it either — any authenticated user could write sales
-- into an org they don't belong to.
--
-- anon could reach the same hole over PostgREST; that path was closed
-- by a manual REVOKE run directly against production, which is not
-- itself in version control. Part 2 below restates that revoke (and
-- every other SECURITY DEFINER function anon can still reach) from a
-- migration so it's no longer only a hand-run, undocumented change.
-- Part 3 stops it recurring: Supabase's default privileges grant
-- EXECUTE to anon on every newly created function, which is why
-- migration 080's by-hand revokes silently came undone as soon as
-- 084/089/090/101 recreated functions.
--
-- Part 1 is a one-line diff against the live function body — only the
-- guard statement is added, nothing else in the definition changes.
-- 039, 040 and 101 are applied migrations and are left untouched.
--
-- Idempotent. Safe to re-run.
--
-- Record with:
--   node node_modules/supabase/dist/supabase.js migration repair \
--     --status applied 114
-- ============================================================


-- ============================================================
-- PART 1: submit_sale_batch — restore the assert_org_writable guard
--
-- Live body, verbatim, plus one added line (first statement after
-- BEGIN): PERFORM assert_org_writable(p_org_id);
-- ============================================================

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


-- ============================================================
-- PART 2: Revoke anon EXECUTE across all SECURITY DEFINER functions
--
-- Dynamic loop rather than by-hand signatures — 080's by-hand revokes
-- came undone when later migrations recreated the functions.
--
-- create_organization_for_user is deliberately excluded: it self-guards
-- on auth.uid() and revoking anon here could break signup before a
-- session exists.
-- ============================================================

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND p.proname <> 'create_organization_for_user'
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', r.sig);
  END LOOP;
END $$;


-- ============================================================
-- PART 3: Stop the recurrence — default privileges for future functions
--
-- Supabase's default privileges grant EXECUTE to anon on every newly
-- created function, which is why 080's revokes silently came undone
-- when 084/089/090/101 recreated functions. Without this, any future
-- CREATE FUNCTION re-opens the hole Part 2 just closed.
-- ============================================================

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;


-- ============================================================
-- Verification (run manually in SQL Editor after applying)
-- ============================================================
-- SELECT pg_get_functiondef(oid) ~ 'assert_org_writable' AS guard_restored
--   FROM pg_proc WHERE proname = 'submit_sale_batch';   -- must be true
-- SELECT count(*) AS anon_executable_secdef
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname='public' AND p.prosecdef
--    AND has_function_privilege('anon', p.oid, 'EXECUTE');  -- must be 1
-- ============================================================
