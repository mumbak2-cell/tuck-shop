-- ============================================================
-- Migration 070: Fix daily_reconciliation unique constraint
--
-- The original table had UNIQUE(recon_date) which worked for
-- single-tenant but breaks with multi-tenancy — different orgs
-- can have reconciliation on the same date.
--
-- Change to UNIQUE(org_id, recon_date).
-- ============================================================

-- Drop the old single-column unique constraint
ALTER TABLE daily_reconciliation DROP CONSTRAINT IF EXISTS daily_reconciliation_recon_date_key;

-- Add the new multi-tenant unique constraint
ALTER TABLE daily_reconciliation ADD CONSTRAINT daily_reconciliation_org_date_unique UNIQUE (org_id, recon_date);
