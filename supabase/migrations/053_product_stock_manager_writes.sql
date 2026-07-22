-- ============================================================
-- Migration 053: Restrict direct product_stock writes to managers
--
-- Cashiers can now take a stock count (052). Their count deliberately does not
-- apply to stock — a manager confirms it — but that restriction lived only in
-- the UI. product_stock's write policies gated on org + location with no role
-- condition, so a cashier could still set stock levels by calling PostgREST
-- directly, which is exactly the control the confirm step exists to provide.
--
-- This adds the role condition. Reads are UNCHANGED: the POS needs to see stock
-- at the cashier's branch to decide what to display.
--
-- Why this does not break the POS: sales never write this table directly. They
-- go through submit_sale_batch (0290) and deduct_stock_at_location (024), both
-- SECURITY DEFINER, which bypass RLS by design. Offline sales replay through
-- the same RPC. Verified every direct table writer in the app is a
-- manager-only screen: Stock Count, StockPilot Import, Stock Transfers, Stock
-- Adjustments, and the product CSV upload.
--
-- Role check is inlined per policy, matching the expenses policies in 046 —
-- there is still no shared SQL helper for role checks.
-- ============================================================

BEGIN;

-- INSERT: creating a stock row for a product at a branch is a manager action.
DROP POLICY IF EXISTS "product_stock_insert" ON product_stock;
CREATE POLICY "product_stock_insert" ON product_stock FOR INSERT WITH CHECK (
  org_id IN (SELECT current_user_writable_org_ids())
  AND location_id IN (SELECT current_user_location_ids())
  AND EXISTS (
    SELECT 1 FROM org_members m
    WHERE m.org_id = product_stock.org_id
      AND m.user_id = auth.uid()
      AND m.role IN ('owner', 'admin')
  )
);

-- UPDATE: this is the one that matters — setting a quantity by hand.
DROP POLICY IF EXISTS "product_stock_update" ON product_stock;
CREATE POLICY "product_stock_update" ON product_stock FOR UPDATE USING (
  org_id IN (SELECT current_user_org_ids())
  AND location_id IN (SELECT current_user_location_ids())
  AND EXISTS (
    SELECT 1 FROM org_members m
    WHERE m.org_id = product_stock.org_id
      AND m.user_id = auth.uid()
      AND m.role IN ('owner', 'admin')
  )
) WITH CHECK (
  org_id IN (SELECT current_user_writable_org_ids())
  AND location_id IN (SELECT current_user_location_ids())
  AND EXISTS (
    SELECT 1 FROM org_members m
    WHERE m.org_id = product_stock.org_id
      AND m.user_id = auth.uid()
      AND m.role IN ('owner', 'admin')
  )
);

DROP POLICY IF EXISTS "product_stock_delete" ON product_stock;
CREATE POLICY "product_stock_delete" ON product_stock FOR DELETE USING (
  org_id IN (SELECT current_user_writable_org_ids())
  AND location_id IN (SELECT current_user_location_ids())
  AND EXISTS (
    SELECT 1 FROM org_members m
    WHERE m.org_id = product_stock.org_id
      AND m.user_id = auth.uid()
      AND m.role IN ('owner', 'admin')
  )
);

COMMIT;
