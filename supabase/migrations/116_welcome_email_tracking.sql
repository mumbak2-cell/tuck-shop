-- ============================================================
-- Migration 116: Welcome email tracking
--
-- Tracks whether the signup welcome email has been sent for an org, so a
-- retried /api/onboarding/welcome call (e.g. the signup page's fetch
-- failing and the user reloading) doesn't resend it. Mirrors
-- trial_outreach_sent_at from migration 105.
-- ============================================================

BEGIN;

ALTER TABLE organizations
  ADD COLUMN welcome_email_sent_at TIMESTAMPTZ;

COMMIT;
