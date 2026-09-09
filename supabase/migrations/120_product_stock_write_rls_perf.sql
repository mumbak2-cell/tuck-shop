-- ============================================================
-- Migration 120: Fix product_stock write-policy performance
--
-- product_stock_insert/update/delete each carry a correlated
-- EXISTS subquery against org_members, re-run once per row:
--   EXISTS (SELECT 1 FROM org_members m
--           WHERE m.org_id = product_stock.org_id
--             AND m.user_id = auth.uid()
--             AND m.role = ANY (ARRAY['owner','admin']))
-- auth.uid() inside it is unwrapped, so Postgres cannot cache it
-- as an initplan either — flagged by the Supabase performance
-- advisor (auth_rls_initplan) on this exact table/policy set.
--
-- Any bulk upsert on product_stock pays this per row: Stock
-- Count "Confirm and apply to stock" (stock/page.tsx) and the
-- CSV product/stock importer (csv-upload.tsx) both upsert one
-- row per SKU. An org with 1000+ SKUs across branches (e.g.
-- Chichi's, 1300+ products) re-runs the correlated org_members
-- lookup 1000+ times in a single confirm — the likely cause of
-- reported "system is extremely slow".
--
-- Fix: migration 119 already introduced
-- current_user_manager_org_ids() — the exact same "orgs where
-- I'm owner/admin" predicate, as a STABLE SQL function Postgres
-- can evaluate once per statement via `org_id IN (SELECT ...)`.
-- Swap the correlated EXISTS for that. Semantics are unchanged:
-- both check org+role only, neither considers location.
--
-- Idempotent: DROP POLICY IF EXISTS before each CREATE.
--
-- Apply:  Supabase SQL Editor (project pkufxpyrvcygobrgneep).
--         Then: node node_modules/supabase/dist/supabase.js
--               migration repair --status applied 120
-- Verify: see bottom of file.
-- ============================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DROP POLICY IF EXISTS "product_stock_insert" ON public.product_stock;
CREATE POLICY "product_stock_insert" ON public.product_stock
  FOR INSERT WITH CHECK (
    (org_id IN (SELECT current_user_writable_org_ids()))
    AND (location_id IN (SELECT current_user_location_ids()))
    AND (org_id IN (SELECT current_user_manager_org_ids()))
  );

DROP POLICY IF EXISTS "product_stock_update" ON public.product_stock;
CREATE POLICY "product_stock_update" ON public.product_stock
  FOR UPDATE
  USING (
    (org_id IN (SELECT current_user_org_ids()))
    AND (location_id IN (SELECT current_user_location_ids()))
    AND (org_id IN (SELECT current_user_manager_org_ids()))
  )
  WITH CHECK (
    (org_id IN (SELECT current_user_writable_org_ids()))
    AND (location_id IN (SELECT current_user_location_ids()))
    AND (org_id IN (SELECT current_user_manager_org_ids()))
  );

DROP POLICY IF EXISTS "product_stock_delete" ON public.product_stock;
CREATE POLICY "product_stock_delete" ON public.product_stock
  FOR DELETE USING (
    (org_id IN (SELECT current_user_writable_org_ids()))
    AND (location_id IN (SELECT current_user_location_ids()))
    AND (org_id IN (SELECT current_user_manager_org_ids()))
  );

COMMIT;

-- ============================================================
-- Verification (run manually in SQL Editor after applying)
-- ============================================================
-- SELECT polname, pg_get_expr(polqual, polrelid) AS using_expr,
--        pg_get_expr(polwithcheck, polrelid) AS check_expr
-- FROM pg_policy
-- JOIN pg_class ON pg_class.oid = pg_policy.polrelid
-- WHERE pg_class.relname = 'product_stock';
-- -- Expect: no "EXISTS" / "org_members" text in any expr, only
-- -- current_user_writable_org_ids / current_user_org_ids /
-- -- current_user_location_ids / current_user_manager_org_ids.
-- ============================================================
