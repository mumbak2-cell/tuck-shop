-- ============================================================
-- Migration 110: DB-side PIN brute-force throttle
--
-- Follow-on to 108 (bcrypt PIN hashing) and 109 (server-issued till
-- session tokens). Those closed the "read the PIN off the table" and
-- "forge the cached role" holes; the till PIN comparison itself was
-- still unthrottled. Every till login and every manager-override
-- check runs a PIN compare inside a SECURITY DEFINER function that any
-- signed-in user can call over PostgREST as often as they like — a
-- 4-digit space is minutes of guessing, a 6-digit space hours. This
-- migration adds a per-caller attempt counter and a short lockout,
-- entirely server-side, so it cannot be skipped by talking to the RPC
-- directly instead of going through the Next.js app.
--
-- Purely additive to schema: one new table, two new helper functions.
-- The three existing entry points are re-created only to weave the
-- throttle call in — no existing behaviour, argument list, or result
-- shape changes, and auth-context.tsx / payment-modal.tsx are NOT
-- touched (same args in, same rows/NULL out). No .ts/.tsx change is
-- part of this migration.
--
-- ── THRESHOLD RATIONALE (do not "fix" this — it is a deliberate
--    tradeoff) ────────────────────────────────────────────────────
-- 10 failures per rolling 60s, then a 60-SECOND lockout — deliberately
-- NOT the ~15 minutes a normal web login uses. Chichi's Bakes runs a
-- shared owner login, so the counter is per till-operator-account in
-- practice; a long lockout stops sales at the counter. 10/min turns a
-- 4-digit brute force from minutes into ~16 hours and makes a 6-digit
-- PIN infeasible, while a cashier who fat-fingers the pad waits at
-- most 60 seconds. Till availability is worth more than the marginal
-- hardening of a longer lockout. The three tunables live in one place
-- only: the CONSTANT block at the top of till_pin_record() (STATEMENT
-- 2).
--
-- ── NO NEW ORACLE ─────────────────────────────────────────────────
-- A throttled call returns EXACTLY what a wrong PIN returns: no rows
-- from create_till_session(), NULL from match_location_pin(). It never
-- RAISEs, never returns a distinct error code, never changes the
-- caller-visible message. The client cannot tell "locked out" from
-- "wrong PIN".
--
-- ── WHERE THE COUNTING LIVES (non-obvious — do not "tidy" it) ──────
-- Failure counting lives in match_location_pin() because it is the
-- funnel every failed attempt necessarily reaches: create_till_session
-- tries the per-user PIN first (priority 1) and hands anything that
-- misses to match_location_pin (priority 2) before a login can fail,
-- and the manager-override path calls match_location_pin directly.
-- Traces:
--   * wrong PIN via create_till_session -> match_member_pin misses
--     silently -> match_location_pin misses -> records FALSE once ->
--     create_till_session returns empty WITHOUT recording. Total: 1.
--   * wrong PIN via payment-modal override -> match_location_pin
--     records FALSE once. Total: 1.
--   * correct per-user PIN -> create_till_session records TRUE, counter
--     cleared.
--   * correct branch PIN (either caller) -> match_location_pin records
--     TRUE, counter cleared.
-- So "10 failures per rolling 60s then a 60-second lockout" holds
-- verbatim and VERIFY step 3 passes as written. Keep both unchanged.
-- The guard call is deliberately duplicated — create_till_session
-- guards, then match_location_pin guards again — because till_pin_guard
-- is a read-only check, so double-guarding is harmless and neither
-- entry point depends on the other for its lockout.
--
-- ── match_member_pin() GRANT REMOVED (STATEMENT 3) ────────────────
-- match_member_pin() has zero client call sites — the only caller is
-- create_till_session(), a SECURITY DEFINER function that runs as its
-- owner and still reaches it after the REVOKE. Its 108-era
-- `GRANT EXECUTE ... TO authenticated` was pure brute-force surface
-- (call it directly, guess per-user PINs a whole org at a time). We
-- remove the grant rather than throttle a function nothing should be
-- calling — the same move 108 makes for set_member_pin() (revoked
-- from authenticated, service_role only). Its body is unchanged.
--
-- ── search_path ──────────────────────────────────────────────────
-- The two new helpers use `public, extensions`, consistent with every
-- SECURITY DEFINER function since 108. match_location_pin() keeps its
-- existing bare `SET search_path = public` unchanged — the throttle
-- helpers it now calls live in `public` and resolve fine; widening it
-- is not part of this change.
--
-- No BEGIN/COMMIT — see migration 096 for why (the Supabase SQL
-- Editor does not guarantee a pasted multi-statement script shares one
-- connection/transaction). Every statement below is independently
-- idempotent and safe to re-run.
--
-- This migration is NOT applied by this change — the owner applies it
-- by hand in the SQL Editor. Record with:
--   npx supabase migration repair --status applied 110
-- ============================================================


