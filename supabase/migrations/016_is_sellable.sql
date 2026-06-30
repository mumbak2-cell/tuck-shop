-- ============================================================
-- Migration 016: Add is_sellable flag to products
-- Ingredients and non-revenue items are tracked for stock
-- but excluded from Revenue Assurance calculations.
-- ============================================================

ALTER TABLE products ADD COLUMN IF NOT EXISTS is_sellable BOOLEAN DEFAULT TRUE;

-- Auto-mark existing Ingredients category as non-sellable
UPDATE products SET is_sellable = FALSE WHERE category = 'Ingredients';
