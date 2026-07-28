-- 068: Snapshot cost_price on stock adjustments so shrinkage can be valued on P&L.
--
-- Pre-068 rows keep NULL — that cost is unrecoverable, so the P&L notes how many
-- adjustments lack a cost rather than guessing.

ALTER TABLE stock_adjustments
  ADD COLUMN IF NOT EXISTS cost_price NUMERIC(12,2);
