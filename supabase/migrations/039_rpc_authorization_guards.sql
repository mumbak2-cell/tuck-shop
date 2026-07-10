-- ============================================================
-- Migration 039: Authorization guards on SECURITY DEFINER RPCs
--
-- Migration 035 hardened the RLS write policies to use
-- current_user_writable_org_ids(), closing the trial/subscription gate
-- on every business table. It did not touch the RPCs — and RLS does not
-- apply inside a SECURITY DEFINER function, which runs as the function
-- owner. Two of them take a caller-supplied id and never check who is
-- calling:
--
--   submit_sale_batch(p_org_id, ...)     GRANT EXECUTE TO authenticated
--   adjust_customer_balance(p_customer_id, p_delta)
--
-- Consequences before this migration:
--
--   1. Cross-tenant write. Any authenticated user could pass another
--      org's UUID to submit_sale_batch and insert sales into that org,
--      deduct its stock, and inflate its customers' credit balances.
--      adjust_customer_balance would move any customer's balance by any
--      amount, in any org.
--
--   2. Billing bypass. The POS is the primary write path in the product
--      and it went through submit_sale_batch, so the trial and
--      subscription gate never applied to it. A lapsed org was blocked
--      only incidentally: the POS refuses to render without an open
--      shift, and `shifts` is an ordinary RLS-gated table.
--
-- This migration adds an authorization check to both, and restores the
-- `SET search_path` that migration 037 dropped from
-- adjust_customer_balance (a SECURITY DEFINER function without a pinned
-- search_path is vulnerable to resolution hijacking).
--
-- BEHAVIOUR CHANGE — read before deploying:
--
--   Sales become genuinely gated. An org whose trial has lapsed can no
--   longer record sales via the RPC, and any queued offline sale will
--   now FAIL on replay rather than silently succeed. The op is not lost:
--   offline-sync.ts increments its attempt count and parks it after 8
--   tries, leaving it in localStorage. But it will not land until the
--   org is writable again.
--
--   Therefore: extend any lapsed trial for a live customer BEFORE
--   running this. As of 2026-07-10 that means Jinel Business Park
--   Stationery and Chichi's Bakes and Accessories.
--
--   Service-role callers are rejected too, since auth.uid() is NULL for
--   them and no org would match. No server route calls either function
--   today. If one is added later it must not go through these.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Shared guard. Raises unless the current user may write to p_org_id.
--
--    Delegates to current_user_writable_org_ids() rather than restating
--    the predicate, so the trial/subscription rules live in exactly one
--    place (see migrations 018 and 035).
--
--    STABLE, not VOLATILE: it only reads.
--
--    Left as SECURITY INVOKER (the default). That is safe here, and the
--    guard still identifies the real end user, because auth.uid() reads
--    the request.jwt.claims GUC that PostgREST sets per request — it does
--    not depend on the current SQL role. So it returns the cashier's id
--    even when reached from inside a SECURITY DEFINER function running as
--    the function owner.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_org_writable(p_org_id UUID)
RETURNS VOID
LANGUAGE plpgsql STABLE
SET search_path = public
AS $$
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'assert_org_writable: org_id is required'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM current_user_writable_org_ids() w WHERE w = p_org_id
  ) THEN
    -- 42501 = insufficient_privilege. PostgREST maps this to HTTP 403,
    -- and offline-ops.ts treats a non-network error as a logical failure,
    -- so the cashier sees the message rather than the sale being queued.
    RAISE EXCEPTION 'Not authorised to write to this organisation, or its subscription is not active'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

-- ------------------------------------------------------------
-- 2. submit_sale_batch — same body as migration 034, with the guard
--    block added. Every id the caller supplies is now checked to belong
--    to p_org_id, so a valid org_id cannot be used as a lever to touch
--    another org's products, locations, or customers.
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
BEGIN
  -- >>> Added in 039: authorization. Must come first, before any read
  -- >>> of another org's rows and before any write.
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

  -- >>> Added in 039: every referenced row must belong to p_org_id.
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
  -- <<< end 039 additions

  -- Idempotency. NOTE: unchanged from 034, and still partial-batch unsafe —
  -- if ANY id in p_sale_ids already exists the whole batch is treated as a
  -- replay and skipped. Safe for the current caller, which always generates
  -- a fresh id set per batch and replays the identical set. Not fixed here
  -- to keep this migration to the security change.
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

-- ------------------------------------------------------------
-- 3. adjust_customer_balance — derive the org from the customer, then
--    apply the same guard. Body otherwise as migration 037 (M13 removed
--    the GREATEST(...,0) clamp so overpayments can go negative).
--
--    Also restores `SET search_path = public`, which 037 dropped.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION adjust_customer_balance(
  p_customer_id UUID,
  p_delta NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id      UUID;
  v_new_balance NUMERIC;
BEGIN
  SELECT org_id INTO v_org_id FROM customers WHERE id = p_customer_id;
  IF v_org_id IS NULL THEN
    -- Same message whether the customer is absent or in another org, so
    -- this cannot be used to probe for the existence of ids.
    RAISE EXCEPTION 'Customer not found: %', p_customer_id
      USING ERRCODE = '42501';
  END IF;

  PERFORM assert_org_writable(v_org_id);

  UPDATE customers
     SET balance = balance + p_delta
   WHERE id = p_customer_id
  RETURNING balance INTO v_new_balance;

  RETURN v_new_balance;
END;
$$;

COMMIT;


-- ============================================================
-- VERIFY (run separately, after commit)
--
-- Both functions should now refuse a foreign org. As a platform admin in
-- the SQL editor you are the `postgres` role, not `authenticated`, so
-- auth.uid() is NULL and every call should raise 42501. That in itself
-- confirms the guard fires:
--
--   SELECT submit_sale_batch(
--     ARRAY[gen_random_uuid()], '37a64143-f36b-4091-af2e-93d2108f3b30'::uuid,
--     gen_random_uuid(), ARRAY[gen_random_uuid()], ARRAY[1], ARRAY[1.0],
--     ARRAY[1.0], 'cash', NULL, NULL, CURRENT_DATE, NOW(), NULL);
--   -- expected: ERROR ... Not authorised to write to this organisation
--
-- The real test is from the app: sign in as a cashier on a writable org
-- and complete a sale. It must still succeed.
-- ============================================================


-- ============================================================
-- STILL OPEN after this migration — NOT fixed here
--
-- Nine other SECURITY DEFINER functions have no explicit GRANT, which
-- means they retain PostgreSQL's default EXECUTE-to-PUBLIC. No migration
-- in this repo issues a REVOKE. Six of them are called directly from the
-- browser and take ids without checking the caller's org:
--
--   deduct_stock_at_location     add_product_stock_at_location
--   add_product_stock            add_ingredient_stock
--   transfer_stock               apply_wms_stock_count
--   receive_wms_stock            process_tilify_dispatch
--   adjust_wms_inventory
--
-- transfer_stock and deduct_stock_at_location are the sharpest: both are
-- reachable from the client and mutate product_stock by id. They deserve
-- the same assert_org_writable() treatment plus an explicit
-- REVOKE EXECUTE ... FROM PUBLIC / GRANT ... TO authenticated pair.
--
-- Left out of 039 deliberately: each needs its own org-derivation path
-- and its own test, and this migration should stay small enough to
-- reason about while a live customer is mid-trial.
-- ============================================================
