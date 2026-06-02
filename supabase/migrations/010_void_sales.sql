-- ============================================================
-- Add void capability to sales
-- Run in Supabase SQL Editor
-- ============================================================

-- 1. Add voided columns to sales
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS voided BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by TEXT,
  ADD COLUMN IF NOT EXISTS void_reason TEXT;

CREATE INDEX idx_sales_voided ON sales(voided);
