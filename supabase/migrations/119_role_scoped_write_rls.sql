-- ============================================================
-- Migration 119: Role-scoped write RLS  (Security Phase 2)
-- Spec:  docs/superpowers/specs/2026-09-08-role-scoped-write-rls-design.md
-- Plan:  docs/superpowers/plans/2026-09-08-role-scoped-write-rls.md
-- Body transcribed verbatim from
--        docs/superpowers/plans/artifacts/table-classification.md
--        (itself derived from the prod pg_policy dump, project pkufxpyrvcygobrgneep).
--
-- What it does: adds public.current_user_manager_org_ids() and appends
--   AND org_id IN (SELECT current_user_manager_org_ids())
-- to the INSERT / UPDATE / DELETE RLS policies of every org-scoped table a
-- role='member' account can currently write via PostgREST and should not.
-- SELECT policies are left functionally unchanged. A frozen whitelist
-- (Bucket B) keeps the write paths a real Model-2 cashier needs.
--
-- Apply:  Supabase SQL Editor (project pkufxpyrvcygobrgneep), start of a
--         full closed day. Then:  npx supabase migration repair --status applied 119
-- Verify: docs/superpowers/plans/artifacts/verification.sql
-- Rollback: docs/superpowers/plans/artifacts/rollback_119.sql
-- Re-runnable: every CREATE is preceded by DROP POLICY IF EXISTS;
--             the helper is CREATE OR REPLACE.
-- ============================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ---- Part 1: helper -------------------------------------------------------
-- Set-returning, hardened sibling of current_user_org_ids(): returns the
-- orgs in which the calling user is an owner/admin. search_path = '' so a
-- CREATE TEMP TABLE org_members cannot shadow the lookup against this
-- SECURITY DEFINER function.
CREATE OR REPLACE FUNCTION public.current_user_manager_org_ids()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT m.org_id
  FROM public.org_members m
  WHERE m.user_id = auth.uid()
    AND m.role IN ('owner','admin');
$$;
REVOKE EXECUTE ON FUNCTION public.current_user_manager_org_ids() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.current_user_manager_org_ids() TO authenticated;

-- ---- Part 2: Bucket A canonical (_org_*, plain org-scope) ---------------
-- 14 tables, byte-identical policy shapes (verified against the dump):
--   insert  WITH CHECK (org_id IN (SELECT current_user_writable_org_ids()))
--   update  USING (org_id IN (SELECT current_user_org_ids()))
--           WITH CHECK (org_id IN (SELECT current_user_writable_org_ids()))
--   delete  USING (org_id IN (SELECT current_user_writable_org_ids()))
-- current_user_org_ids() vs current_user_writable_org_ids() preserved per
-- command exactly as the table currently uses it — not normalised.
DO $$
DECLARE
  t text;
  canonical_tables text[] := ARRAY[
    'app_settings','categories','expense_categories','ingredients','locations',
    'payment_methods','production_log','products','purchases','ra_notes',
    'recipes','stock_receipt_items','stock_receipts','suppliers'
  ];
  ins_check text := '(org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids))';
  upd_using text := '(org_id IN ( SELECT current_user_org_ids() AS current_user_org_ids))';
  upd_check text := '(org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids))';
  del_using text := '(org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids))';
  gate      text := ' AND org_id IN (SELECT current_user_manager_org_ids())';
BEGIN
  FOREACH t IN ARRAY canonical_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_org_insert', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (%s%s)',
                   t||'_org_insert', t, ins_check, gate);

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_org_update', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE USING (%s%s) WITH CHECK (%s%s)',
                   t||'_org_update', t, upd_using, gate, upd_check, gate);

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_org_delete', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE USING (%s%s)',
                   t||'_org_delete', t, del_using, gate);
  END LOOP;
END $$;

-- ---- Part 3: Bucket A explicit — _loc_* / bare-named / plp_* -----------

