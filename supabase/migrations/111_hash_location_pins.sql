-- ============================================================
-- Migration 111: Hash location branch PINs (bcrypt via pgcrypto)
--                + server-side writer set_location_pin()
--
-- location_settings.value for keys 'admin_pin' / 'cashier_pin' has
-- been stored as plaintext digits since 0230_locations.sql. Migration
-- 108 closed exactly this hole for the per-member org_members.pin;
-- this migration closes it for the shared per-branch PINs. Today the
-- settings page (src/app/(dashboard)/settings/page.tsx) reads those
-- values straight off the table over PostgREST and writes them back
-- verbatim, and match_location_pin() (migration 110) compares them
-- with `value = p_pin`. After this migration:
--   * set_location_pin() is the only writer — SECURITY DEFINER, it
--     bcrypt-hashes on write and refuses a caller who is not an
--     owner/admin of the location's org.
--   * every existing plaintext branch PIN is converted in place to a
--     bcrypt digest (STATEMENT 3).
--   * match_location_pin() compares with `value = crypt(p_pin, value)`
--     (STATEMENT 4).
--
-- ONE-WAY / IRREVERSIBLE: STATEMENT 3 overwrites the plaintext PINs
-- with salted digests, exactly like migration 108 statement 6. There
-- is no rollback other than restoring a backup taken outside this
-- migration. The current branch PINs must be known before applying —
-- afterwards they can only be re-set (via the settings page), never
-- read back.
--
-- pgcrypto / search_path (the defect 108's header warned about, now
-- live): pgcrypto is commonly enabled in Supabase's `extensions`
-- schema, not `public`. Every crypt()/gen_salt() call site here
-- resolves it via `search_path = public, extensions` rather than
-- assuming a schema. match_location_pin() carried a bare
-- `SET search_path = public` (migration 110) — harmless until now,
-- but crypt() does not resolve on it, so STATEMENT 4 widens it to
-- `public, extensions`. A schema named in search_path that does not
-- exist is silently ignored, so this is correct whether pgcrypto
-- lives in `public` or `extensions`.
--
-- Statement order:
--   1. pgcrypto preflight   — standalone tripwire; fail loudly BEFORE
--                             STATEMENT 2/3 if crypt()/gen_salt() do
--                             not resolve
--   2. set_location_pin()   — SECURITY DEFINER writer + owner/admin
--                             check, created before the conversion
--   3. convert in place     — self-contained DO block (own SET LOCAL,
--                             own preflight, guarded UPDATE,
--                             undefined_function trap) mirroring
--                             migration 108 statement 6
--   4. match_location_pin() — rewrite the compare to bcrypt verify +
--                             widen search_path
-- STATEMENTS 3 and 4 belong together: applied one at a time, branch
-- PIN login is broken in the gap between them (hashed data, old
-- `value = p_pin` compare). Apply the whole file in one go.
--
-- Idempotency: the `value NOT LIKE '$2%'` guard inside STATEMENT 3 is
-- mandatory and permanent — identical rationale to migration 108's
-- statement 6 guard. Re-running must not re-hash an already-hashed
-- value: bcrypt('$2a$10$...') yields a new digest that no longer
-- matches the PIN, silently locking the branch out with no error.
-- '$2' is the bcrypt prefix (2a/2b/2y); plaintext digits can never
-- collide with it. STATEMENTS 2 and 4 are CREATE OR REPLACE;
-- STATEMENT 1 is a read-only preflight — all re-runnable.
--
-- NULL handling of that guard is deliberate — do NOT "fix" it with
-- COALESCE: `NULL NOT LIKE '$2%'` is NULL, not TRUE, so a
-- location_settings row with a NULL value is simply skipped by
-- STATEMENT 3's UPDATE (no crash, nothing converted), which is the
-- wanted behaviour. In practice value is NOT NULL in the 0230 DDL, so
-- this is a semantics note, not a live case.
--
-- No BEGIN/COMMIT — see migration 096 (the Supabase SQL Editor does
-- not guarantee a pasted multi-statement script shares one
-- connection/transaction). STATEMENTS 1, 2 and 4 are independently
-- idempotent; STATEMENT 3 is self-contained (its own DO block, own
-- SET LOCAL, own implicit transaction) and safe to re-run on its own.
--
-- ROLLOUT ORDER (see the PR body):
--   1. Hand-apply this migration IN FULL in the SQL Editor FIRST.
--   2. THEN deploy the client (the settings-page change).
-- Do NOT save the settings page between applying this migration and
-- the new client going live: the old client reads location_settings
-- values into the PIN fields and writes them straight back, so it
-- would store a bcrypt digest back as a literal `value` and break
-- that branch's PIN login until it is re-set.
--
-- Depends on: 0230 (location_settings, UNIQUE (location_id, key)),
-- 108 (pgcrypto extension + the house bcrypt/search_path pattern),
-- 110 (current match_location_pin with the brute-force throttle weave
-- that STATEMENT 4 must preserve verbatim).
--
-- Record with:
--   npx supabase migration repair --status applied 111
-- ============================================================


