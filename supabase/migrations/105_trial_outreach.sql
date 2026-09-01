-- ============================================================
-- Migration 105: Trial-ending outreach tracking
--
-- Tracks whether the "trial ends in ~1 day" feedback/Facebook-rating/
-- partner-program email has been sent for an org, so the daily cron
-- job (api/cron/trial-outreach) doesn't resend on every run.
-- ============================================================

BEGIN;

ALTER TABLE organizations
  ADD COLUMN trial_outreach_sent_at TIMESTAMPTZ;

COMMIT;
