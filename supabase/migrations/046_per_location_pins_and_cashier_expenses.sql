-- ============================================================
-- Migration 046: Per-location PIN consolidation + cashier-scoped expenses
--
-- Two independent fixes:
--
-- 1. PINs. Migration 0230 moved the admin/cashier PINs into location_settings
--    (per branch), but the application never followed — it kept reading and
--    writing PINs from app_settings. New orgs (whose create_organization_for_user
--    seeds PINs only into location_settings) therefore had no app_settings PIN
--    row, so the Settings screen showed the built-in defaults and a saved PIN
--    appeared to "revert". The app now reads/writes location_settings; this
--    migration re-syncs every location's PINs from the app_settings values that
--    real user edits went to, so nobody's PIN changes underneath them. Because
--    the app never wrote per-branch PINs, app_settings is the authoritative
--    source and an overwrite is safe.
--
-- 2. Expenses. Cashiers may now record and view their OWN expenses only, while
--    owners/admins keep the full org+location view. Adds recorded_by_user_id
--    (defaults to the inserting user) and scopes the read/update/delete policies.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Backfill per-location PINs from app_settings.
--    Overwrites the seeded/backfilled location_settings value with whatever the
--    org last set via the old (app_settings-backed) Settings screen. Orgs that
--    never customised (no app_settings PIN row) keep their location defaults.
-- ------------------------------------------------------------
INSERT INTO location_settings (org_id, location_id, key, value)
SELECT s.org_id, l.id, s.key, s.value
FROM app_settings s
JOIN locations l ON l.org_id = s.org_id
WHERE s.key IN ('admin_pin', 'cashier_pin')
ON CONFLICT (location_id, key) DO UPDATE
  SET value = EXCLUDED.value, updated_at = NOW();

-- ------------------------------------------------------------
-- 2. Cashier-scoped expenses.
-- ------------------------------------------------------------

-- New column: who recorded the expense. Set the default separately from ADD
-- COLUMN so existing rows stay NULL (visible to owners/admins only) rather than
-- forcing a table rewrite. auth.uid() is filled at insert time from the JWT.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS recorded_by_user_id UUID REFERENCES auth.users(id);
ALTER TABLE expenses ALTER COLUMN recorded_by_user_id SET DEFAULT auth.uid();

CREATE INDEX IF NOT EXISTS idx_expenses_recorded_by_user ON expenses(recorded_by_user_id);

-- Helper predicate reused below: the current user is an owner/admin of the
-- expense's org (and so may see/act on every expense, not just their own).
-- Inlined per policy since there is no shared SQL helper for role checks.

-- READ: owners/admins see all (within their locations); members see only rows
-- they recorded. Legacy rows (recorded_by_user_id IS NULL) stay owner/admin-only.
DROP POLICY IF EXISTS "expenses_loc_read" ON expenses;
CREATE POLICY "expenses_loc_read" ON expenses FOR SELECT USING (
  org_id IN (SELECT current_user_org_ids())
  AND (location_id IS NULL OR location_id IN (SELECT current_user_location_ids()))
  AND (
    EXISTS (
      SELECT 1 FROM org_members m
      WHERE m.org_id = expenses.org_id AND m.user_id = auth.uid() AND m.role IN ('owner', 'admin')
    )
    OR recorded_by_user_id = auth.uid()
  )
);

-- INSERT: unchanged scope, plus a member cannot record an expense under another
-- user's id. The column default fills auth.uid() when the client omits it.
DROP POLICY IF EXISTS "expenses_loc_insert" ON expenses;
CREATE POLICY "expenses_loc_insert" ON expenses FOR INSERT WITH CHECK (
  org_id IN (SELECT current_user_writable_org_ids())
  AND (location_id IS NULL OR location_id IN (SELECT current_user_location_ids()))
  AND (recorded_by_user_id IS NULL OR recorded_by_user_id = auth.uid())
);

-- UPDATE / DELETE: owners/admins act on any; members only on their own rows.
DROP POLICY IF EXISTS "expenses_loc_update" ON expenses;
CREATE POLICY "expenses_loc_update" ON expenses FOR UPDATE USING (
  org_id IN (SELECT current_user_org_ids())
  AND (location_id IS NULL OR location_id IN (SELECT current_user_location_ids()))
  AND (
    EXISTS (
      SELECT 1 FROM org_members m
      WHERE m.org_id = expenses.org_id AND m.user_id = auth.uid() AND m.role IN ('owner', 'admin')
    )
    OR recorded_by_user_id = auth.uid()
  )
) WITH CHECK (
  org_id IN (SELECT current_user_writable_org_ids())
  AND (location_id IS NULL OR location_id IN (SELECT current_user_location_ids()))
);

DROP POLICY IF EXISTS "expenses_loc_delete" ON expenses;
CREATE POLICY "expenses_loc_delete" ON expenses FOR DELETE USING (
  org_id IN (SELECT current_user_writable_org_ids())
  AND (location_id IS NULL OR location_id IN (SELECT current_user_location_ids()))
  AND (
    EXISTS (
      SELECT 1 FROM org_members m
      WHERE m.org_id = expenses.org_id AND m.user_id = auth.uid() AND m.role IN ('owner', 'admin')
    )
    OR recorded_by_user_id = auth.uid()
  )
);

COMMIT;
