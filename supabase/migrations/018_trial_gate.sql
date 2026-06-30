-- ============================================================
-- Migration 018: Trial gate (Slice 2)
--
-- Adds server-side enforcement of the 14-day trial. When an
-- organisation's trial_ends_at is in the past and they have not
-- yet upgraded to a paid plan, all INSERT / UPDATE / DELETE
-- statements against their data are blocked at the RLS layer.
-- SELECT still works so the operator can see their existing data
-- while choosing a plan.
--
-- Status semantics:
--   trialing  - in the 14-day grace window, writable
--   active    - paid subscription, writable
--   past_due  - subscription payment failed, READ ONLY
--   cancelled - operator cancelled subscription, READ ONLY
-- ============================================================

BEGIN;

-- Helper that returns only the org_ids the calling user can WRITE to.
-- Reads stay unaffected and continue to use current_user_org_ids().
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
      o.subscription_status = 'active'
      OR (o.subscription_status = 'trialing' AND o.trial_ends_at > NOW())
    );
$$;

-- Swap the write-side policies on every business table to require
-- the org to be in a writable state. Read policies are unchanged.
DO $$
DECLARE
  t TEXT;
  table_list TEXT[] := ARRAY[
    'products', 'ingredients', 'recipes', 'customers', 'sales',
    'stock_counts', 'production_log', 'customer_payments',
    'daily_reconciliation', 'purchases', 'app_settings', 'expenses',
    'stock_receipts', 'stock_receipt_items', 'stock_count_audit',
    'shifts', 'stock_adjustments', 'ra_notes'
  ];
BEGIN
  FOREACH t IN ARRAY table_list LOOP
    EXECUTE format('DROP POLICY IF EXISTS "%s_org_insert" ON %I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_org_update" ON %I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_org_delete" ON %I', t, t);

    EXECUTE format(
      'CREATE POLICY "%s_org_insert" ON %I FOR INSERT WITH CHECK (org_id IN (SELECT current_user_writable_org_ids()))',
      t, t
    );
    EXECUTE format(
      'CREATE POLICY "%s_org_update" ON %I FOR UPDATE USING (org_id IN (SELECT current_user_org_ids())) WITH CHECK (org_id IN (SELECT current_user_writable_org_ids()))',
      t, t
    );
    EXECUTE format(
      'CREATE POLICY "%s_org_delete" ON %I FOR DELETE USING (org_id IN (SELECT current_user_writable_org_ids()))',
      t, t
    );
  END LOOP;
END $$;

COMMIT;
