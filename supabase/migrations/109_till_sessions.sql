-- ============================================================
-- Migration 109: Server-issued till session tokens
--
-- Deferred finding from the 2026-08-27 security audit
-- (.agents/briefs/till-session-token.md). auth-context.tsx (the
-- till/PIN layer, NOT the Supabase-auth org role system) used to
-- cache the resolved role in sessionStorage as plain JSON:
--   sessionStorage.setItem("tilify_auth", JSON.stringify({role:"admin",name:"Admin"}))
-- and trust it verbatim on every reload — one devtools line forged
-- admin access to every admin-gated screen (sidebar.tsx:64-81), and
-- on a till signed in under the owner's Supabase account (the shared
-- branch-PIN backward-compat path), RLS permitted everything that
-- forged UI exposed. This migration stops storing the role client-
-- side at all: the client now holds only an opaque token, and every
-- restore resolves it here, server-side.
--
-- Purely additive — one new table, three new functions, nothing
-- existing is altered. Safe to apply well ahead of the client
-- deploy: currently-deployed code never calls any of this, so it is
-- inert until the new client code (which does) ships. See the
-- brief's "Rollout order" section for why this migration goes FIRST,
-- opposite of 108's schema-after-code lesson.
--
-- Session lifetime is a single PL/pgSQL CONSTANT
-- (c_session_lifetime, statement 2) — that is the one place to
-- change it.
--
-- search_path on all three functions is `public, extensions`, not a
-- bare `public` — pgcrypto (gen_random_uuid's historical home on
-- this project) lives in `extensions`, and a bare `public` is the
-- defect noted in 108's header as having nearly broken that
-- migration. (gen_random_uuid() itself is PG13+ core/pg_catalog and
-- would resolve either way; the functions here also call
-- match_member_pin/match_location_pin and auth.uid(), so they get
-- the same search_path treatment as every other SECURITY DEFINER
-- function in this codebase for consistency.)
--
-- Depends on: 097 (match_member_pin), 100 (match_location_pin) — this
-- migration calls both, whatever their current (108-rewritten,
-- bcrypt-aware) definitions do, without duplicating their logic.
--
-- No BEGIN/COMMIT — see migration 096 for why (Supabase SQL Editor
-- does not guarantee a pasted multi-statement script shares one
-- connection/transaction). Each statement below is independently
-- idempotent and safe to re-run.
--
-- Record with:
--   npx supabase migration repair --status applied 109
-- ============================================================


-- ============================================================
-- STATEMENT 1: till_sessions table
--
-- RLS is enabled with NO policies: every one of the three functions
-- below is SECURITY DEFINER, runs as the function owner, and is
-- therefore exempt from RLS the same way match_member_pin and
-- match_location_pin already are against org_members /
-- location_settings — so "no policies" already means "unreachable
-- to anon/authenticated directly". The REVOKE at the end of this
-- statement is belt-and-suspenders on top of that, matching the
-- layered RLS-plus-grants approach 097/100 use for the secrets this
-- table's functions read (org_members.pin, location_settings admin/
-- cashier PINs) — it makes "no direct access" true at the grant
-- level too, not only the policy level.
-- ============================================================

CREATE TABLE IF NOT EXISTS till_sessions (
  token        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL,
  location_id  UUID,
  member_id    UUID,
  role         TEXT NOT NULL CHECK (role IN ('admin', 'cashier')),
  display_name TEXT,
  created_at   TIMESTAMPTZ DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);

COMMENT ON TABLE till_sessions IS
  'Server-issued till/PIN session tokens (migration 109) — replaces the forgeable sessionStorage {role,name} blob auth-context.tsx used to trust verbatim. Reachable only through create_till_session/resume_till_session/end_till_session; RLS is enabled with no policies and direct table grants are revoked below.';

ALTER TABLE till_sessions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON till_sessions FROM PUBLIC, anon, authenticated;


-- ============================================================
-- STATEMENT 2: create_till_session — PIN login, issues a token
--
-- Mirrors the two-priority PIN check the client used to run itself
-- (auth-context.tsx login(), "Priority 1" / "Priority 2" comments),
-- moved server-side so the client never sees which branch matched,
-- only the outcome. Priority 1 is a per-user org_members PIN
-- (match_member_pin — org_members.role 'owner'/'admin' -> till role
-- 'admin', 'member' -> 'cashier'); priority 2 is the shared branch
-- PIN (match_location_pin, backward-compat).
--
-- Re-checks auth.uid() is a member of p_org_id itself, in addition
-- to the membership checks match_member_pin and match_location_pin
-- already run internally — defence in depth, not a substitute:
-- p_org_id and p_location_id are independent client-supplied params
-- here, unlike match_location_pin's own callers where org is always
-- derived from the location.
--
-- Returns no rows on no match, and no rows if the caller isn't a
-- member of p_org_id — indistinguishable from the caller's side,
-- same pattern as match_member_pin/match_location_pin.
-- ============================================================

