-- ============================================================
-- Add audit trail to stock_counts
-- Run in Supabase SQL Editor
-- ============================================================

-- 1. Add audit columns to stock_counts
ALTER TABLE stock_counts
  ADD COLUMN IF NOT EXISTS counted_by TEXT,
  ADD COLUMN IF NOT EXISTS counted_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS update_count INTEGER DEFAULT 1;

-- 2. Create an audit log table that tracks every edit
CREATE TABLE IF NOT EXISTS stock_count_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_count_id UUID REFERENCES stock_counts(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id),
  count_date DATE NOT NULL,
  closing_units_old INTEGER,
  closing_units_new INTEGER,
  changed_by TEXT,
  changed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_stock_count_audit_date ON stock_count_audit(count_date);
CREATE INDEX idx_stock_count_audit_product ON stock_count_audit(product_id);

-- 3. RLS for audit table
ALTER TABLE stock_count_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all on stock_count_audit" ON stock_count_audit FOR ALL USING (true) WITH CHECK (true);