-- ============================================================
-- STATEMENT 1: till_pin_attempts table
--
-- One row per caller, keyed on auth.uid(). Created lazily on the
-- first failed PIN attempt (till_pin_record) and deleted on the next
-- success. RLS is enabled with NO policies and every direct grant is
-- revoked: the only readers/writers are the SECURITY DEFINER helpers
-- in STATEMENT 2, which run as the function owner and are therefore
-- RLS-exempt — the same "RLS on, zero policies, grants revoked"
-- pattern 109 uses for till_sessions. The REVOKE makes "no direct
-- access" true at the grant level too, not only the policy level.
--
-- org_id is last-seen-org, forensics only, nullable — the counter
-- keys on auth.uid() alone.
-- ============================================================

CREATE TABLE IF NOT EXISTS till_pin_attempts (
  user_id      UUID PRIMARY KEY,
  org_id       UUID,
  fail_count   INT NOT NULL DEFAULT 0,
  window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until TIMESTAMPTZ
);

COMMENT ON TABLE till_pin_attempts IS
  'Backs the till/PIN brute-force throttle (migration 110). One row per caller (user_id = auth.uid()), created lazily on the first failed PIN attempt and deleted on the next success. Reachable only through the SECURITY DEFINER functions till_pin_guard() / till_pin_record(), which run as owner and are therefore RLS-exempt; RLS is enabled with no policies and all direct grants are revoked, so anon/authenticated have no direct access at either the policy or the grant level. org_id is last-seen-org, forensics only, nullable.';

ALTER TABLE till_pin_attempts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON till_pin_attempts FROM PUBLIC, anon, authenticated;


-- ============================================================
-- STATEMENT 2: throttle helpers
--
-- Both SECURITY DEFINER, both `SET search_path = public, extensions`,
-- both revoked from PUBLIC/anon/authenticated with NO grant to
-- anyone — callable only by the other SECURITY DEFINER functions
-- (STATEMENTS 4 and 5), which run as owner.
--
--   till_pin_guard()  -> TRUE  = caller may proceed to a PIN compare
--                        FALSE = caller is inside an active lockout;
--                                the entry point must bail returning
--                                exactly what a wrong PIN returns.
--   till_pin_record(p_org_id, p_success)
--                     -> success: delete the caller's row (clean slate)
--                        failure: bump the rolling counter, rotating
--                                 the window if it has aged out, and
--                                 start a lockout once the ceiling is
--                                 hit.
-- ============================================================

