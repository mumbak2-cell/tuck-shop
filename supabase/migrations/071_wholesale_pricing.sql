-- ============================================================
-- Migration 071: Wholesale pricing
--
-- Adds wholesale mode per branch with percentage discount.
-- Products can be flagged wholesale-enabled with minimum qty.
-- Sales track is_wholesale per line item.
-- ============================================================

-- 1. Products: wholesale flag and minimum quantity
ALTER TABLE products ADD COLUMN IF NOT EXISTS wholesale_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS wholesale_min_qty INTEGER NOT NULL DEFAULT 1;

-- 2. Sales: per-line wholesale flag
ALTER TABLE sales ADD COLUMN IF NOT EXISTS is_wholesale BOOLEAN NOT NULL DEFAULT FALSE;

-- 3. Index for filtering wholesale products
CREATE INDEX IF NOT EXISTS idx_products_wholesale ON products(wholesale_enabled) WHERE wholesale_enabled = TRUE;