CREATE OR REPLACE FUNCTION create_till_session(p_org_id UUID, p_location_id UUID, p_pin TEXT)
RETURNS TABLE(token UUID, role TEXT, display_name TEXT, member_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  c_session_lifetime CONSTANT INTERVAL := INTERVAL '12 hours';
  v_member_row    RECORD;
  v_location_role TEXT;
  v_role          TEXT;
  v_display_name  TEXT;
  v_member_id     UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM org_members WHERE org_id = p_org_id AND user_id = auth.uid()
  ) THEN
    RETURN;
  END IF;

  -- Priority 1: per-user PIN.
  SELECT * INTO v_member_row FROM match_member_pin(p_org_id, p_pin);
  IF v_member_row.id IS NOT NULL THEN
    v_member_id    := v_member_row.id;
    v_role         := CASE WHEN v_member_row.role = 'member' THEN 'cashier' ELSE 'admin' END;
    v_display_name := COALESCE(
      v_member_row.display_name,
      CASE WHEN v_role = 'admin' THEN 'Admin' ELSE 'Cashier' END
    );
  ELSE
    -- Priority 2: shared branch PIN (backward compat).
    SELECT match_location_pin(p_location_id, p_pin) INTO v_location_role;
    IF v_location_role IS NULL THEN
      RETURN;
    END IF;
    v_member_id    := NULL;
    v_role         := v_location_role;
    v_display_name := CASE WHEN v_role = 'admin' THEN 'Admin' ELSE 'Cashier' END;
  END IF;

  RETURN QUERY
    INSERT INTO till_sessions (org_id, location_id, member_id, role, display_name, expires_at)
    VALUES (p_org_id, p_location_id, v_member_id, v_role, v_display_name, now() + c_session_lifetime)
    RETURNING till_sessions.token, till_sessions.role, till_sessions.display_name, till_sessions.member_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION create_till_session(UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION create_till_session(UUID, UUID, TEXT) TO authenticated;


-- ============================================================
-- STATEMENT 3: resume_till_session — resolve a stored token
--
-- Called on every mount (auth-context.tsx) instead of trusting a
-- cached {role,name} blob. Returns a row only for a token that (a)
-- exists, (b) has not expired, and (c) belongs to an org the caller
-- is currently a member of. No rows otherwise — an unknown token, an
-- expired one, and someone else's org's token are all
-- indistinguishable from the caller's side.
-- ============================================================

CREATE OR REPLACE FUNCTION resume_till_session(p_token UUID)
RETURNS TABLE(role TEXT, display_name TEXT, member_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
    SELECT ts.role, ts.display_name, ts.member_id
      FROM till_sessions ts
     WHERE ts.token = p_token
       AND ts.expires_at > now()
       AND EXISTS (
         SELECT 1 FROM org_members om
          WHERE om.org_id = ts.org_id AND om.user_id = auth.uid()
       );
END;
$$;

REVOKE EXECUTE ON FUNCTION resume_till_session(UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION resume_till_session(UUID) TO authenticated;


-- ============================================================
-- STATEMENT 4: end_till_session — logout
--
-- Deletes the row outright, no membership re-check: the token is the
-- credential here (a 122-bit random UUID, gen_random_uuid()'s
-- default), and logout is "I hold this token, end it", not a data
-- read — there is nothing in the deleted row to leak to a caller who
-- already possessed the token that names it.
-- ============================================================

CREATE OR REPLACE FUNCTION end_till_session(p_token UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  DELETE FROM till_sessions WHERE token = p_token;
END;
$$;

REVOKE EXECUTE ON FUNCTION end_till_session(UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION end_till_session(UUID) TO authenticated;


-- ============================================================
-- VERIFY:
--
-- 1. Table + RLS present, no policies:
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'till_sessions';
--   -- expect true
--   SELECT polname FROM pg_policy WHERE polrelid = 'till_sessions'::regclass;
--   -- expect 0 rows
--
-- 2. Direct grants revoked (expect 0 rows for anon/authenticated):
--   SELECT grantee, privilege_type FROM information_schema.table_privileges
--    WHERE table_name = 'till_sessions' AND grantee IN ('anon', 'authenticated');
--
-- 3. Function ACLs (expect authenticated only, no anon/PUBLIC):
--   SELECT proname, array_to_string(proacl, ' ')
--     FROM pg_proc
--    WHERE proname IN ('create_till_session', 'resume_till_session', 'end_till_session');
--
-- 4. Functional — run as an authenticated org member, via the app's
--    Supabase client (RPC), not the SQL Editor's postgres role, since
--    these all key off auth.uid(). Replace the angle-bracket values
--    with real ones from your own test org — illustrative placeholders
--    only, never a real PIN or token in this file or in any report:
--   SELECT * FROM create_till_session('<org-id>'::uuid, '<location-id>'::uuid, '<test-pin>');
--   -- expect one row: token, role, display_name, member_id
--   SELECT * FROM resume_till_session('<token-from-above>'::uuid);
--   -- expect the same role/display_name/member_id back
--   SELECT count(*) FROM till_sessions WHERE token = '<token-from-above>'::uuid;
--   -- expect 1
--   SELECT end_till_session('<token-from-above>'::uuid);
--   SELECT count(*) FROM till_sessions WHERE token = '<token-from-above>'::uuid;
--   -- expect 0
--
-- 5. Expiry — set expires_at into the past by hand, then confirm
--    resume_till_session returns no rows for that token:
--   UPDATE till_sessions SET expires_at = now() - interval '1 minute'
--    WHERE token = '<token>'::uuid;
--   SELECT * FROM resume_till_session('<token>'::uuid);
--   -- expect 0 rows
-- ============================================================
