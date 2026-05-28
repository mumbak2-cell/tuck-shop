-- ============================================================
-- Phase 5 RLS — Allow full access for single-user app
-- Run in Supabase SQL Editor
-- ============================================================

-- Enable RLS on Phase 5 tables
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_receipt_items ENABLE ROW LEVEL SECURITY;

-- Allow full access via anon key (single-user system)
CREATE POLICY "Allow all on app_settings" ON app_settings FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on expenses" ON expenses FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on stock_receipts" ON stock_receipts FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on stock_receipt_items" ON stock_receipt_items FOR ALL USING (true) WITH CHECK (true);