-- ============================================================
-- STATEMENT 1: pgcrypto preflight — standalone early tripwire
--
-- Proves crypt()/gen_salt() resolve on `public, extensions` BEFORE
-- STATEMENT 2 or 3 touch anything. If pgcrypto is not resolvable this
-- RAISEs here, so a misconfigured environment fails before any PIN is
-- written or converted. Does not itself CREATE EXTENSION — migration
-- 108 STATEMENT 1 already did, and this migration depends on 108.
-- ============================================================

DO $$
BEGIN
  SET LOCAL search_path = public, extensions;
  PERFORM crypt('0000', gen_salt('bf', 10));
EXCEPTION WHEN undefined_function THEN
  RAISE EXCEPTION 'pgcrypto not resolvable on this search_path — STOP, migration 111 did not run';
END $$;


-- ============================================================
-- STATEMENT 2: set_location_pin — SECURITY DEFINER writer
--
-- The only supported way to write location_settings 'admin_pin' /
-- 'cashier_pin' after this migration. bcrypt-hashes the PIN on write
-- (cost 10 explicit — gen_salt('bf')'s default cost 6 is too weak to
-- rely on implicitly, same as 108) and upserts on the
-- UNIQUE (location_id, key) constraint from 0230.
--
-- Unlike 108's set_member_pin (service_role only, because caller
-- authorization lives in its TS route handlers), this function IS
-- called straight from the browser by an admin on the settings page,
-- so it is granted to `authenticated`. What makes that grant safe is
-- the internal `role IN ('owner','admin')` membership check below: a
-- signed-in cashier — or a member of another org — calling this RPC
-- directly gets 'not authorized', not a write.
--
-- The RAISEs here are caller-programming errors (bad key, bad PIN
-- format, unknown location, unprivileged caller) — none is an oracle
-- against a secret, unlike match_location_pin's deliberate
-- silent-empty return on a wrong PIN guess.
--
-- search_path is `public, extensions` so crypt()/gen_salt() resolve
-- wherever pgcrypto lives — see the migration header.
-- ============================================================