-- balance_adjustments (_loc_*; keep the location clause)
DROP POLICY IF EXISTS "balance_adjustments_loc_insert" ON public.balance_adjustments;
CREATE POLICY "balance_adjustments_loc_insert" ON public.balance_adjustments FOR INSERT
  WITH CHECK (((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND ((location_id IS NULL) OR (location_id IN ( SELECT current_user_location_ids() AS current_user_location_ids)))) AND org_id IN (SELECT current_user_manager_org_ids()));
DROP POLICY IF EXISTS "balance_adjustments_loc_update" ON public.balance_adjustments;
CREATE POLICY "balance_adjustments_loc_update" ON public.balance_adjustments FOR UPDATE
  USING      (((org_id IN ( SELECT current_user_org_ids() AS current_user_org_ids)) AND ((location_id IS NULL) OR (location_id IN ( SELECT current_user_location_ids() AS current_user_location_ids)))) AND org_id IN (SELECT current_user_manager_org_ids()))
  WITH CHECK (((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND ((location_id IS NULL) OR (location_id IN ( SELECT current_user_location_ids() AS current_user_location_ids)))) AND org_id IN (SELECT current_user_manager_org_ids()));
DROP POLICY IF EXISTS "balance_adjustments_loc_delete" ON public.balance_adjustments;
CREATE POLICY "balance_adjustments_loc_delete" ON public.balance_adjustments FOR DELETE
  USING (((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND ((location_id IS NULL) OR (location_id IN ( SELECT current_user_location_ids() AS current_user_location_ids)))) AND org_id IN (SELECT current_user_manager_org_ids()));

-- stock_adjustments (_loc_*; identical shape to balance_adjustments)
DROP POLICY IF EXISTS "stock_adjustments_loc_insert" ON public.stock_adjustments;
CREATE POLICY "stock_adjustments_loc_insert" ON public.stock_adjustments FOR INSERT
  WITH CHECK (((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND ((location_id IS NULL) OR (location_id IN ( SELECT current_user_location_ids() AS current_user_location_ids)))) AND org_id IN (SELECT current_user_manager_org_ids()));
DROP POLICY IF EXISTS "stock_adjustments_loc_update" ON public.stock_adjustments;
CREATE POLICY "stock_adjustments_loc_update" ON public.stock_adjustments FOR UPDATE
  USING      (((org_id IN ( SELECT current_user_org_ids() AS current_user_org_ids)) AND ((location_id IS NULL) OR (location_id IN ( SELECT current_user_location_ids() AS current_user_location_ids)))) AND org_id IN (SELECT current_user_manager_org_ids()))
  WITH CHECK (((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND ((location_id IS NULL) OR (location_id IN ( SELECT current_user_location_ids() AS current_user_location_ids)))) AND org_id IN (SELECT current_user_manager_org_ids()));
DROP POLICY IF EXISTS "stock_adjustments_loc_delete" ON public.stock_adjustments;
CREATE POLICY "stock_adjustments_loc_delete" ON public.stock_adjustments FOR DELETE
  USING (((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND ((location_id IS NULL) OR (location_id IN ( SELECT current_user_location_ids() AS current_user_location_ids)))) AND org_id IN (SELECT current_user_manager_org_ids()));

-- sales (_loc_*): gate INSERT; DROP update+delete and do NOT recreate
-- (mig 078 intent — sales mutated only via submit_sale_batch / void_sale_lines DEFINER RPCs).
DROP POLICY IF EXISTS "sales_loc_insert" ON public.sales;
CREATE POLICY "sales_loc_insert" ON public.sales FOR INSERT
  WITH CHECK (((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND ((location_id IS NULL) OR (location_id IN ( SELECT current_user_location_ids() AS current_user_location_ids)))) AND org_id IN (SELECT current_user_manager_org_ids()));
DROP POLICY IF EXISTS "sales_loc_update" ON public.sales;
DROP POLICY IF EXISTS "sales_loc_delete" ON public.sales;

-- combos (bare-named): update is USING-only — do NOT add a WITH CHECK
DROP POLICY IF EXISTS "combos_insert" ON public.combos;
CREATE POLICY "combos_insert" ON public.combos FOR INSERT
  WITH CHECK ((org_id IN ( SELECT current_user_org_ids() AS current_user_org_ids)) AND org_id IN (SELECT current_user_manager_org_ids()));
DROP POLICY IF EXISTS "combos_update" ON public.combos;
CREATE POLICY "combos_update" ON public.combos FOR UPDATE
  USING ((org_id IN ( SELECT current_user_org_ids() AS current_user_org_ids)) AND org_id IN (SELECT current_user_manager_org_ids()));
DROP POLICY IF EXISTS "combos_delete" ON public.combos;
CREATE POLICY "combos_delete" ON public.combos FOR DELETE
  USING ((org_id IN ( SELECT current_user_org_ids() AS current_user_org_ids)) AND org_id IN (SELECT current_user_manager_org_ids()));

-- promotions (bare-named): update USING-only
DROP POLICY IF EXISTS "promotions_insert" ON public.promotions;
CREATE POLICY "promotions_insert" ON public.promotions FOR INSERT
  WITH CHECK ((org_id IN ( SELECT current_user_org_ids() AS current_user_org_ids)) AND org_id IN (SELECT current_user_manager_org_ids()));
DROP POLICY IF EXISTS "promotions_update" ON public.promotions;
CREATE POLICY "promotions_update" ON public.promotions FOR UPDATE
  USING ((org_id IN ( SELECT current_user_org_ids() AS current_user_org_ids)) AND org_id IN (SELECT current_user_manager_org_ids()));
DROP POLICY IF EXISTS "promotions_delete" ON public.promotions;
CREATE POLICY "promotions_delete" ON public.promotions FOR DELETE
  USING ((org_id IN ( SELECT current_user_org_ids() AS current_user_org_ids)) AND org_id IN (SELECT current_user_manager_org_ids()));

-- purchase_orders (bare-named): update USING-only
DROP POLICY IF EXISTS "purchase_orders_insert" ON public.purchase_orders;
CREATE POLICY "purchase_orders_insert" ON public.purchase_orders FOR INSERT
  WITH CHECK ((org_id IN ( SELECT current_user_org_ids() AS current_user_org_ids)) AND org_id IN (SELECT current_user_manager_org_ids()));
DROP POLICY IF EXISTS "purchase_orders_update" ON public.purchase_orders;
CREATE POLICY "purchase_orders_update" ON public.purchase_orders FOR UPDATE
  USING ((org_id IN ( SELECT current_user_org_ids() AS current_user_org_ids)) AND org_id IN (SELECT current_user_manager_org_ids()));
DROP POLICY IF EXISTS "purchase_orders_delete" ON public.purchase_orders;
CREATE POLICY "purchase_orders_delete" ON public.purchase_orders FOR DELETE
  USING ((org_id IN ( SELECT current_user_org_ids() AS current_user_org_ids)) AND org_id IN (SELECT current_user_manager_org_ids()));

-- location_settings (bare-named): leave location_settings_read untouched (mig-100 PIN clause)
DROP POLICY IF EXISTS "location_settings_insert" ON public.location_settings;
CREATE POLICY "location_settings_insert" ON public.location_settings FOR INSERT
  WITH CHECK (((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND (location_id IN ( SELECT current_user_location_ids() AS current_user_location_ids))) AND org_id IN (SELECT current_user_manager_org_ids()));
DROP POLICY IF EXISTS "location_settings_update" ON public.location_settings;
CREATE POLICY "location_settings_update" ON public.location_settings FOR UPDATE
  USING      (((org_id IN ( SELECT current_user_org_ids() AS current_user_org_ids)) AND (location_id IN ( SELECT current_user_location_ids() AS current_user_location_ids))) AND org_id IN (SELECT current_user_manager_org_ids()))
  WITH CHECK (((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND (location_id IN ( SELECT current_user_location_ids() AS current_user_location_ids))) AND org_id IN (SELECT current_user_manager_org_ids()));
DROP POLICY IF EXISTS "location_settings_delete" ON public.location_settings;
CREATE POLICY "location_settings_delete" ON public.location_settings FOR DELETE
  USING (((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND (location_id IN ( SELECT current_user_location_ids() AS current_user_location_ids))) AND org_id IN (SELECT current_user_manager_org_ids()));

-- report_subscriptions (bare-named report_subs_*): leave report_subs_read untouched
DROP POLICY IF EXISTS "report_subs_insert" ON public.report_subscriptions;
CREATE POLICY "report_subs_insert" ON public.report_subscriptions FOR INSERT
  WITH CHECK ((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND org_id IN (SELECT current_user_manager_org_ids()));
DROP POLICY IF EXISTS "report_subs_update" ON public.report_subscriptions;
CREATE POLICY "report_subs_update" ON public.report_subscriptions FOR UPDATE
  USING      ((org_id IN ( SELECT current_user_org_ids() AS current_user_org_ids)) AND org_id IN (SELECT current_user_manager_org_ids()))
  WITH CHECK ((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND org_id IN (SELECT current_user_manager_org_ids()));
DROP POLICY IF EXISTS "report_subs_delete" ON public.report_subscriptions;
CREATE POLICY "report_subs_delete" ON public.report_subscriptions FOR DELETE
  USING ((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND org_id IN (SELECT current_user_manager_org_ids()));

-- product_location_prices (plp_*): leave plp_read untouched
DROP POLICY IF EXISTS "plp_insert" ON public.product_location_prices;
CREATE POLICY "plp_insert" ON public.product_location_prices FOR INSERT
  WITH CHECK (((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND (location_id IN ( SELECT current_user_location_ids() AS current_user_location_ids))) AND org_id IN (SELECT current_user_manager_org_ids()));
DROP POLICY IF EXISTS "plp_update" ON public.product_location_prices;
CREATE POLICY "plp_update" ON public.product_location_prices FOR UPDATE
  USING      (((org_id IN ( SELECT current_user_org_ids() AS current_user_org_ids)) AND (location_id IN ( SELECT current_user_location_ids() AS current_user_location_ids))) AND org_id IN (SELECT current_user_manager_org_ids()))
  WITH CHECK (((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND (location_id IN ( SELECT current_user_location_ids() AS current_user_location_ids))) AND org_id IN (SELECT current_user_manager_org_ids()));
DROP POLICY IF EXISTS "plp_delete" ON public.product_location_prices;
CREATE POLICY "plp_delete" ON public.product_location_prices FOR DELETE
  USING (((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND (location_id IN ( SELECT current_user_location_ids() AS current_user_location_ids))) AND org_id IN (SELECT current_user_manager_org_ids()));

-- ---- Part 4: Bucket A FOR ALL decompose --------------------------------
-- Group 1: only a FOR ALL policy exists — DROP it, create an ungated
-- <t>_org_read (old expr) + gated <t>_org_insert/update/delete.
-- All 12 share expr (qual & withcheck) = (org_id IN (SELECT current_user_org_ids())).
DO $$
DECLARE
  rec record;
  old_expr text := '(org_id IN ( SELECT current_user_org_ids() AS current_user_org_ids))';
  gate     text := ' AND org_id IN (SELECT current_user_manager_org_ids())';
  forall_tables text[] := ARRAY[
    'wms_adjustments','wms_catalog','wms_dispatch_items','wms_dispatches',
    'wms_inventory','wms_po_items','wms_purchase_orders','wms_receipt_items',
    'wms_receipts','wms_stock_count_audit','wms_stock_counts','wms_stock_count_sessions'
  ];
  t text;
  old_pol text;
BEGIN
  FOREACH t IN ARRAY forall_tables LOOP
    old_pol := CASE WHEN t = 'wms_stock_count_sessions' THEN 'wms_scs_org_isolation' ELSE 'org_isolation' END;
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', old_pol, t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_org_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (%s)', t||'_org_read', t, old_expr);

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_org_insert', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (%s%s)', t||'_org_insert', t, old_expr, gate);

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_org_update', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE USING (%s%s) WITH CHECK (%s%s)', t||'_org_update', t, old_expr, gate, old_expr, gate);

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_org_delete', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE USING (%s%s)', t||'_org_delete', t, old_expr, gate);
  END LOOP;
END $$;

-- Group 2: a FOR ALL *write* policy plus a separate _org_read.
-- DROP only the write policy; create the 3 gated writes; leave _org_read.

-- wms_locations — wms_locations_org_write, expr (both) = writable_org_ids
DROP POLICY IF EXISTS "wms_locations_org_write" ON public.wms_locations;
DROP POLICY IF EXISTS "wms_locations_org_insert" ON public.wms_locations;
CREATE POLICY "wms_locations_org_insert" ON public.wms_locations FOR INSERT
  WITH CHECK ((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND org_id IN (SELECT current_user_manager_org_ids()));
DROP POLICY IF EXISTS "wms_locations_org_update" ON public.wms_locations;
CREATE POLICY "wms_locations_org_update" ON public.wms_locations FOR UPDATE
  USING      ((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND org_id IN (SELECT current_user_manager_org_ids()))
  WITH CHECK ((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND org_id IN (SELECT current_user_manager_org_ids()));
DROP POLICY IF EXISTS "wms_locations_org_delete" ON public.wms_locations;
CREATE POLICY "wms_locations_org_delete" ON public.wms_locations FOR DELETE
  USING ((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND org_id IN (SELECT current_user_manager_org_ids()));

-- wms_org_settings — wms_org_settings_org_write, same expr
DROP POLICY IF EXISTS "wms_org_settings_org_write" ON public.wms_org_settings;
DROP POLICY IF EXISTS "wms_org_settings_org_insert" ON public.wms_org_settings;
CREATE POLICY "wms_org_settings_org_insert" ON public.wms_org_settings FOR INSERT
  WITH CHECK ((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND org_id IN (SELECT current_user_manager_org_ids()));
DROP POLICY IF EXISTS "wms_org_settings_org_update" ON public.wms_org_settings;
CREATE POLICY "wms_org_settings_org_update" ON public.wms_org_settings FOR UPDATE
  USING      ((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND org_id IN (SELECT current_user_manager_org_ids()))
  WITH CHECK ((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND org_id IN (SELECT current_user_manager_org_ids()));
DROP POLICY IF EXISTS "wms_org_settings_org_delete" ON public.wms_org_settings;
CREATE POLICY "wms_org_settings_org_delete" ON public.wms_org_settings FOR DELETE
  USING ((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND org_id IN (SELECT current_user_manager_org_ids()));

-- zra_config — zra_config_write has USING only (no withcheck); use USING as the source for all 3
DROP POLICY IF EXISTS "zra_config_write" ON public.zra_config;
DROP POLICY IF EXISTS "zra_config_org_insert" ON public.zra_config;
CREATE POLICY "zra_config_org_insert" ON public.zra_config FOR INSERT
  WITH CHECK ((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND org_id IN (SELECT current_user_manager_org_ids()));
DROP POLICY IF EXISTS "zra_config_org_update" ON public.zra_config;
CREATE POLICY "zra_config_org_update" ON public.zra_config FOR UPDATE
  USING      ((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND org_id IN (SELECT current_user_manager_org_ids()))
  WITH CHECK ((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND org_id IN (SELECT current_user_manager_org_ids()));
DROP POLICY IF EXISTS "zra_config_org_delete" ON public.zra_config;
CREATE POLICY "zra_config_org_delete" ON public.zra_config FOR DELETE
  USING ((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND org_id IN (SELECT current_user_manager_org_ids()));

-- zra_invoices — zra_invoices_write, same as zra_config
DROP POLICY IF EXISTS "zra_invoices_write" ON public.zra_invoices;
DROP POLICY IF EXISTS "zra_invoices_org_insert" ON public.zra_invoices;
CREATE POLICY "zra_invoices_org_insert" ON public.zra_invoices FOR INSERT
  WITH CHECK ((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND org_id IN (SELECT current_user_manager_org_ids()));
DROP POLICY IF EXISTS "zra_invoices_org_update" ON public.zra_invoices;
CREATE POLICY "zra_invoices_org_update" ON public.zra_invoices FOR UPDATE
  USING      ((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND org_id IN (SELECT current_user_manager_org_ids()))
  WITH CHECK ((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND org_id IN (SELECT current_user_manager_org_ids()));
DROP POLICY IF EXISTS "zra_invoices_org_delete" ON public.zra_invoices;
CREATE POLICY "zra_invoices_org_delete" ON public.zra_invoices FOR DELETE
  USING ((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND org_id IN (SELECT current_user_manager_org_ids()));

-- ---- Part 5: Bucket A child tables (no org_id column) -----------------
-- Only _insert (check) and _delete (using) exist — do NOT create _update.
-- Gate = replace current_user_org_ids() with current_user_manager_org_ids()
-- inside the parent subquery.

-- combo_items → combos
DROP POLICY IF EXISTS "combo_items_insert" ON public.combo_items;
CREATE POLICY "combo_items_insert" ON public.combo_items FOR INSERT
  WITH CHECK (combo_id IN ( SELECT combos.id FROM combos WHERE (combos.org_id IN ( SELECT current_user_manager_org_ids() AS current_user_manager_org_ids))));
DROP POLICY IF EXISTS "combo_items_delete" ON public.combo_items;
CREATE POLICY "combo_items_delete" ON public.combo_items FOR DELETE
  USING (combo_id IN ( SELECT combos.id FROM combos WHERE (combos.org_id IN ( SELECT current_user_manager_org_ids() AS current_user_manager_org_ids))));

-- promotion_items → promotions
DROP POLICY IF EXISTS "promotion_items_insert" ON public.promotion_items;
CREATE POLICY "promotion_items_insert" ON public.promotion_items FOR INSERT
  WITH CHECK (promotion_id IN ( SELECT promotions.id FROM promotions WHERE (promotions.org_id IN ( SELECT current_user_manager_org_ids() AS current_user_manager_org_ids))));
DROP POLICY IF EXISTS "promotion_items_delete" ON public.promotion_items;
CREATE POLICY "promotion_items_delete" ON public.promotion_items FOR DELETE
  USING (promotion_id IN ( SELECT promotions.id FROM promotions WHERE (promotions.org_id IN ( SELECT current_user_manager_org_ids() AS current_user_manager_org_ids))));

-- purchase_order_items → purchase_orders
DROP POLICY IF EXISTS "purchase_order_items_insert" ON public.purchase_order_items;
CREATE POLICY "purchase_order_items_insert" ON public.purchase_order_items FOR INSERT
  WITH CHECK (po_id IN ( SELECT purchase_orders.id FROM purchase_orders WHERE (purchase_orders.org_id IN ( SELECT current_user_manager_org_ids() AS current_user_manager_org_ids))));
DROP POLICY IF EXISTS "purchase_order_items_delete" ON public.purchase_order_items;
CREATE POLICY "purchase_order_items_delete" ON public.purchase_order_items FOR DELETE
  USING (po_id IN ( SELECT purchase_orders.id FROM purchase_orders WHERE (purchase_orders.org_id IN ( SELECT current_user_manager_org_ids() AS current_user_manager_org_ids))));

-- ---- Part 6: Bucket B — keep the frozen member write paths, gate the rest
-- Member-allowed commands are re-created verbatim (no gate) so this
-- migration is self-documenting about what a role='member' cashier keeps.
-- stock_counts: NO statements (frozen whitelist — member keeps full write;
-- the count-application gate lives on product_stock, mig 053).

-- customer_payments (_loc_*): INSERT kept; UPDATE/DELETE gated
DROP POLICY IF EXISTS "customer_payments_loc_insert" ON public.customer_payments;
CREATE POLICY "customer_payments_loc_insert" ON public.customer_payments FOR INSERT
  WITH CHECK ((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND ((location_id IS NULL) OR (location_id IN ( SELECT current_user_location_ids() AS current_user_location_ids))));
DROP POLICY IF EXISTS "customer_payments_loc_update" ON public.customer_payments;
CREATE POLICY "customer_payments_loc_update" ON public.customer_payments FOR UPDATE
  USING      (((org_id IN ( SELECT current_user_org_ids() AS current_user_org_ids)) AND ((location_id IS NULL) OR (location_id IN ( SELECT current_user_location_ids() AS current_user_location_ids)))) AND org_id IN (SELECT current_user_manager_org_ids()))
  WITH CHECK (((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND ((location_id IS NULL) OR (location_id IN ( SELECT current_user_location_ids() AS current_user_location_ids)))) AND org_id IN (SELECT current_user_manager_org_ids()));
DROP POLICY IF EXISTS "customer_payments_loc_delete" ON public.customer_payments;
CREATE POLICY "customer_payments_loc_delete" ON public.customer_payments FOR DELETE
  USING (((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND ((location_id IS NULL) OR (location_id IN ( SELECT current_user_location_ids() AS current_user_location_ids)))) AND org_id IN (SELECT current_user_manager_org_ids()));

-- customers (_loc_*): INSERT kept; UPDATE/DELETE gated
DROP POLICY IF EXISTS "customers_loc_insert" ON public.customers;
CREATE POLICY "customers_loc_insert" ON public.customers FOR INSERT
  WITH CHECK ((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND ((location_id IS NULL) OR (location_id IN ( SELECT current_user_location_ids() AS current_user_location_ids))));
DROP POLICY IF EXISTS "customers_loc_update" ON public.customers;
CREATE POLICY "customers_loc_update" ON public.customers FOR UPDATE
  USING      (((org_id IN ( SELECT current_user_org_ids() AS current_user_org_ids)) AND ((location_id IS NULL) OR (location_id IN ( SELECT current_user_location_ids() AS current_user_location_ids)))) AND org_id IN (SELECT current_user_manager_org_ids()))
  WITH CHECK (((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND ((location_id IS NULL) OR (location_id IN ( SELECT current_user_location_ids() AS current_user_location_ids)))) AND org_id IN (SELECT current_user_manager_org_ids()));
DROP POLICY IF EXISTS "customers_loc_delete" ON public.customers;
CREATE POLICY "customers_loc_delete" ON public.customers FOR DELETE
  USING (((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND ((location_id IS NULL) OR (location_id IN ( SELECT current_user_location_ids() AS current_user_location_ids)))) AND org_id IN (SELECT current_user_manager_org_ids()));

-- shifts (_loc_*; has location_id): INSERT + UPDATE kept; DELETE gated
DROP POLICY IF EXISTS "shifts_loc_insert" ON public.shifts;
CREATE POLICY "shifts_loc_insert" ON public.shifts FOR INSERT
  WITH CHECK ((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND ((location_id IS NULL) OR (location_id IN ( SELECT current_user_location_ids() AS current_user_location_ids))));
DROP POLICY IF EXISTS "shifts_loc_update" ON public.shifts;
CREATE POLICY "shifts_loc_update" ON public.shifts FOR UPDATE
  USING      ((org_id IN ( SELECT current_user_org_ids() AS current_user_org_ids)) AND ((location_id IS NULL) OR (location_id IN ( SELECT current_user_location_ids() AS current_user_location_ids))))
  WITH CHECK ((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND ((location_id IS NULL) OR (location_id IN ( SELECT current_user_location_ids() AS current_user_location_ids))));
DROP POLICY IF EXISTS "shifts_loc_delete" ON public.shifts;
CREATE POLICY "shifts_loc_delete" ON public.shifts FOR DELETE
  USING (((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND ((location_id IS NULL) OR (location_id IN ( SELECT current_user_location_ids() AS current_user_location_ids)))) AND org_id IN (SELECT current_user_manager_org_ids()));

-- daily_reconciliation (_org_*; no location_id): INSERT + UPDATE kept; DELETE gated
DROP POLICY IF EXISTS "daily_reconciliation_org_insert" ON public.daily_reconciliation;
CREATE POLICY "daily_reconciliation_org_insert" ON public.daily_reconciliation FOR INSERT
  WITH CHECK (org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids));
DROP POLICY IF EXISTS "daily_reconciliation_org_update" ON public.daily_reconciliation;
CREATE POLICY "daily_reconciliation_org_update" ON public.daily_reconciliation FOR UPDATE
  USING      (org_id IN ( SELECT current_user_org_ids() AS current_user_org_ids))
  WITH CHECK (org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids));
DROP POLICY IF EXISTS "daily_reconciliation_org_delete" ON public.daily_reconciliation;
CREATE POLICY "daily_reconciliation_org_delete" ON public.daily_reconciliation FOR DELETE
  USING ((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND org_id IN (SELECT current_user_manager_org_ids()));

-- stock_count_audit (_org_*): INSERT kept; UPDATE/DELETE gated
DROP POLICY IF EXISTS "stock_count_audit_org_insert" ON public.stock_count_audit;
CREATE POLICY "stock_count_audit_org_insert" ON public.stock_count_audit FOR INSERT
  WITH CHECK (org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids));
DROP POLICY IF EXISTS "stock_count_audit_org_update" ON public.stock_count_audit;
CREATE POLICY "stock_count_audit_org_update" ON public.stock_count_audit FOR UPDATE
  USING      ((org_id IN ( SELECT current_user_org_ids() AS current_user_org_ids)) AND org_id IN (SELECT current_user_manager_org_ids()))
  WITH CHECK ((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND org_id IN (SELECT current_user_manager_org_ids()));
DROP POLICY IF EXISTS "stock_count_audit_org_delete" ON public.stock_count_audit;
CREATE POLICY "stock_count_audit_org_delete" ON public.stock_count_audit FOR DELETE
  USING ((org_id IN ( SELECT current_user_writable_org_ids() AS current_user_writable_org_ids)) AND org_id IN (SELECT current_user_manager_org_ids()));

COMMIT;
