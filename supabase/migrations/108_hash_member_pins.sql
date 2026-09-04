-- ============================================================
-- Migration 108: Hash member PINs (bcrypt via pgcrypto)
--
-- Closes the last medium finding on org_members.pin: it has been
-- stored as plaintext digits since migration 097 ("stored as
-- entered"). This migration converts every existing PIN in place to
-- a bcrypt digest and moves duplicate-checking from a unique index
-- (which can no longer work — salted hashes of the same PIN differ)
-- into a new SECURITY DEFINER function, set_member_pin.
--
-- Owner-approved: converted in place on live data, after a verified
-- backup taken outside this migration (see the deploy note below).
-- There is no rollback path other than restoring that backup — the
-- conversion inside statement 6 is one-way and irreversible by design.
--
-- BEFORE APPLYING — run this and note the result:
--   SELECT e.extname, n.nspname AS schema
--     FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
--    WHERE e.extname = 'pgcrypto';
-- If it returns a row, pgcrypto already exists in whatever schema is
-- shown (commonly `extensions` on Supabase, sometimes `public`) and
-- statement 1 below will be a no-op. If it returns zero rows,
-- statement 1 creates it in `public`. Either is fine — statements
-- 4/5/6 resolve crypt()/gen_salt() via `search_path = public,
-- extensions` rather than assuming a schema, precisely so this
-- doesn't matter.
--
-- Statement order matters and must not be reordered:
--   1. enable pgcrypto              — crypt()/gen_salt() need it,
--                                      wherever it ends up living
--   2. widen pin to TEXT            — VARCHAR(6) cannot hold a 60-char
--                                      bcrypt digest; running the
--                                      conversion against the old
--                                      width would error or silently
--                                      truncate every PIN
--   3. drop the unique index        — salted hashes of the same PIN
--                                      differ, so uniqueness can no
--                                      longer be enforced by an index;
--                                      safe to drop with no risk of
--                                      creating ambiguous duplicates,
--                                      because idx_org_members_org_pin
--                                      has enforced (org_id, pin)
--                                      uniqueness on every plaintext
--                                      row up to this moment — no two
--                                      members in the same org can
--                                      already share a PIN
--   4. set_member_pin()             — new duplicate check + writer,
--                                      created BEFORE the conversion
--                                      runs, not after — there is no
--                                      reason for the destructive
--                                      statement to run before the
--                                      code that depends on pgcrypto
--                                      being resolvable actually exists
--   5. match_member_pin() rewrite   — login compare against the hash,
--                                      same reasoning as statement 4
--   6. pre-flight + convert         — a single self-contained DO block:
--                                      proves crypt()/gen_salt() are
--                                      resolvable, then converts every
--                                      PIN, idempotency-guarded (see
--                                      below) — see "Why one block"
--   7. column comment               — correct the now-false comment
--
-- Why one block for pre-flight + convert (statement 6): pgcrypto is
-- commonly enabled in Supabase's `extensions` schema, not `public`. If
-- that is the case here, `CREATE EXTENSION IF NOT EXISTS pgcrypto`
-- (statement 1) is a silent no-op against an extension that already
-- lives elsewhere, and a bare UPDATE relying on the SQL Editor's
-- ambient session search_path could resolve crypt() differently than
-- set_member_pin/match_member_pin do — or not at all, failing only
-- AFTER the data is already unrecoverably converted. Statement 6 sets
-- `search_path` with `SET LOCAL` and runs the pre-flight check and the
-- conversion UPDATE inside the same DO block, so both share exactly
-- one search_path scoped to that block's own implicit transaction —
-- there is no dependency on session state still being in effect from
-- an earlier, separately-pasted statement, whether the owner runs this
-- migration as one paste or applies statements one at a time. If
-- crypt()/gen_salt() aren't resolvable, the block raises before the
-- UPDATE runs, so a misconfigured environment fails loudly instead of
-- hashing PINs it then can't compare.
--
-- Idempotency: the `pin NOT LIKE '$2%'` guard inside statement 6's
-- UPDATE is mandatory. Re-running this migration (e.g. a repair
-- replay) must not re-hash an already-hashed value — bcrypt('$2a$10$
-- alreadyHashed...') would produce a new digest that no longer matches
-- the original PIN, silently locking every till out with no error.
-- '$2' is the bcrypt prefix (2a/2b/2y); plaintext digits can never
-- collide with it.
--
-- pgcrypto: a standard PostgreSQL contrib extension, preinstalled and
-- available for CREATE EXTENSION on every Supabase project (no
-- superuser step required — Supabase grants the owning role enough
-- privilege to enable it via plain SQL). Documented at
-- supabase.com/docs/guides/database/extensions/pgcrypto.
--
-- search_path: set_member_pin and match_member_pin use
-- `SET search_path = public, extensions` (function-level, reverts on
-- exit); statement 6 uses `SET LOCAL search_path = public, extensions`
-- inside its own DO block for the same reason, rather than
-- schema-qualifying crypt()/gen_salt() as `extensions.crypt(...)`. A
-- schema named in search_path that doesn't exist is silently ignored,
-- so this resolves correctly whether pgcrypto lives in `public` or
-- `extensions` — schema-qualifying to `extensions.` explicitly would
-- break the opposite case (pgcrypto actually in `public`).
--
-- Custom SQLSTATE: set_member_pin raises SQLSTATE 'P0409' on a PIN
-- collision (a custom subclass of the P0 "PL/pgSQL Error" class,
-- chosen to read as "409" so it's easy to recognise in route code).
-- This replaces 23505/idx_org_members_org_pin, which no longer fires
-- since statement 3 drops that index. Routes must catch
-- error.code === 'P0409' instead and map it to the same 409 response
-- they already return.
--
-- set_member_pin grant: service_role only, NOT authenticated (departs
-- from match_member_pin's pattern below on purpose — see report).
-- All three current callers are server routes using the service-role
-- admin client, and unlike match_member_pin, set_member_pin does not
-- re-check that the caller is authorized to touch p_member_id (that
-- authorization — owner-only, or "your own row" — lives in the TS
-- route handlers). Granting it to `authenticated` would let any
-- signed-in member call it directly from the browser against any
-- org_members id, bypassing those route-level checks entirely and
-- overwriting another member's (or the owner's) PIN. service_role
-- already receives EXECUTE on every new function by Supabase's
-- default privileges (see migration 080's header); the explicit
-- REVOKE/GRANT below just makes that intentional and pins it down
-- against a future blanket grant to authenticated.
--
-- No BEGIN/COMMIT — see migration 096 for why (Supabase SQL Editor
-- does not guarantee a pasted multi-statement script shares one
-- connection/transaction). Statements 1-5 and 7 are independently
-- idempotent and safe to re-run in any grouping. Statement 6 is
-- self-contained (its own DO block, own SET LOCAL, own implicit
-- transaction) and safe to re-run on its own at any time — the
-- `NOT LIKE '$2%'` guard inside it is permanent, not something that
-- has to be remembered to re-add.
--
-- Depends on: 097 (org_members.pin, idx_org_members_org_pin,
-- match_member_pin — everything this migration replaces or builds on).
--
-- Record with:
--   node node_modules/supabase/dist/supabase.js migration repair \
--     --status applied 108
-- ============================================================


-- ============================================================
-- STATEMENT 1: Enable pgcrypto (crypt(), gen_salt())
--
-- No-op if it already exists in another schema (commonly `extensions`
-- on Supabase) — see the "BEFORE APPLYING" note above. That's fine:
-- statements 4/5/6 resolve it via search_path, not by assuming it
-- landed here.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- ============================================================
-- STATEMENT 2: Widen pin to TEXT before hashing
--
-- Must run before statement 6. A bcrypt digest is 60 characters;
-- VARCHAR(6) cannot hold one.
-- ============================================================

ALTER TABLE org_members ALTER COLUMN pin TYPE TEXT;


-- ============================================================
-- STATEMENT 3: Drop the unique index
--
-- idx_org_members_org_pin (097) enforced (org_id, pin) uniqueness on
-- every plaintext PIN up to this point, so no two members in the same
-- org can already share a PIN — the conversion in statement 6 cannot
-- create ambiguity in existing data. After conversion, salted hashes
-- of the same PIN differ, so this index would enforce nothing anyway.
-- Duplicate-prevention moves to set_member_pin (statement 4).
-- ============================================================

DROP INDEX IF EXISTS idx_org_members_org_pin;


-- ============================================================
-- STATEMENT 4: set_member_pin — SECURITY DEFINER writer + dup check
--
-- Created before the conversion (statement 6) runs — see the
-- statement-order note in the header. Replaces the duplicate-PIN
-- rejection idx_org_members_org_pin used to provide (SQLSTATE 23505).
-- That index is gone (statement 3), so the check happens here instead,
-- scoped to the target member's org. Re-validates the PIN format
-- server-side — never trusts the caller, even though every current
-- caller already validates the same regex in TypeScript first.
-- Accepts NULL to clear a PIN.
--
-- Caller authorization (who may change whose PIN) is NOT this
-- function's job — it lives in the TS route handlers, same as before
-- this migration. See the grant note in the migration header for why
-- that means this function must stay service_role-only.
--
-- search_path includes `extensions` alongside `public` so crypt()/
-- gen_salt() resolve regardless of which schema pgcrypto lives in —
-- see the search_path note in the migration header.
-- ============================================================

CREATE OR REPLACE FUNCTION set_member_pin(p_member_id UUID, p_pin TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_org_id UUID;
BEGIN
  SELECT org_id INTO v_org_id FROM org_members WHERE id = p_member_id;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Member not found';
  END IF;

  IF p_pin IS NULL THEN
    UPDATE org_members SET pin = NULL WHERE id = p_member_id;
    RETURN;
  END IF;

  IF p_pin !~ '^\d{4,6}$' THEN
    RAISE EXCEPTION 'PIN must be 4-6 digits';
  END IF;

  IF EXISTS (
    SELECT 1 FROM org_members om
     WHERE om.org_id = v_org_id
       AND om.id <> p_member_id
       AND om.pin IS NOT NULL
       AND om.pin = crypt(p_pin, om.pin)
  ) THEN
    -- Custom SQLSTATE — see "Custom SQLSTATE" in the migration header.
    RAISE EXCEPTION 'PIN already in use in this organisation'
      USING ERRCODE = 'P0409';
  END IF;

  UPDATE org_members
     SET pin = crypt(p_pin, gen_salt('bf', 10))
   WHERE id = p_member_id;
END;
$$;

-- service_role only — see "set_member_pin grant" in the migration
-- header for why this departs from match_member_pin's authenticated
-- grant below.
REVOKE EXECUTE ON FUNCTION set_member_pin(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION set_member_pin(UUID, TEXT) TO service_role;


-- ============================================================
-- STATEMENT 5: Rewrite match_member_pin for bcrypt
--
-- Created before the conversion (statement 6) runs — see the
-- statement-order note in the header. Everything unchanged from 097
-- except the comparison itself: the membership guard, the
-- empty-set-on-no-match behaviour, SECURITY DEFINER, and the
-- authenticated grant. search_path now also includes `extensions` —
-- see the search_path note in the migration header.
--
-- This now costs one bcrypt comparison per member in the org per
-- login attempt (crypt() must run once per candidate row, since each
-- row's salt differs), rather than an indexed equality lookup. Fine
-- at current scale; worth revisiting if an org ever has hundreds of
-- members.
-- ============================================================

CREATE OR REPLACE FUNCTION match_member_pin(p_org_id UUID, p_pin TEXT)
RETURNS TABLE(id UUID, role TEXT, display_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  -- Only someone already signed into THIS org's own dashboard session
  -- may look up PINs scoped to it — otherwise this function would be a
  -- cross-tenant PIN-guessing oracle.
  IF NOT EXISTS (
    SELECT 1 FROM org_members WHERE org_id = p_org_id AND user_id = auth.uid()
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT om.id, om.role, om.display_name
      FROM org_members om
     WHERE om.org_id = p_org_id
       AND om.pin IS NOT NULL
       AND om.pin = crypt(p_pin, om.pin)
     LIMIT 1;
END;
$$;

REVOKE EXECUTE ON FUNCTION match_member_pin(UUID, TEXT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION match_member_pin(UUID, TEXT) TO authenticated;


-- ============================================================
-- STATEMENT 6: Pre-flight + convert — one self-contained block
--
-- Single DO block: SET LOCAL scopes search_path to this block's own
-- implicit transaction, so the pre-flight check and the conversion
-- UPDATE share exactly one search_path with no dependency on the SQL
-- Editor session still holding an earlier SET — safe whether the
-- owner pastes the whole migration at once or runs statements one at
-- a time. See "Why one block" in the migration header.
--
-- The pre-flight (PERFORM crypt(...)) proves crypt()/gen_salt() are
-- resolvable BEFORE the UPDATE touches any live PIN; if not, it raises
-- and the UPDATE never runs. The idempotency guard
-- (`pin NOT LIKE '$2%'`) is mandatory and permanent — see "Idempotency"
-- in the migration header. Cost 10 explicit — pgcrypto's
-- gen_salt('bf') default is cost 6, too weak to rely on implicitly.
-- ============================================================

DO $$
BEGIN
  SET LOCAL search_path = public, extensions;

  PERFORM crypt('0000', gen_salt('bf', 10));

  UPDATE org_members
     SET pin = crypt(pin, gen_salt('bf', 10))
   WHERE pin IS NOT NULL
     AND pin NOT LIKE '$2%';
EXCEPTION WHEN undefined_function THEN
  RAISE EXCEPTION 'pgcrypto not resolvable on this search_path — STOP, the conversion did not run';
END $$;


-- ============================================================
-- STATEMENT 7: Correct the column comment
--
-- 097 said "stored as entered" — that is now false.
-- ============================================================

COMMENT ON COLUMN org_members.pin IS
  'Personal till PIN (4-6 digits), stored as a bcrypt digest (pgcrypto, cost 10) — never plaintext. Nullable — a member without one falls back to the shared location_settings admin_pin/cashier_pin. Write only via set_member_pin() (service_role only); read/compare only via match_member_pin(). Never readable by the authenticated role directly (097, statement 3).';


-- ============================================================
-- VERIFY:
--
-- 1. pgcrypto enabled (and note which schema, for the record):
--   SELECT e.extname, n.nspname AS schema
--     FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
--    WHERE e.extname = 'pgcrypto';
--
-- 2. pin widened to TEXT:
--   SELECT column_name, data_type
--     FROM information_schema.columns
--    WHERE table_name = 'org_members' AND column_name = 'pin';
--   -- expect data_type = 'text'
--
-- 3. Unique index gone:
--   SELECT indexname FROM pg_indexes
--    WHERE tablename = 'org_members' AND indexname = 'idx_org_members_org_pin';
--   -- expect 0 rows
--
-- 4. Conversion complete and idempotency guard holds (do NOT select
--    pin itself — shape only):
--   SELECT COUNT(*) FROM org_members WHERE pin IS NOT NULL AND pin NOT LIKE '$2%';
--   -- expect 0
--
-- 5. set_member_pin ACL (expect service_role only, no PUBLIC/anon/authenticated):
--   SELECT proname, array_to_string(proacl, ' ')
--     FROM pg_proc WHERE proname = 'set_member_pin';
--
-- 6. match_member_pin ACL (expect authenticated only, no anon/PUBLIC):
--   SELECT proname, array_to_string(proacl, ' ')
--     FROM pg_proc WHERE proname = 'match_member_pin';
--
-- 7. Column comment updated:
--   SELECT col_description('org_members'::regclass, ordinal_position)
--     FROM information_schema.columns
--    WHERE table_name = 'org_members' AND column_name = 'pin';
-- ============================================================
