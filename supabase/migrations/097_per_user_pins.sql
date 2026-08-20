-- ============================================================
-- Migration 097: Per-user PINs
--
-- Today each branch has two SHARED PINs (admin_pin, cashier_pin) in
-- location_settings. Everyone who works admin enters the same PIN;
-- everyone who works cashier enters the same PIN — the system can only
-- tell which ROLE is at the till, never which PERSON. This migration
-- gives each org_members row its own PIN; the person's role still
-- comes from org_members.role, not the PIN itself.
--
-- pin is nullable: a member with no PIN set falls back to the shared
-- location PINs (backward compatible — nothing breaks for orgs that
-- never touch this feature).
--
-- The unique index is PARTIAL (WHERE pin IS NOT NULL) so multiple
-- members without a PIN don't collide as duplicate NULLs — Postgres
-- treats NULL <> NULL for uniqueness purposes anyway, but the partial
-- index also keeps it out of the index entirely for the common
-- "not set yet" case.
--
-- Security note — why this migration also touches table/function
-- grants, not just columns
-- ------------------------------------------------------------------
-- org_members RLS policy "member_read_own_org" (017) lets ANY member
-- of an org SELECT ANY OTHER member's row in that org — that's by
-- design, so teammates can see each other in Settings > Team. RLS is
-- row-level only, not column-level: without the column-privilege
-- change below, adding a plaintext `pin` column here would let any
-- signed-in cashier open devtools and run
--   supabase.from('org_members').select('pin').eq('org_id', myOrgId)
-- directly against the anon/authenticated client and read every
-- teammate's till PIN, including a manager's — a privilege-escalation
-- path, not just a privacy leak.
--
-- Fix: REVOKE table-level SELECT from `authenticated` and re-GRANT it
-- column-by-column, excluding `pin`. Server code that legitimately
-- needs to read pin (the /api/team GET route, which only ever returns
-- a hasPin boolean, never the value) uses the SERVICE ROLE client
-- (getSupabaseAdmin()), which table/column grants never restrict.
--
-- That same column restriction means the PIN-login lookup can no
-- longer be a plain client-side `.eq("pin", pin)` query either —
-- Postgres requires SELECT privilege on any column referenced in a
-- WHERE clause, not just ones in the output list, so a restricted
-- `authenticated` role can't even filter by pin directly. Instead,
-- login goes through match_member_pin(), a SECURITY DEFINER function
-- that bypasses the column restriction internally (same pattern this
-- codebase already uses for guarded SECURITY DEFINER RPCs — see
-- assert_org_writable() callers). It re-checks that the caller is
-- actually a member of the org they're asking about before it will
-- match anything, so it can't be used as a cross-tenant PIN-guessing
-- oracle: only someone already signed into that shop's own dashboard
-- session can even attempt a lookup scoped to that org.
--
-- No BEGIN/COMMIT — see migration 096 for why (Supabase SQL Editor
-- does not guarantee a pasted multi-statement script shares one
-- connection/transaction). Each statement below is independently
-- idempotent and safe to re-run.
--
-- Depends on: 017 (org_members table + member_read_own_org policy),
-- 077 (permissions column, same ALTER TABLE ADD COLUMN IF NOT EXISTS
-- pattern).
--
-- Record with:
--   node node_modules/supabase/dist/supabase.js migration repair \
--     --status applied 097
-- ============================================================


-- ============================================================
-- STATEMENT 1: Add pin + display_name columns
-- ============================================================

ALTER TABLE org_members ADD COLUMN IF NOT EXISTS pin VARCHAR(6);
ALTER TABLE org_members ADD COLUMN IF NOT EXISTS display_name TEXT;

COMMENT ON COLUMN org_members.pin IS
  'Personal till PIN (4-6 digits, stored as entered). Nullable — a member without one falls back to the shared location_settings admin_pin/cashier_pin. Never readable by the authenticated role directly (see statement 3) — read only via the service-role client or match_member_pin().';

COMMENT ON COLUMN org_members.display_name IS
  'Shown in the POS/header after a per-user PIN login (e.g. "Chilufya") instead of the generic "Admin"/"Cashier".';


-- ============================================================
-- STATEMENT 2: Unique PIN per org (partial index, NULLs excluded)
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_org_members_org_pin
  ON org_members(org_id, pin) WHERE pin IS NOT NULL;


-- ============================================================
-- STATEMENT 3: Restrict direct table SELECT on pin
--
-- Table-level SELECT was already granted to `authenticated` when
-- org_members was created (017) — that grant covers any column added
-- later by default, including pin, unless narrowed explicitly here.
-- This does NOT affect the service-role client (getSupabaseAdmin()),
-- which bypasses table/column grants entirely, or RLS itself (still
-- row-scoped as before) — only which COLUMNS the authenticated role
-- may read off a row it's already permitted to see.
-- ============================================================

REVOKE SELECT ON org_members FROM authenticated;

GRANT SELECT (id, org_id, user_id, role, created_at, assigned_location_id, permissions, display_name)
  ON org_members TO authenticated;


-- ============================================================
-- STATEMENT 4: match_member_pin — SECURITY DEFINER PIN lookup
--
-- Bypasses the column restriction above internally (SECURITY DEFINER
-- runs as the function owner, not the caller), but only ever matches
-- within an org the caller already belongs to — see the membership
-- guard below. Returns nothing (empty set) on no match or on an
-- org the caller doesn't belong to; never raises, so a wrong PIN
-- looks identical to "not found" from the caller's side either way.
-- ============================================================

CREATE OR REPLACE FUNCTION match_member_pin(p_org_id UUID, p_pin TEXT)
RETURNS TABLE(id UUID, role TEXT, display_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only someone already signed into THIS org's own dashboard session
  -- may look up PINs scoped to it — otherwise this function would be a
  -- cross-tenant PIN-guessing oracle for any authenticated account.
  IF NOT EXISTS (
    SELECT 1 FROM org_members WHERE org_id = p_org_id AND user_id = auth.uid()
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT om.id, om.role, om.display_name
      FROM org_members om
     WHERE om.org_id = p_org_id
       AND om.pin = p_pin
     LIMIT 1;
END;
$$;

REVOKE EXECUTE ON FUNCTION match_member_pin(UUID, TEXT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION match_member_pin(UUID, TEXT) TO authenticated;


-- ============================================================
-- VERIFY (run after all 4 statements):
--
-- 1. Columns present:
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE table_name = 'org_members'
--      AND column_name IN ('pin', 'display_name');
--
-- 2. authenticated cannot select pin directly (expect this to be
--    ABSENT from the column-privilege list, everything else present):
--   SELECT column_name
--     FROM information_schema.column_privileges
--    WHERE table_name = 'org_members'
--      AND grantee = 'authenticated'
--      AND privilege_type = 'SELECT'
--    ORDER BY column_name;
--
-- 3. match_member_pin ACL (expect authenticated only, no anon/PUBLIC):
--   SELECT proname, array_to_string(proacl, ' ')
--     FROM pg_proc WHERE proname = 'match_member_pin';
-- ============================================================
