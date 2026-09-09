-- ============================================================
-- purge-dead-trials.sql  —  one-off, run by hand in the Supabase SQL Editor
--
-- Removes organizations that SIGNED UP BUT NEVER SOLD and whose trial has
-- lapsed, keeping any org that ever entered billing. Hard delete: the org
-- row + every ON DELETE CASCADE child + the orphaned auth login.
--
-- Criteria (agreed 2026-09-09):
--   * zero rows in `sales` for the org, ever
--   * subscription_status = 'trialing' with trial_ends_at in the past,
--     OR subscription_status IN ('past_due','cancelled')
--   * NEVER billed — no billing_customer_id / billing_subscription_id /
--     current_period_end, and no invoice_events row
--   * 'active' orgs are excluded by the status filter
--
-- RUN ONLY DURING CLOSED HOURS (no tills trading) and AFTER confirming a
-- Supabase PITR restore point / manual backup. Hard delete is reversible
-- only from backup.
--
-- FK notes:
--   * ~40 org-scoped tables FK org_id ON DELETE CASCADE — cleared by the
--     organizations delete itself (incl. org_members).
--   * period_locks.org_id is ON DELETE NO ACTION — must be cleared first
--     (normally 0 rows for a never-sold org).
--   * invoice_events.org_id is ON DELETE SET NULL — payment forensics are
--     kept (org_id nulled), deliberately not deleted.
--
-- HOW TO RUN — paste and run each STATEMENT block below separately, in
-- order. Do NOT paste the whole file at once and do NOT wrap it in a
-- BEGIN/COMMIT: the Supabase SQL Editor may spread a multi-statement paste
-- across connections, so temp tables / transaction scope from one statement
-- can be invisible to the next (this bit us on migration 096). Instead the
-- dead set is captured into two PLAIN, COMMITTED staging tables
-- (`_purge_dead_orgs`, `_purge_dead_users`) that every later statement
-- reads back from real storage. STATEMENT 6 drops them again.
-- Each DELETE is its own statement, hence its own transaction: run
-- STATEMENT 3 first, eyeball the counts, then run 4 → 5 → 6 → 7. If one
-- fails, the earlier committed steps stand and re-running the remaining
-- statements is safe (the staging tables still hold the list; a second
-- delete just matches 0 rows).
-- ============================================================


-- ---- STEP 1 : PREVIEW (read-only, safe to run any time) -----------------
-- Eyeball this list and its count before doing anything in Step 2.

SELECT o.id, o.name, o.slug, o.subscription_status,
       o.trial_ends_at, o.created_at,
       (SELECT count(*) FROM org_members m WHERE m.org_id = o.id) AS members
FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM sales s WHERE s.org_id = o.id)
  AND ( (o.subscription_status = 'trialing' AND o.trial_ends_at < now())
        OR o.subscription_status IN ('past_due','cancelled') )
  AND o.billing_customer_id     IS NULL
  AND o.billing_subscription_id IS NULL
  AND o.current_period_end      IS NULL
  AND NOT EXISTS (SELECT 1 FROM invoice_events e WHERE e.org_id = o.id)
ORDER BY o.created_at;


-- ---- STEP 2 : DELETE (closed hours, after backup) ----------------------
-- Run STATEMENT 1..7 one block at a time, in order.


-- STATEMENT 1 : capture the dead-org set into a committed staging table.
-- Re-runnable (drops any prior copy first).
DROP TABLE IF EXISTS _purge_dead_orgs;
CREATE TABLE _purge_dead_orgs AS
SELECT o.id
FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM sales s WHERE s.org_id = o.id)
  AND ( (o.subscription_status = 'trialing' AND o.trial_ends_at < now())
        OR o.subscription_status IN ('past_due','cancelled') )
  AND o.billing_customer_id     IS NULL
  AND o.billing_subscription_id IS NULL
  AND o.current_period_end      IS NULL
  AND NOT EXISTS (SELECT 1 FROM invoice_events e WHERE e.org_id = o.id);


-- STATEMENT 2 : capture the users who belong to those orgs, BEFORE the
-- org delete cascades org_members away. Re-runnable.
DROP TABLE IF EXISTS _purge_dead_users;
CREATE TABLE _purge_dead_users AS
SELECT DISTINCT m.user_id
FROM org_members m
WHERE m.org_id IN (SELECT id FROM _purge_dead_orgs);


-- STATEMENT 3 : PREVIEW the staged counts. Sanity-check these against
-- STEP 1's list before running STATEMENT 4 onward.
SELECT (SELECT count(*) FROM _purge_dead_orgs)  AS orgs_to_delete,
       (SELECT count(*) FROM _purge_dead_users) AS users_in_scope;


-- STATEMENT 4 : non-cascading FK (period_locks.org_id is NO ACTION) —
-- clear first. Normally 0 rows for a never-sold org.
DELETE FROM period_locks WHERE org_id IN (SELECT id FROM _purge_dead_orgs);


-- STATEMENT 5 : the org row — cascades every ON DELETE CASCADE child
-- (org_members included). This is the big one; it is a single atomic
-- statement, so it deletes all matched orgs and their subtrees or none.
DELETE FROM organizations WHERE id IN (SELECT id FROM _purge_dead_orgs);


-- STATEMENT 6 : orphaned auth logins. Runs AFTER STATEMENT 5 has
-- committed, so the dead orgs' org_members rows are already gone — any
-- membership still attached to the user means a surviving (live) org, so
-- keep that user. Also skip platform admins.
DELETE FROM auth.users u
WHERE u.id IN (SELECT user_id FROM _purge_dead_users)
  AND NOT EXISTS (SELECT 1 FROM org_members    m  WHERE m.user_id  = u.id)
  AND NOT EXISTS (SELECT 1 FROM platform_admins pa WHERE pa.user_id = u.id);


-- STATEMENT 7 : drop the staging tables.
DROP TABLE IF EXISTS _purge_dead_users;
DROP TABLE IF EXISTS _purge_dead_orgs;