CREATE OR REPLACE FUNCTION set_location_pin(p_location_id UUID, p_key TEXT, p_pin TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_org_id UUID;
BEGIN
  IF p_key NOT IN ('admin_pin', 'cashier_pin') THEN
    RAISE EXCEPTION 'invalid pin key: %', p_key;
  END IF;

  IF p_pin !~ '^[0-9]{4,6}$' THEN
    RAISE EXCEPTION 'PIN must be 4-6 digits';
  END IF;

  SELECT org_id INTO v_org_id FROM locations WHERE id = p_location_id;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'location not found';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM org_members
     WHERE org_id = v_org_id
       AND user_id = auth.uid()
       AND role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'not authorized to set location PINs';
  END IF;

  INSERT INTO location_settings (org_id, location_id, key, value, updated_at)
  VALUES (v_org_id, p_location_id, p_key, crypt(p_pin, gen_salt('bf', 10)), now())
  ON CONFLICT (location_id, key)
  DO UPDATE SET value = EXCLUDED.value, updated_at = now();
END;
$$;

-- Browser-called by an admin (settings page) — hence `authenticated`,
-- not 108's service_role-only. The internal owner/admin check above is
-- what makes that grant safe.
REVOKE EXECUTE ON FUNCTION set_location_pin(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION set_location_pin(UUID, TEXT, TEXT) TO authenticated;


-- ============================================================
-- STATEMENT 3: convert existing plaintext branch PINs in place
--
-- Self-contained DO block mirroring migration 108 statement 6: its
-- own SET LOCAL search_path, its own crypt() preflight, the guarded
-- UPDATE, the undefined_function trap — so it is correct whether the
-- owner pastes the whole file or runs statements one at a time, and
-- never depends on STATEMENT 1 still being in session scope.
--
-- The `value NOT LIKE '$2%'` guard is mandatory and permanent — the
-- same guard, for the same reason, as migration 108 statement 6:
-- re-running must not re-hash an already-hashed value. bcrypt digests
-- start `$2a$/$2b$/$2y$`; plaintext PIN digits can never match, so
-- this is what makes STATEMENT 3 safe to re-run (0 rows on a second
-- pass). Cost 10 explicit, as everywhere else in this codebase.
-- ============================================================

DO $$
BEGIN
  SET LOCAL search_path = public, extensions;
  PERFORM crypt('0000', gen_salt('bf', 10));
  UPDATE location_settings
     SET value = crypt(value, gen_salt('bf', 10))
   WHERE key IN ('admin_pin', 'cashier_pin')
     AND value NOT LIKE '$2%';
EXCEPTION WHEN undefined_function THEN
  RAISE EXCEPTION 'pgcrypto not resolvable on this search_path — STOP, the conversion did not run';
END $$;


-- ============================================================
-- STATEMENT 4: rewrite match_location_pin — bcrypt verify
--
-- Body verbatim from migration 110 STATEMENT 4 (the current
-- definition), with exactly two changes:
--   * SET search_path = public  ->  public, extensions  (crypt() lives
--     in extensions; the bare `public` was the latent defect 108's
--     header flagged, and it now bites)
--   * AND value = p_pin  ->  AND value = crypt(p_pin, value)  (bcrypt
--     verify — the stored digest is its own salt)
-- Everything else is unchanged: both pre-check RETURN NULL paths, the
-- migration-110 brute-force throttle weave (till_pin_guard() ->
-- RETURN NULL; till_pin_record(NULL, TRUE/FALSE) on the two compare
-- outcomes), the ORDER BY key / LIMIT 1 tie-break, RETURN v_role, and
-- the trailing REVOKE / GRANT lines.
-- ============================================================

CREATE OR REPLACE FUNCTION match_location_pin(p_location_id UUID, p_pin TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
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

  -- Migration 111: vs migration 110, only `SET search_path` gains `extensions` and the compare below becomes `value = crypt(p_pin, value)` (bcrypt verify — the stored digest is its own salt) instead of `value = p_pin`.
  SELECT CASE key WHEN 'admin_pin' THEN 'admin' ELSE 'cashier' END
    INTO v_role
    FROM location_settings
   WHERE location_id = p_location_id
     AND key IN ('admin_pin', 'cashier_pin')
     AND value = crypt(p_pin, value)
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
-- VERIFY:
--
-- 1. No plaintext branch PIN left:
--   SELECT count(*) FROM location_settings
--    WHERE key IN ('admin_pin','cashier_pin') AND value NOT LIKE '$2%';
--   -- expect 0
--
-- 2. Idempotency — re-run STATEMENT 3:
--   -- expect 0 rows changed (no double-hash)
--
-- 3. Function ACLs:
--   SELECT proname, array_to_string(proacl, ' ')
--     FROM pg_proc WHERE proname IN ('set_location_pin','match_location_pin');
--   -- set_location_pin: authenticated=X present, no anon / PUBLIC entry
--   -- match_location_pin: unchanged — authenticated=X present, no anon / PUBLIC
--
-- 4. match_location_pin search_path widened:
--   SELECT proname, proconfig FROM pg_proc WHERE proname = 'match_location_pin';
--   -- proconfig shows search_path=public, extensions
--
-- 5. OWNER MUST VERIFY (needs the real PIN values — the builder never
--    reads or handles them):
--     * the branch admin PIN logs in and gives the admin role
--     * the branch cashier PIN logs in and gives the cashier role
--     * a wrong PIN fails
--     * 10 wrong PINs within 60s, THEN a correct one, still locks out
--       (assert this explicitly — the migration-110 throttle surviving
--       the STATEMENT 4 rewrite is the regression this is most likely
--       to cause)
--
-- 6. OWNER MUST VERIFY: set a new PIN via the settings page, log in
--    with it; then Save settings with both PIN fields left blank and
--    confirm the existing PIN still works (blank field => no write).
--
-- 7. npm run build passes.
-- ============================================================
