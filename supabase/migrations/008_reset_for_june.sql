-- ============================================================
-- Reset transactional data for new month (June 2026)
-- Run in Supabase SQL Editor
--
-- KEEPS: products, ingredients, customers, app_settings
-- CLEARS: sales, stock counts, expenses, receipts, payments, reconciliation
-- RESETS: customer balances to 0, product stock to 0
-- ============================================================

-- 1. Clear sales
TRUNCATE TABLE sales;

-- 2. Clear stock counts
TRUNCATE TABLE stock_counts;

-- 3. Clear expenses
TRUNCATE TABLE expenses;

-- 4. Clear stock receipts (items cascade-deleted)
TRUNCATE TABLE stock_receipt_items;
TRUNCATE TABLE stock_receipts;

-- 5. Clear customer payments
TRUNCATE TABLE customer_payments;

-- 6. Clear daily reconciliation
TRUNCATE TABLE daily_reconciliation;

-- 7. Reset all customer balances to 0
UPDATE customers SET balance = 0;

-- 8. Reset all product stock to 0 (you'll upload June opening stock via CSV)
UPDATE products SET opening_stock = 0;

-- 9. Reset all ingredient stock to 0
UPDATE ingredients SET current_stock = 0;
