-- ============================================================
-- Migration 119 verification queries — run against the synthetic rig
-- after `bash docs/superpowers/plans/artifacts/rig_load.sh`:
--   docker exec -i rls_rig psql -U postgres -d postgres -f - < docs/superpowers/plans/artifacts/verification.sql
--
-- Pass criteria:
--   Q1  one row: provolatile=s, prosecdef=t, proconfig={search_path=""},
--       ACL grants authenticated, not anon/PUBLIC
--   Q2  0 rows  (every must-gate write policy references the helper in the right clause)
--   Q4  every FOR-ALL-decompose table: n_read=1, read_wrongly_gated=f, n_write=3
--   Q5  0 rows  (no INSERT/UPDATE/DELETE policy on a true append-only ledger)
-- ============================================================

\echo '=== Q1: helper function attributes ==='
SELECT p.proname,
       p.provolatile,                       -- expect s (STABLE)
       p.prosecdef,                         -- expect t (SECURITY DEFINER)
       p.proconfig,                         -- expect {search_path=""}
       pg_catalog.pg_get_function_result(p.oid) AS result_type
FROM pg_proc p
WHERE p.proname = 'current_user_manager_org_ids';

\echo '--- Q1 ACL (expect authenticated=X; no anon, no PUBLIC/empty-grantee) ---'
SELECT COALESCE(r.rolname, 'PUBLIC') AS grantee, a.privilege_type
FROM pg_proc p
CROSS JOIN LATERAL aclexplode(p.proacl) a
LEFT JOIN pg_roles r ON r.oid = a.grantee
WHERE p.proname = 'current_user_manager_org_ids'
ORDER BY 1;

\echo ''
\echo '=== Q2: write-policy gate coverage (expect 0 rows) ==='
-- must_gate(tbl, cmd): every Bucket A INSERT/UPDATE/DELETE + the Bucket B
-- manager-gated commands. Frozen from table-classification.md, not chosen at
-- run time. A row here = a policy that should carry the manager gate and does
-- not (in the right clause). INSERT -> WITH CHECK, DELETE -> USING,
-- UPDATE -> USING (and WITH CHECK too when the policy has one).
WITH must_gate(tbl, cmd) AS (VALUES
  -- Bucket A canonical (14)
  ('app_settings','a'),('app_settings','w'),('app_settings','d'),
  ('categories','a'),('categories','w'),('categories','d'),
  ('expense_categories','a'),('expense_categories','w'),('expense_categories','d'),
  ('ingredients','a'),('ingredients','w'),('ingredients','d'),
  ('locations','a'),('locations','w'),('locations','d'),
  ('payment_methods','a'),('payment_methods','w'),('payment_methods','d'),
  ('production_log','a'),('production_log','w'),('production_log','d'),
  ('products','a'),('products','w'),('products','d'),
  ('purchases','a'),('purchases','w'),('purchases','d'),
  ('ra_notes','a'),('ra_notes','w'),('ra_notes','d'),
  ('recipes','a'),('recipes','w'),('recipes','d'),
  ('stock_receipt_items','a'),('stock_receipt_items','w'),('stock_receipt_items','d'),
  ('stock_receipts','a'),('stock_receipts','w'),('stock_receipts','d'),
  ('suppliers','a'),('suppliers','w'),('suppliers','d'),
  -- Bucket A explicit _loc_/bare/plp_
  ('balance_adjustments','a'),('balance_adjustments','w'),('balance_adjustments','d'),
  ('stock_adjustments','a'),('stock_adjustments','w'),('stock_adjustments','d'),
  ('sales','a'),
  ('combos','a'),('combos','w'),('combos','d'),
  ('promotions','a'),('promotions','w'),('promotions','d'),
  ('purchase_orders','a'),('purchase_orders','w'),('purchase_orders','d'),
  ('location_settings','a'),('location_settings','w'),('location_settings','d'),
  ('report_subscriptions','a'),('report_subscriptions','w'),('report_subscriptions','d'),
  ('product_location_prices','a'),('product_location_prices','w'),('product_location_prices','d'),
  -- Bucket A child
  ('combo_items','a'),('combo_items','d'),
  ('promotion_items','a'),('promotion_items','d'),
  ('purchase_order_items','a'),('purchase_order_items','d'),
  -- Bucket A FOR ALL decompose (group 1)
  ('wms_adjustments','a'),('wms_adjustments','w'),('wms_adjustments','d'),
  ('wms_catalog','a'),('wms_catalog','w'),('wms_catalog','d'),
  ('wms_dispatch_items','a'),('wms_dispatch_items','w'),('wms_dispatch_items','d'),
  ('wms_dispatches','a'),('wms_dispatches','w'),('wms_dispatches','d'),
  ('wms_inventory','a'),('wms_inventory','w'),('wms_inventory','d'),
  ('wms_po_items','a'),('wms_po_items','w'),('wms_po_items','d'),
  ('wms_purchase_orders','a'),('wms_purchase_orders','w'),('wms_purchase_orders','d'),
  ('wms_receipt_items','a'),('wms_receipt_items','w'),('wms_receipt_items','d'),
  ('wms_receipts','a'),('wms_receipts','w'),('wms_receipts','d'),
  ('wms_stock_count_audit','a'),('wms_stock_count_audit','w'),('wms_stock_count_audit','d'),
  ('wms_stock_counts','a'),('wms_stock_counts','w'),('wms_stock_counts','d'),
  ('wms_stock_count_sessions','a'),('wms_stock_count_sessions','w'),('wms_stock_count_sessions','d'),
  -- Bucket A FOR ALL decompose (group 2)
  ('wms_locations','a'),('wms_locations','w'),('wms_locations','d'),
  ('wms_org_settings','a'),('wms_org_settings','w'),('wms_org_settings','d'),
  ('zra_config','a'),('zra_config','w'),('zra_config','d'),
  ('zra_invoices','a'),('zra_invoices','w'),('zra_invoices','d'),
  -- Bucket B manager-gated commands
  ('customer_payments','w'),('customer_payments','d'),
  ('customers','w'),('customers','d'),
  ('shifts','d'),
  ('daily_reconciliation','d'),
  ('stock_count_audit','w'),('stock_count_audit','d')
)
SELECT mg.tbl, mg.cmd, p.polname,
       COALESCE(pg_get_expr(p.polqual, p.polrelid), '(none)')      AS using_expr,
       COALESCE(pg_get_expr(p.polwithcheck, p.polrelid), '(none)') AS check_expr,
       CASE
         WHEN p.polname IS NULL THEN 'no policy for this command'
         ELSE 'gate missing in required clause'
       END AS failure
