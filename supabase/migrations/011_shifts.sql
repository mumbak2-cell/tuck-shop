-- ============================================================
-- Shift management
-- Run in Supabase SQL Editor
-- ============================================================

CREATE TABLE shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_date DATE NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  opened_by TEXT NOT NULL,
  opening_float DECIMAL(10,2) DEFAULT 0,
  closed_at TIMESTAMPTZ,
  closed_by TEXT,
  closing_cash DECIMAL(10,2),
  stock_count_done BOOLEAN DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_shifts_date ON shifts(shift_date);
CREATE INDEX idx_shifts_status ON shifts(status);

ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all on shifts" ON shifts FOR ALL USING (true) WITH CHECK (true);
