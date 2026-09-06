-- ============================================================
-- Migration 112: surface the till-PIN lockout to the operator
--
-- A conversation with migration 110, not a footnote to it:
--
-- Migration 110 chose NO ORACLE on purpose. A caller inside an active
-- lockout gets back EXACTLY what a wrong PIN gets back — no rows from
-- create_till_session(), NULL from match_location_pin(), no distinct
-- error, no distinct message. From the client there is no way to tell
-- "locked out" from "wrong PIN". That was the right call for the four
-- throttle functions and they keep that behaviour verbatim.
--
-- Migration 112 DELIBERATELY REVERSES that choice — for the operator's
-- benefit, and only there. The reasoning:
--   * An attacker who is being throttled gains nothing. They already
--     know their own attempt count, and the 60s lockout is measurable
--     from timing whether or not we name it. Telling the locked-out
--     user "you are locked out for N seconds" hands a brute-forcer no
--     information they could not already derive about themselves.
--   * A cashier mid-queue who reads "Incorrect PIN. Try again." when
--     the PIN is in fact correct loses a lot: they retype, re-lock,
--     call the owner, and the till stops. The owner hit exactly this
--     in testing of migration 110 and reported the correct PIN as
--     broken. If the person who commissioned the throttle misreads
--     its silent lockout, a cashier certainly will.
--
-- The exposure is A SEPARATE, NEW FUNCTION. till_pin_guard(),
-- till_pin_record(), match_location_pin() and create_till_session()
-- are NOT touched by this migration and keep returning the
-- wrong-PIN-indistinguishable result. till_pin_lockout_seconds() is
-- the ONLY thing that reveals the lockout, and it reveals it only to
-- the locked-out user, about their own lockout.
--
-- ── KEYED ON auth.uid() ONLY ─────────────────────────────────────
-- The lookup is `WHERE user_id = auth.uid()`. There is no argument.
-- A caller can never name another user, so a caller can never learn
-- anything about another user's lockout — same key the whole throttle
-- uses (migration 110: till_pin_attempts.user_id = auth.uid()).
--
-- ── SECONDS, NOT A BOOLEAN, ON PURPOSE ───────────────────────────
-- The remaining time is computed server-side from `locked_until -
-- now()` so client clock skew cannot produce a wrong countdown. And
-- if the 60s c_lockout constant in till_pin_record() (migration 110,
-- STATEMENT 2) is ever retuned, this function follows automatically —
-- it reads locked_until, not the constant — so no new migration is
-- needed to keep the surfaced number honest.
--
-- Purely additive: one new SECURITY DEFINER function, no schema
-- change, no data touched, no existing object altered. CREATE OR
-- REPLACE, safe to re-run. No BEGIN/COMMIT — see migration 096 (the
-- Supabase SQL Editor does not guarantee a pasted multi-statement
-- script shares one connection/transaction); the single statement
-- below is idempotent on its own.
--
-- search_path is `public, extensions`, the house convention for every
-- SECURITY DEFINER function since 108 (see migration 111's header).
--
-- This migration is NOT applied by this change — the owner applies it
-- by hand in the SQL Editor. Record with:
--   npx supabase migration repair --status applied 112
-- ============================================================


-- ============================================================
-- STATEMENT 1: till_pin_lockout_seconds()
--
-- Returns the whole seconds left on the CALLER'S OWN till-PIN
-- lockout, or NULL when the caller is not locked out (no row, or the
-- row's locked_until is in the past / NULL). Read-only: a single
-- SELECT against till_pin_attempts, no write, no data touched.
--
-- GREATEST(0, ...) floors the result at 0 so a lockout that expires
-- between the WHERE check and the arithmetic can never surface as a
-- negative number. CEIL rounds a partial second up, so the last
-- fractional second still reads as "1" rather than "0".
--
-- Granted to `authenticated` only; revoked from PUBLIC and anon. The
-- throttle helpers it sits beside (till_pin_guard / till_pin_record)
-- are granted to nobody — this one is client-callable because
-- surfacing the lockout to the signed-in operator is the entire point.
-- ============================================================

CREATE OR REPLACE FUNCTION till_pin_lockout_seconds()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_seconds INT;
BEGIN
  SELECT GREATEST(0, CEIL(EXTRACT(EPOCH FROM (locked_until - now()))))::INT
    INTO v_seconds
    FROM till_pin_attempts
   WHERE user_id = auth.uid()
     AND locked_until > now();
  RETURN v_seconds;  -- no row -> NULL -> "not locked"
END;
$$;

REVOKE EXECUTE ON FUNCTION till_pin_lockout_seconds() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION till_pin_lockout_seconds() TO authenticated;


-- ============================================================
-- VERIFY:
--
-- 1. ACL — granted to authenticated only, not anon / PUBLIC:
--   SELECT proname, array_to_string(proacl, ' ')
--     FROM pg_proc WHERE proname = 'till_pin_lockout_seconds';
--   -- expect an 'authenticated=X' entry, no 'anon=' / bare PUBLIC entry
--
-- 2. Re-runnable — paste the CREATE OR REPLACE again:
--   -- expect no error; no rows anywhere are touched (read-only body)
--
-- 3. Functional — run as a real authenticated org member via the
--    app's Supabase client (RPC), NOT the SQL Editor postgres role;
--    everything keys off auth.uid():
--   -- not locked out:
--   SELECT till_pin_lockout_seconds();          -- expect NULL
--   -- during a lockout (10 wrong PINs within 60s first):
--   SELECT till_pin_lockout_seconds();          -- expect a positive INT
--   -- call again a few seconds later:           -- expect a smaller INT
--   -- after the 60s lockout expires:
--   SELECT till_pin_lockout_seconds();          -- expect NULL again
--
-- 4. OWNER MUST VERIFY, in the app:
--   -- 10 wrong PINs in a row  -> the PIN pad shows the lockout message
--   --                            ("Too many attempts — try again in a minute")
--   -- 1 wrong PIN on a clean counter
--   --                          -> the pad still shows the ordinary
--   --                             message ("Incorrect PIN. Try again.")
--   -- wait 60s, then the CORRECT PIN
--   --                          -> logs in normally
-- ============================================================