CREATE OR REPLACE FUNCTION till_pin_guard()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  -- Read-only: just the materialised lockout flag. The policy
  -- tunables (c_max_fails / c_lockout / c_window) live in
  -- till_pin_record() below — the one place to tune this throttle.
  RETURN NOT EXISTS (
    SELECT 1 FROM till_pin_attempts
     WHERE user_id = auth.uid()
       AND locked_until IS NOT NULL
       AND locked_until > now()
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION till_pin_guard() FROM PUBLIC, anon, authenticated;


CREATE OR REPLACE FUNCTION till_pin_record(p_org_id UUID, p_success BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  -- ── THE ONE PLACE TO TUNE THIS THROTTLE ──────────────────────────
  --   10 failures per rolling 60s, then a 60-SECOND lockout.
  --   Deliberately NOT the ~15 minutes a normal web login uses — see
  --   the THRESHOLD RATIONALE in this migration's header before
  --   changing anything here.
  c_max_fails CONSTANT INT      := 10;
  c_lockout   CONSTANT INTERVAL := INTERVAL '60 seconds';
  c_window    CONSTANT INTERVAL := INTERVAL '60 seconds';
  -- ────────────────────────────────────────────────────────────────
  v_fail_count INT;
BEGIN
  IF p_success THEN
    -- Correct PIN: clean slate.
    DELETE FROM till_pin_attempts WHERE user_id = auth.uid();
    RETURN;
  END IF;

  -- Wrong PIN: bump the rolling counter, rotating the window if the
  -- previous one has aged out (both CASE arms read the pre-update
  -- window_start, so they stay consistent with each other).
  INSERT INTO till_pin_attempts (user_id, org_id, fail_count, window_start)
  VALUES (auth.uid(), p_org_id, 1, now())
  ON CONFLICT (user_id) DO UPDATE SET
    org_id       = p_org_id,
    fail_count   = CASE
                     WHEN now() - till_pin_attempts.window_start > c_window THEN 1
                     ELSE till_pin_attempts.fail_count + 1
                   END,
    window_start = CASE
                     WHEN now() - till_pin_attempts.window_start > c_window THEN now()
                     ELSE till_pin_attempts.window_start
                   END
  RETURNING fail_count INTO v_fail_count;

  -- Ceiling hit: start the lockout and reset the counter so the next
  -- window is clean the moment the lockout expires.
  IF v_fail_count >= c_max_fails THEN
    UPDATE till_pin_attempts
       SET locked_until = now() + c_lockout,
           fail_count   = 0,
           window_start = now()
     WHERE user_id = auth.uid();
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION till_pin_record(UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;


-- ============================================================
-- STATEMENT 3: drop match_member_pin() off the brute-force surface
--
-- Zero client call sites — only create_till_session() (STATEMENT 5)
-- calls it, and does so as a SECURITY DEFINER function running as its
-- owner, which still has EXECUTE after this REVOKE. The 108-era grant
-- to authenticated was pure attack surface. No body change; anon was
-- already revoked in 097/108; service_role is untouched. REVOKE of an
-- absent privilege is a no-op, so this is safe to re-run.
-- ============================================================

REVOKE EXECUTE ON FUNCTION match_member_pin(UUID, TEXT) FROM authenticated;


-- ============================================================
-- STATEMENT 4: match_location_pin() — add the guard + the recorder
--
-- Body reproduced verbatim from migration 100 (never rewritten
-- since), with only the throttle woven in:
--   * after the existing membership check, before any PIN compare:
--       IF NOT till_pin_guard() THEN RETURN NULL; END IF;
--   * after the compare: record TRUE on a match, FALSE on no match,
--     then RETURN v_role exactly as before.
-- The two pre-check RETURN NULL paths (unknown location / not a
-- member) record nothing — they are not PIN attempts. p_org_id to
-- till_pin_record is NULL here (the counter keys on auth.uid(); the
-- column is forensics only) — no lookup join is added. `SET
-- search_path = public` is preserved exactly. The existing REVOKE /
-- GRANT lines are unchanged.
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

  -- Migration 110: brute-force throttle. Inside an active lockout,
  -- return the wrong-PIN answer (NULL) with nothing compared and
  -- nothing recorded. This function is the funnel every failed till
  -- login reaches (see the header), so it is the single site that
  -- records failures.
  IF NOT till_pin_guard() THEN
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

  IF v_role IS NOT NULL THEN
    PERFORM till_pin_record(NULL, TRUE);   -- correct PIN: clear the counter
  ELSE
    PERFORM till_pin_record(NULL, FALSE);  -- wrong PIN: bump the counter
  END IF;

  RETURN v_role;
END;
$$;

REVOKE EXECUTE ON FUNCTION match_location_pin(UUID, TEXT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION match_location_pin(UUID, TEXT) TO authenticated;


-- ============================================================
-- STATEMENT 5: create_till_session() — add the guard + success record
--
-- Body reproduced verbatim from migration 109, with only the throttle
-- woven in:
--   * right after the existing org-membership check:
--       IF NOT till_pin_guard() THEN RETURN; END IF;
--   * on the priority-1 (per-user PIN matched) branch only, before
--     the INSERT: till_pin_record(p_org_id, TRUE) — clear the counter.
-- The priority-2 success path records nothing (match_location_pin
-- already recorded TRUE) and every RETURN no-match path records
-- nothing (match_location_pin already recorded FALSE) — so a wrong
-- PIN through this function increments the counter by exactly 1. The
-- existing REVOKE / GRANT lines are unchanged.
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

  -- Migration 110: brute-force throttle. Inside an active lockout,
  -- return no rows — exactly a wrong PIN's result — before any PIN is
  -- checked. Deliberately redundant with the guard in
  -- match_location_pin(): till_pin_guard() is read-only, so
  -- double-guarding costs nothing and neither entry point trusts the
  -- other for its lockout.
  IF NOT till_pin_guard() THEN
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
    -- Correct per-user PIN: clear the counter. The priority-2 success
    -- path does NOT record here — match_location_pin() already did.
    PERFORM till_pin_record(p_org_id, TRUE);
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
-- VERIFY:
--
-- 1. Table + RLS present, no policies, no direct grants:
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'till_pin_attempts';
--   -- expect true
--   SELECT polname FROM pg_policy WHERE polrelid = 'till_pin_attempts'::regclass;
--   -- expect 0 rows
--   SELECT grantee, privilege_type FROM information_schema.table_privileges
--    WHERE table_name = 'till_pin_attempts' AND grantee IN ('anon', 'authenticated');
--   -- expect 0 rows
--
-- 2. Function ACLs:
--   SELECT proname, array_to_string(proacl, ' ')
--     FROM pg_proc
--    WHERE proname IN ('till_pin_guard', 'till_pin_record',
--                      'match_location_pin', 'create_till_session');
--   -- till_pin_guard / till_pin_record: EXECUTE granted to nobody
--   --   (proacl NULL or owner-only, no anon= / authenticated= entry).
--   -- match_location_pin / create_till_session: unchanged from before
--   --   this migration — authenticated=X present, no anon / PUBLIC.
--
-- 3. Functional — run as a real authenticated org member via the
--    app's Supabase client (RPC), NOT the SQL Editor postgres role;
--    everything keys off auth.uid(). Angle-bracket placeholders only:
--   -- 10x:
--   SELECT * FROM create_till_session('<org-id>'::uuid, '<location-id>'::uuid, '<wrong-pin>');
--   -- each: expect 0 rows
--   -- 11th, with the CORRECT pin:
--   SELECT * FROM create_till_session('<org-id>'::uuid, '<location-id>'::uuid, '<correct-pin>');
--   -- expect 0 rows (locked out — indistinguishable from a wrong PIN)
--   -- wait 60s, then the CORRECT pin again:
--   SELECT * FROM create_till_session('<org-id>'::uuid, '<location-id>'::uuid, '<correct-pin>');
--   -- expect one row: token, role, display_name, member_id
--
-- 4. Clean-counter success leaves no row:
--   -- with no prior failures for this caller, one correct PIN logs in
--   -- first try, then:
--   SELECT count(*) FROM till_pin_attempts WHERE user_id = '<caller-uid>'::uuid;
--   -- expect 0
--
-- 5. Full POS flow (sale -> payment -> receipt) is unaffected.
--
-- 6. match_member_pin() ACL + reachability:
--   SELECT proname, array_to_string(proacl, ' ')
--     FROM pg_proc WHERE proname = 'match_member_pin';
--   -- expect NO 'authenticated=X' entry
--   -- then confirm a per-user PIN login still works end to end via the
--   -- app (proves the SECURITY DEFINER owner-context call path from
--   -- create_till_session into match_member_pin is intact).
--
-- 7. Manager-override flow (payment-modal.tsx) still accepts a correct
--    override PIN, and is under the same lockout:
--   -- 10x:
--   SELECT match_location_pin('<location-id>'::uuid, '<wrong-pin>');   -- expect NULL
--   SELECT match_location_pin('<location-id>'::uuid, '<correct-override-pin>');
--   -- expect NULL (locked out) until the 60s window passes, then the
--   -- correct override PIN returns 'admin' / 'cashier' again.
--
-- 8. Counting is exactly 1 per wrong attempt through create_till_session
--    (this is the regression this design exists to prevent):
--   -- from a clean counter, one wrong PIN via create_till_session, then:
--   SELECT fail_count FROM till_pin_attempts WHERE user_id = '<caller-uid>'::uuid;
--   -- expect 1  (NOT 2 or 3)
-- ============================================================
