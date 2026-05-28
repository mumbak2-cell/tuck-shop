-- ============================================================
-- Migration 005: Unique constraint on stock_counts for upsert
-- Ensures one count per product per day, and enables
-- the ON CONFLICT clause in the stock count page.
-- ============================================================

ALTER TABLE stock_counts
  ADD CONSTRAINT stock_counts_date_product_unique
  UNIQUE (count_date, product_id);
