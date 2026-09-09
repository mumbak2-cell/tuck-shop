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
-- ============================================================


-- ---- STEP 1 : PREVIEW (read-only, safe to run any time) -----------------
-- Eyeball this list and its count before running Step 2.

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
-- Run as one block. Check the three DELETE row counts look sane, then
-- COMMIT. Anything unexpected -> ROLLBACK.

BEGIN;

CREATE TEMP TABLE dead_orgs AS
SELECT o.id
FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM sales s WHERE s.org_id = o.id)
  AND ( (o.subscription_status = 'trialing' AND o.trial_ends_at < now())
        OR o.subscription_status IN ('past_due','cancelled') )
  AND o.billing_customer_id     IS NULL
  AND o.billing_subscription_id IS NULL
  AND o.current_period_end      IS NULL
  AND NOT EXISTS (SELECT 1 FROM invoice_events e WHERE e.org_id = o.id);

CREATE TEMP TABLE dead_users AS
SELECT DISTINCT m.user_id
FROM org_members m
WHERE m.org_id IN (SELECT id FROM dead_orgs);

SELECT (SELECT count(*) FROM dead_orgs)  AS orgs_to_delete,
       (SELECT count(*) FROM dead_users) AS users_in_scope;

-- 1. non-cascading FK — clear first
DELETE FROM period_locks WHERE org_id IN (SELECT id FROM dead_orgs);

-- 2. the org row — cascades every ON DELETE CASCADE child
DELETE FROM organizations WHERE id IN (SELECT id FROM dead_orgs);

-- 3. orphaned auth logins — only if the user has no other org and is not a platform admin
DELETE FROM auth.users u
WHERE u.id IN (SELECT user_id FROM dead_users)
  AND NOT EXISTS (SELECT 1 FROM org_members    m  WHERE m.user_id  = u.id)
  AND NOT EXISTS (SELECT 1 FROM platform_admins pa WHERE pa.user_id = u.id);

-- COMMIT;
-- ROLLBACK;
