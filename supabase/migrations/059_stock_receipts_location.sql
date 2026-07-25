-- ============================================================
-- Migration 059: Attribute a stock receipt to the branch that received it
--
-- stock_receipts predates multi-location (it comes from 006, locations from
-- 0230) and has never recorded WHERE a delivery landed. Receive Stock already
-- puts the units in the right place -- step 3 of handleSave calls
-- add_product_stock_at_location(currentLocationId) -- but the receipt header
-- that documents the delivery says nothing about the branch.
--
-- That gap is not cosmetic. Revenue Assurance filters counts, sales and
-- oversells by location, but its replenishment query cannot, because there is
-- nothing to filter on:
--
--     from("stock_receipts").select("id").gte(...).lte(...)      -- org-wide
--
-- so every receipt is credited as replenishment in EVERY branch's view.
-- Expected stock at a branch that received nothing is inflated by the whole
-- delivery, and the shortfall renders as shrinkage that never happened. On
-- Chichi's Bakes, recording an opening count of 150 units x 1,329 SKUs at Town
-- Shop as a *receipt* would have shown ~199,000 units of phantom loss at
-- Garden Shop. That is the same class of false certification that migration
-- 058 and the both-directions fix were written to remove.
--
-- The column is NULLABLE and there is no backfill, deliberately. A receipt's
-- branch is not recoverable after the fact: the units are already merged into
-- product_stock. Of the 29 receipts in production at the time of writing, 28
-- were recorded while their org already had more than one location, so only
-- one could be inferred from dates -- not worth a bespoke rule.
--
--   NULL = "recorded before this migration; branch unknown"
--
-- The app reads NULL as org-wide, exactly as today, so historic Revenue
-- Assurance figures do not silently change. Only receipts recorded from here
-- on are attributed, and only those stop leaking across branches.
--
-- RLS is deliberately NOT changed. stock_receipts is org-scoped; making it
-- org+location-scoped like product_stock would hide a branch's deliveries from
-- an owner viewing another branch, which is a different decision from this one
-- and wants its own thought.
--
-- Idempotent throughout: the SQL Editor runs a script as a single transaction,
-- so any failure rolls the whole thing back and it must be safe to replay.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. The column
--
-- ON DELETE SET NULL, not CASCADE: deleting a branch must not delete the
-- record that goods were bought. The receipt reverts to "branch unknown",
-- which is what it was before this migration.
-- ------------------------------------------------------------
ALTER TABLE stock_receipts
  ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id) ON DELETE SET NULL;

-- Revenue Assurance filters by (receipt_date, location_id) on every load.
CREATE INDEX IF NOT EXISTS idx_stock_receipts_location
  ON stock_receipts(location_id);

COMMENT ON COLUMN stock_receipts.location_id IS
  'Branch that received this delivery. NULL means recorded before migration 059 '
  'and treated as org-wide by Revenue Assurance, so historic figures are unchanged.';

COMMIT;

-- ------------------------------------------------------------
-- Verification -- ONE result set, because the SQL Editor only displays the
-- output of the last statement and a multi-query check hides the earlier ones.
-- ------------------------------------------------------------
SELECT 'column: ' || column_name || ' (' || data_type || ', nullable=' || is_nullable || ')' AS check
FROM information_schema.columns
WHERE table_name = 'stock_receipts' AND column_name = 'location_id'
UNION ALL
SELECT 'index: ' || indexname
FROM pg_indexes
WHERE tablename = 'stock_receipts' AND indexname = 'idx_stock_receipts_location'
UNION ALL
SELECT 'receipts with a branch: ' || COUNT(*)::text FROM stock_receipts WHERE location_id IS NOT NULL
UNION ALL
SELECT 'receipts still unattributed (expected: all of them): ' || COUNT(*)::text
FROM stock_receipts WHERE location_id IS NULL;
