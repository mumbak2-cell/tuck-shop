-- Migration 080: Revoke EXECUTE from anon on security-critical functions
--
-- Supabase's default privileges grant EXECUTE on every new function to anon,
-- authenticated, and service_role BY NAME. REVOKE ... FROM PUBLIC (used in
-- migrations 040, 043, 044, 058, 064, 074, 075) is a different grantee and
-- leaves all three untouched. This migration explicitly revokes anon access.
--
-- Trigger functions (078-079) are invoked by the trigger mechanism, not via
-- PostgREST RPC, but revoking is defense-in-depth.
--
-- Idempotent: REVOKE on a non-existent grant is a no-op.

BEGIN;

-- ── Trigger functions (078-079) ──
REVOKE EXECUTE ON FUNCTION protect_billing_columns()    FROM anon;
REVOKE EXECUTE ON FUNCTION log_sale_void()              FROM anon;
REVOKE EXECUTE ON FUNCTION check_location_limit()       FROM anon;

-- ── RLS helper functions ──
REVOKE EXECUTE ON FUNCTION current_user_org_ids()       FROM anon;
REVOKE EXECUTE ON FUNCTION current_user_writable_org_ids() FROM anon;
REVOKE EXECUTE ON FUNCTION current_user_location_ids()  FROM anon;
REVOKE EXECUTE ON FUNCTION default_user_org_id()        FROM anon;

-- ── Stock RPCs (040 revoked PUBLIC, not anon) ──
REVOKE EXECUTE ON FUNCTION deduct_stock_at_location(UUID, INTEGER, UUID, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION add_product_stock_at_location(UUID, INTEGER, UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION transfer_stock(UUID, UUID, UUID, INTEGER, TEXT, TEXT) FROM anon;

-- ── Customer balance (039/040) ──
REVOKE EXECUTE ON FUNCTION adjust_customer_balance(UUID, NUMERIC) FROM anon;

-- ── Authorization guard ──
REVOKE EXECUTE ON FUNCTION assert_org_writable(UUID)    FROM anon;

-- ── WMS RPCs (040, 043, 044) ──
REVOKE EXECUTE ON FUNCTION adjust_wms_inventory(UUID, BIGINT, INT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION apply_wms_stock_count(UUID)  FROM anon;
REVOKE EXECUTE ON FUNCTION receive_wms_stock(TEXT, TEXT, TEXT, INTEGER[], INTEGER[], INTEGER[], NUMERIC[]) FROM anon;
-- process_tilify_dispatch was dropped in migration 043
REVOKE EXECUTE ON FUNCTION create_wms_dispatch(TEXT, UUID, TEXT, JSONB, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION record_wms_adjustment(BIGINT, INT, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION receive_wms_purchase_order(BIGINT, BIGINT[], INTEGER[], TEXT) FROM anon;

-- ── Sale RPCs (029, 058, 064, 073, 074, 075) ──
REVOKE EXECUTE ON FUNCTION submit_sale_batch(
  UUID[], UUID, UUID, UUID[], INTEGER[], NUMERIC[], NUMERIC[],
  TEXT, TEXT, UUID, DATE, TIMESTAMPTZ, NUMERIC[], BOOLEAN[], NUMERIC
) FROM anon;
REVOKE EXECUTE ON FUNCTION record_sale_return(UUID, INTEGER, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION void_sale_lines(UUID[], TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION find_sale_by_receipt_code(TEXT) FROM anon;

-- ── Restock helper (064) ──
REVOKE EXECUTE ON FUNCTION restock_at_location(UUID, UUID, INTEGER) FROM anon;

-- ── Recipe cost trigger function ──
REVOKE EXECUTE ON FUNCTION recalc_recipe_cost(UUID) FROM anon;

-- ── Signup / org creation ──
REVOKE EXECUTE ON FUNCTION create_organization_for_user(TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION generate_inventory_id(UUID) FROM anon;

-- ── Platform admin helper ──
REVOKE EXECUTE ON FUNCTION is_platform_admin() FROM anon;

COMMIT;