FROM must_gate mg
JOIN pg_class c ON c.relname = mg.tbl AND c.relnamespace = 'public'::regnamespace
LEFT JOIN pg_policy p ON p.polrelid = c.oid AND p.polcmd = mg.cmd
WHERE
  p.polname IS NULL
  OR (mg.cmd = 'a' AND COALESCE(pg_get_expr(p.polwithcheck, p.polrelid),'') NOT LIKE '%current_user_manager_org_ids%')
  OR (mg.cmd = 'd' AND COALESCE(pg_get_expr(p.polqual, p.polrelid),'')      NOT LIKE '%current_user_manager_org_ids%')
  OR (mg.cmd = 'w' AND (
        COALESCE(pg_get_expr(p.polqual, p.polrelid),'') NOT LIKE '%current_user_manager_org_ids%'
        OR (p.polwithcheck IS NOT NULL
            AND pg_get_expr(p.polwithcheck, p.polrelid) NOT LIKE '%current_user_manager_org_ids%')
     ))
ORDER BY 1, 2;

\echo ''
\echo '=== Q4: FOR-ALL decompose shape (expect n_read=1, read_wrongly_gated=f, n_write=3 for all) ==='
WITH forall_tables(t) AS (VALUES
  ('wms_adjustments'),('wms_catalog'),('wms_dispatch_items'),('wms_dispatches'),
  ('wms_inventory'),('wms_po_items'),('wms_purchase_orders'),('wms_receipt_items'),
  ('wms_receipts'),('wms_stock_count_audit'),('wms_stock_counts'),('wms_stock_count_sessions'),
  ('wms_locations'),('wms_org_settings'),('zra_config'),('zra_invoices')
)
SELECT c.relname,
       count(*) FILTER (WHERE p.polcmd = 'r')                                    AS n_read,
       bool_or(p.polcmd = 'r'
               AND pg_get_expr(p.polqual, p.polrelid) LIKE '%current_user_manager_org_ids%') AS read_wrongly_gated,
       count(*) FILTER (WHERE p.polcmd IN ('a','w','d'))                         AS n_write,
       count(*) FILTER (WHERE p.polcmd = '*')                                    AS n_forall_left
FROM pg_class c
JOIN forall_tables ft ON ft.t = c.relname
LEFT JOIN pg_policy p ON p.polrelid = c.oid
WHERE c.relnamespace = 'public'::regnamespace
GROUP BY c.relname
ORDER BY c.relname;

\echo ''
\echo '=== Q5: no write policy on true append-only ledgers (expect 0 rows) ==='
SELECT c.relname, p.polname, p.polcmd
FROM pg_policy p
JOIN pg_class c ON c.oid = p.polrelid
WHERE c.relname IN ('stock_movements','stock_oversells','stock_transfers','wms_transfers','wms_transfer_items')
  AND p.polcmd IN ('a','w','d')
ORDER BY 1, 3;
