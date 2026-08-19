-- Migration 081: Add default_supplier to products
-- Stores the supplier name (not FK) for reorder list grouping.
-- Matches the pattern used by stock_receipts.supplier and purchases.supplier.

ALTER TABLE products ADD COLUMN IF NOT EXISTS default_supplier TEXT;
