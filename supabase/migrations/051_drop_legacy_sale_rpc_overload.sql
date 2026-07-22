-- ============================================================
-- Migration 051: Drop the unguarded legacy submit_sale_batch overload
--
-- submit_sale_batch existed in two overloads:
--
--   * 13-arg (…, p_cost_prices numeric[] DEFAULT NULL) — the version every
--     client calls. Authorization has been enforced here since 039 via
--     assert_org_writable(p_org_id): the caller must belong to the org AND the
--     org must be paid / in trial.
--
--   * 12-arg — left behind when 034 added p_cost_prices. It never received the
--     guard, so it stayed callable through PostgREST by any authenticated user
--     against ANY org_id, bypassing both the membership check and the
--     subscription gate.
--
-- Because the surviving overload defaults p_cost_prices, a 12-argument call
-- still resolves to it, so dropping the legacy one is safe for any old client
-- or in-flight offline replay — such a call simply lands on the guarded
-- version with NULL cost prices.
--
-- Dropping (rather than guarding) also removes a real ambiguity: with both
-- present, a 12-argument positional call matched BOTH candidates and failed
-- with "function is not unique" (42725).
-- ============================================================

BEGIN;

DROP FUNCTION IF EXISTS public.submit_sale_batch(
  uuid[],                    -- p_sale_ids
  uuid,                      -- p_org_id
  uuid,                      -- p_location_id
  uuid[],                    -- p_product_ids
  integer[],                 -- p_quantities
  numeric[],                 -- p_unit_prices
  numeric[],                 -- p_total_amounts
  text,                      -- p_payment_method
  text,                      -- p_payment_reference
  uuid,                      -- p_customer_id
  date,                      -- p_sale_date
  timestamp with time zone   -- p_created_at
);

COMMIT;
