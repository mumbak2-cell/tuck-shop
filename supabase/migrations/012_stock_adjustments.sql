-- ============================================================
-- Stock adjustments — breakage, expired, theft, corrections
-- Run in Supabase SQL Editor
-- ============================================================

CREATE TABLE stock_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  adjustment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  product_id UUID REFERENCES products(id),
  reason TEXT NOT NULL CHECK (reason IN (
    'Breakage', 'Expired', 'Theft', 'Damaged', 'Samples', 'Correction', 'Other'
  )),
  quantity INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('decrease', 'increase')),
  notes TEXT,
  adjusted_by TEXT,
  stock_before INTEGER,
  stock_after INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_stock_adj_date ON stock_adjustments(adjustment_date);
CREATE INDEX idx_stock_adj_product ON stock_adjustments(product_id);

ALTER TABLE stock_adjustments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all on stock_adjustments" ON stock_adjustments FOR ALL USING (true) WITH CHECK (true);
