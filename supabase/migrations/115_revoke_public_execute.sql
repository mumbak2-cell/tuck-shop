-- ============================================================
-- Migration 115: Revoke PUBLIC EXECUTE — the missing half of 114
--
-- 114 applied cleanly (guard_restored = true, a real sale went through
-- afterwards) but its own verification returned anon_secdef_left = 13,
-- not the expected 1.
--
-- Cause: PostgreSQL grants EXECUTE on every function to PUBLIC by
-- default. 114 Part 2 revoked EXECUTE from `anon` specifically, which
-- worked — `anon` is gone from 12 of the 13 remaining ACLs — but
-- `anon` still passes has_function_privilege() because it inherits
-- through the PUBLIC grant (every one of those 13 ACLs starts with
-- `=X/postgres`, the empty-grantee entry, which IS PUBLIC).
--
-- Migration 080's own comment asserted that "REVOKE ... FROM PUBLIC
-- ... is a different grantee and leaves all three untouched", and
-- concluded that revoking anon by name was the fix. Both halves are
-- needed: anon by name AND PUBLIC. 080 revoked only PUBLIC on some
-- functions, 114 revoked only anon. Neither alone closes it — this
-- migration is the completion of 114, not a separate finding.
--
-- 080 and 114 are applied migrations and are left untouched.
--
-- Idempotent. Safe to re-run.
--
-- Record with:
--   node node_modules/supabase/dist/supabase.js migration repair \
--     --status applied 115
-- ============================================================


-- ============================================================
-- PART 1: Revoke PUBLIC EXECUTE, safely
--
-- Same dynamic-loop shape as 114 Part 2, plus one safety condition:
-- only revoke PUBLIC where `authenticated` already holds an EXPLICIT
-- grant, so revoking PUBLIC can never remove the app's own access.
-- Anything skipped is reported via RAISE NOTICE rather than silently
-- passed over.
--
-- create_organization_for_user needs no special-casing here: it holds
-- an explicit anon=X/postgres grant (unaffected by a PUBLIC revoke),
-- so signup keeps working. Don't "fix" that later — it's deliberate,
-- same as in 114.
--
-- Deviation from the brief: the original form re-queried pg_proc for
-- proacl inside the loop body via a correlated subquery. Folded that
-- into the same FOR-loop SELECT instead (proacl is already available
-- on the row being iterated) — same check, one less subquery. Both
-- forms compile on Postgres 15+; this one is just simpler.
-- ============================================================

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT p.oid, p.oid::regprocedure AS sig, p.proname, p.proacl
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
  LOOP
    IF EXISTS (
      SELECT 1 FROM aclexplode(COALESCE(r.proacl, '{}'::aclitem[]))
       WHERE grantee = 'authenticated'::regrole AND privilege_type = 'EXECUTE'
    ) THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', r.sig);
    ELSE
      RAISE NOTICE 'SKIPPED %: no explicit authenticated grant, revoking PUBLIC would break app access', r.sig;
    END IF;
  END LOOP;
END $$;


-- ============================================================
-- PART 2: Stop the recurrence — the PUBLIC twin of 114 Part 3
--
-- 114 set this for anon. Without the PUBLIC half, every future
-- CREATE FUNCTION still inherits PUBLIC EXECUTE by default, which
-- re-opens the same anon-via-PUBLIC inheritance path this migration
-- just closed.
-- ============================================================

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;


-- ============================================================
-- Verification (run manually in SQL Editor after applying)
-- ============================================================
-- SELECT count(*) AS anon_executable_secdef
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname='public' AND p.prosecdef
--    AND has_function_privilege('anon', p.oid, 'EXECUTE');   -- must be 1
-- -- the 1 is create_organization_for_user, intentionally still anon-callable
-- ============================================================
