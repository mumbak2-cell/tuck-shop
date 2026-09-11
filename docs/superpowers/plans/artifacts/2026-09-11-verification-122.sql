-- Verification for migration 122 — WMS admin-only RPC guard.
-- Run each block against a NON-PRODUCTION org with three real test
-- logins: an owner, an admin, and a member (cashier). Do not use real
-- customer PINs/credentials — create disposable test accounts.
--
-- Every block should be run twice: once authenticated as the member
-- (expect 42501 / HTTP 403), once as the owner or admin (expect success).

-- 1. Direct SQL check (run as each role via `SET request.jwt.claims` or
--    the SQL Editor's "run as user", or via a PostgREST curl call):
SELECT record_wms_adjustment(
  p_wms_item_id := <a real wms_catalog.id in the test org>,
  p_adjustment_qty := 1,
  p_reason := 'Correction'
);
-- Member: must raise 42501. Owner/admin: must succeed.

-- 2. PostgREST — the path a direct-bypass attempt would actually use.
-- Replace <PROJECT_URL>, <ANON_KEY>, <MEMBER_JWT> with the test org's values.
--
-- curl -s -X POST '<PROJECT_URL>/rest/v1/rpc/record_wms_adjustment' \
--   -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <MEMBER_JWT>" \
--   -H "Content-Type: application/json" \
--   -d '{"p_wms_item_id": <id>, "p_adjustment_qty": 1, "p_reason": "Correction"}'
-- Expect: HTTP 42501-mapped error (403-class), NOT a 200 with a new
-- wms_adjustments row.

-- 3. Spot-check two more of the 17 batch-guarded functions the same way
--    (pick one dispatch-flow function and one receiving-flow function,
--    e.g. create_wms_dispatch and receive_wms_stock) — full behavioural
--    coverage of all 17 isn't required, they're mechanically identical,
--    but confirm at least two actually reject a member call over
--    PostgREST, not just in the SQL Editor.

-- 4. Confirm nothing legitimate broke: as the OWNER test account, run a
--    real WMS receive → dispatch → adjust cycle through the actual app UI
--    (not just the RPC) and confirm each step still succeeds.
