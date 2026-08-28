-- ============================================================
-- Migration 100: Lock down reads of the branch Access PINs
--
-- location_settings holds per-branch key/value settings. Two of the
-- keys — admin_pin and cashier_pin (0230) — are secrets, but the
-- "location_settings_read" policy let ANY member of the org at that
-- location SELECT every row, PIN rows included. A signed-in cashier
-- could therefore read the branch admin PIN straight off the table
-- (devtools, or the Settings page which has no route guard), which is
-- a privilege-escalation path: the admin PIN unlocks voids, blind
-- cash-up, the WMS module and every admin-gated screen.
--
-- Same shape of problem, and same fix, as migration 097 for
-- org_members.pin: stop the authenticated role reading the secret
-- directly, and route the one legitimate read (the shared-PIN login
-- compare in auth-context.tsx) through a SECURITY DEFINER function
-- that never returns the value, only which role the PIN matched, and
-- only for an org the caller already belongs to.
--
-- location_settings is ROW keyed, not column keyed, so this is done
-- with an RLS predicate that hides the admin_pin / cashier_pin rows
-- from non-admins, rather than a column-privilege REVOKE.
--
-- Non-PIN keys (receipts_enabled, blind_cash_up, requires_shift,
-- wholesale_enabled, cash_back, require_stock_count_for_cashup, …)
-- stay readable by every member — the POS, shift and payment screens
-- need them.
--
-- No BEGIN/COMMIT — see migration 096/097. Each statement is
-- independently idempotent and safe to re-run.
--
-- Depends on: 0230 (location_settings + its policies), 017
-- (org_members, current_user_org_ids), 097 (match_member_pin, the
-- pattern this mirrors).
--
-- Record with:
--   node node_modules/supabase/dist/supabase.js migration repair \
--     --status applied 100
-- ============================================================


-- ============================================================
-- STATEMENT 1: Replace the read policy with a PIN-aware one
--
-- Everything before the final AND (…) is the original policy. The
-- new clause: PIN rows are visible only when the caller is an owner
-- or admin (org_members.role) of the owning org; all other keys are
-- unchanged.
-- ============================================================

DROP POLICY IF EXISTS "location_settings_read" ON location_settings;

CREATE POLICY "location_settings_read" ON location_settings
  FOR SELECT USING (
    org_id IN (SELECT current_user_org_ids())
    AND location_id IN (SELECT current_user_location_ids())
    AND (
      key NOT IN ('admin_pin', 'cashier_pin')
      OR EXISTS (
        SELECT 1 FROM org_members om
         WHERE om.org_id = location_settings.org_id
           AND om.user_id = auth.uid()
           AND om.role IN ('owner', 'admin')
      )
    )
  );


-- ============================================================
-- STATEMENT 2: match_location_pin — SECURITY DEFINER PIN compare
--
-- The shared-branch-PIN login path (auth-context.tsx, "Priority 2")
-- used to pull admin_pin + cashier_pin to the client and compare in
-- JS. With statement 1 in place a cashier-role account can no longer
-- read those rows, so the compare moves here.
--
-- Returns 'admin' | 'cashier' for a match, NULL otherwise. Never
-- returns the stored value. A wrong PIN and an unknown location and
-- an org the caller doesn't belong to all look identical (NULL) from
-- the caller's side. admin_pin wins if both PINs are set the same.
-- ============================================================

CREATE OR REPLACE FUNCTION match_location_pin(p_location_id UUID, p_pin TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id UUID;
  v_role   TEXT;
BEGIN
  SELECT org_id INTO v_org_id FROM locations WHERE id = p_location_id;
  IF v_org_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Caller must already be a member of the org that owns this location,
  -- otherwise this would be a cross-tenant PIN-guessing oracle.
  IF NOT EXISTS (
    SELECT 1 FROM org_members WHERE org_id = v_org_id AND user_id = auth.uid()
  ) THEN
    RETURN NULL;
  END IF;

  SELECT CASE key WHEN 'admin_pin' THEN 'admin' ELSE 'cashier' END
    INTO v_role
    FROM location_settings
   WHERE location_id = p_location_id
     AND key IN ('admin_pin', 'cashier_pin')
     AND value = p_pin
   ORDER BY key   -- 'admin_pin' < 'cashier_pin', so admin wins a tie
   LIMIT 1;

  RETURN v_role;
END;
$$;

REVOKE EXECUTE ON FUNCTION match_location_pin(UUID, TEXT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION match_location_pin(UUID, TEXT) TO authenticated;


-- ============================================================
-- VERIFY (run after both statements):
--
-- 1. Policy in place:
--   SELECT polname, pg_get_expr(polqual, polrelid) AS using_expr
--     FROM pg_policy
--    WHERE polrelid = 'location_settings'::regclass
--      AND polname = 'location_settings_read';
--   -- using_expr should contain "admin_pin" / "cashier_pin".
--
-- 2. Function ACL (expect authenticated only, no anon/PUBLIC):
--   SELECT proname, array_to_string(proacl, ' ')
--     FROM pg_proc WHERE proname = 'match_location_pin';
--
-- 3. Behavioural (as an authenticated cashier of the org, via the app
--    client): a select of key='admin_pin' returns 0 rows; a select of
--    key='receipts_enabled' still returns its row.
-- ============================================================
