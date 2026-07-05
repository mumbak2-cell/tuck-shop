-- ============================================================
-- Migration 035: Subscription gate hardening
--
-- Fixes two gaps found in the audit:
--
-- 1. Tables added AFTER migration 018 (promotions, promotion_items,
--    WMS tables, ZRA tables) use current_user_org_ids() for writes
--    instead of current_user_writable_org_ids(), bypassing the trial
--    and subscription gate. This migration upgrades their write
--    policies to use the writable function.
--
-- 2. The writable function itself only checks trialing + active.
--    A paid subscription whose current_period_end has lapsed (failed
--    renewal without a webhook updating status) is still considered
--    writable. We add a current_period_end check for active orgs.
--
-- 3. ZRA tables use default_user_org_id() (single-org) instead of
--    current_user_org_ids() (multi-org safe). Fixed to standard pattern.
--
-- None of these changes affect existing merchants whose subscriptions
-- are in good standing.
-- ============================================================

BEGIN;

-- 1. Harden the writable function: active orgs must also have
--    current_period_end in the future (or NULL, for legacy rows).
CREATE OR REPLACE FUNCTION current_user_writable_org_ids()
RETURNS SETOF UUID
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT om.org_id
  FROM org_members om
  JOIN organizations o ON o.id = om.org_id
  WHERE om.user_id = auth.uid()
    AND (
      (o.subscription_status = 'active'
        AND (o.current_period_end IS NULL OR o.current_period_end > NOW()))
      OR (o.subscription_status = 'trialing' AND o.trial_ends_at > NOW())
    );
$$;

-- 2. Fix promotions (031) — split FOR ALL into per-operation policies
DROP POLICY IF EXISTS "promotions_org_read"    ON promotions;
DROP POLICY IF EXISTS "promotions_org_insert"  ON promotions;
DROP POLICY IF EXISTS "promotions_org_update"  ON promotions;
DROP POLICY IF EXISTS "promotions_org_delete"  ON promotions;
-- Drop the original FOR ALL policies if they exist
DROP POLICY IF EXISTS "promotions_read"   ON promotions;
DROP POLICY IF EXISTS "promotions_insert" ON promotions;
DROP POLICY IF EXISTS "promotions_update" ON promotions;
DROP POLICY IF EXISTS "promotions_delete" ON promotions;

CREATE POLICY "promotions_org_read"   ON promotions FOR SELECT
  USING (org_id IN (SELECT current_user_org_ids()));
CREATE POLICY "promotions_org_insert" ON promotions FOR INSERT
  WITH CHECK (org_id IN (SELECT current_user_writable_org_ids()));
CREATE POLICY "promotions_org_update" ON promotions FOR UPDATE
  USING (org_id IN (SELECT current_user_org_ids()))
  WITH CHECK (org_id IN (SELECT current_user_writable_org_ids()));
CREATE POLICY "promotions_org_delete" ON promotions FOR DELETE
  USING (org_id IN (SELECT current_user_writable_org_ids()));

-- promotion_items: read via promotions join, writes gated
DROP POLICY IF EXISTS "promotion_items_read"   ON promotion_items;
DROP POLICY IF EXISTS "promotion_items_insert" ON promotion_items;
DROP POLICY IF EXISTS "promotion_items_update" ON promotion_items;
DROP POLICY IF EXISTS "promotion_items_delete" ON promotion_items;

CREATE POLICY "promotion_items_read"   ON promotion_items FOR SELECT
  USING (promotion_id IN (SELECT id FROM promotions WHERE org_id IN (SELECT current_user_org_ids())));
CREATE POLICY "promotion_items_insert" ON promotion_items FOR INSERT
  WITH CHECK (promotion_id IN (SELECT id FROM promotions WHERE org_id IN (SELECT current_user_writable_org_ids())));
CREATE POLICY "promotion_items_update" ON promotion_items FOR UPDATE
  USING (promotion_id IN (SELECT id FROM promotions WHERE org_id IN (SELECT current_user_org_ids())))
  WITH CHECK (promotion_id IN (SELECT id FROM promotions WHERE org_id IN (SELECT current_user_writable_org_ids())));
CREATE POLICY "promotion_items_delete" ON promotion_items FOR DELETE
  USING (promotion_id IN (SELECT id FROM promotions WHERE org_id IN (SELECT current_user_writable_org_ids())));

-- 3. Fix WMS tables — replace FOR ALL with split policies
DO $$
DECLARE
  t TEXT;
  wms_tables TEXT[] := ARRAY[
    'wms_catalog', 'wms_inventory', 'wms_dispatches', 'wms_dispatch_items',
    'wms_receipts', 'wms_receipt_items', 'wms_adjustments'
  ];
BEGIN
  FOREACH t IN ARRAY wms_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS "org_isolation" ON %I', t);

    EXECUTE format(
      'CREATE POLICY "%s_org_read" ON %I FOR SELECT USING (org_id IN (SELECT current_user_org_ids()))',
      t, t);
    EXECUTE format(
      'CREATE POLICY "%s_org_insert" ON %I FOR INSERT WITH CHECK (org_id IN (SELECT current_user_writable_org_ids()))',
      t, t);
    EXECUTE format(
      'CREATE POLICY "%s_org_update" ON %I FOR UPDATE USING (org_id IN (SELECT current_user_org_ids())) WITH CHECK (org_id IN (SELECT current_user_writable_org_ids()))',
      t, t);
    EXECUTE format(
      'CREATE POLICY "%s_org_delete" ON %I FOR DELETE USING (org_id IN (SELECT current_user_writable_org_ids()))',
      t, t);
  END LOOP;
END $$;

-- 4. Fix ZRA tables — replace default_user_org_id() with standard pattern
--    Skip if ZRA tables don't exist yet (migration 033 not deployed).
DO $$
DECLARE
  t TEXT;
  zra_tables TEXT[] := ARRAY['zra_invoices', 'zra_invoice_items'];
BEGIN
  FOREACH t IN ARRAY zra_tables LOOP
    -- Skip tables that haven't been created yet
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = t) THEN
      CONTINUE;
    END IF;

    -- Drop all existing policies on the table
    EXECUTE format('DROP POLICY IF EXISTS "%s_select" ON %I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_all" ON %I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "org_isolation" ON %I', t);

    EXECUTE format(
      'CREATE POLICY "%s_org_read" ON %I FOR SELECT USING (org_id IN (SELECT current_user_org_ids()))',
      t, t);
    EXECUTE format(
      'CREATE POLICY "%s_org_insert" ON %I FOR INSERT WITH CHECK (org_id IN (SELECT current_user_writable_org_ids()))',
      t, t);
    EXECUTE format(
      'CREATE POLICY "%s_org_update" ON %I FOR UPDATE USING (org_id IN (SELECT current_user_org_ids())) WITH CHECK (org_id IN (SELECT current_user_writable_org_ids()))',
      t, t);
    EXECUTE format(
      'CREATE POLICY "%s_org_delete" ON %I FOR DELETE USING (org_id IN (SELECT current_user_writable_org_ids()))',
      t, t);
  END LOOP;
END $$;

COMMIT;
