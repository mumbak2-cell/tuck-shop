-- ============================================================
-- Phase 5 — New tables: expenses, settings, stock_receipts
-- Run in Supabase SQL Editor
-- ============================================================

-- 1. App settings (PINs, iKhokha link, etc.)
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Default PINs and iKhokha link
INSERT INTO app_settings (key, value) VALUES
  ('admin_pin', '1234'),
  ('cashier_pin', '0000'),
  ('ikhokha_link', ''),
  ('business_name', 'MK Tuck Shop'),
  ('business_phone', '');

-- 2. Expenses / outflows (including director withdrawals)
CREATE TABLE expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
  category TEXT NOT NULL CHECK (category IN (
    'Transport', 'Fuel', 'Rent', 'Electricity',
    'Consumables', 'Wages', 'Stock Purchases',
    'Director Withdrawal', 'Other'
  )),
  description TEXT,
  amount DECIMAL(10,2) NOT NULL,
  director_name TEXT,
  recorded_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_expenses_date ON expenses(expense_date);
CREATE INDEX idx_expenses_category ON expenses(category);

-- 3. Stock receipts (receiving deliveries)
CREATE TABLE stock_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_date DATE NOT NULL DEFAULT CURRENT_DATE,
  supplier TEXT,
  notes TEXT,
  total_cost DECIMAL(10,2) DEFAULT 0,
  recorded_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE stock_receipt_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id UUID REFERENCES stock_receipts(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id),
  ingredient_id UUID REFERENCES ingredients(id),
  quantity DECIMAL(10,2) NOT NULL,
  unit_cost DECIMAL(10,2) NOT NULL DEFAULT 0,
  line_total DECIMAL(10,2) GENERATED ALWAYS AS (quantity * unit_cost) STORED,
  CONSTRAINT item_has_target CHECK (product_id IS NOT NULL OR ingredient_id IS NOT NULL)
);

CREATE INDEX idx_stock_receipts_date ON stock_receipts(receipt_date);
CREATE INDEX idx_receipt_items_receipt ON stock_receipt_items(receipt_id);

-- 4. RPC: increment stock on receipt (products)
CREATE OR REPLACE FUNCTION add_product_stock(
  p_product_id UUID,
  p_quantity INT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE products
  SET opening_stock = opening_stock + p_quantity
  WHERE id = p_product_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product % not found', p_product_id;
  END IF;
END;
$$;

-- 5. RPC: increment stock on receipt (ingredients)
CREATE OR REPLACE FUNCTION add_ingredient_stock(
  p_ingredient_id UUID,
  p_quantity DECIMAL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE ingredients
  SET current_stock = current_stock + p_quantity
  WHERE id = p_ingredient_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ingredient % not found', p_ingredient_id;
  END IF;
END;
$$;

-- 6. Add payment_reference to customer_payments for tracking iKhokha
ALTER TABLE customer_payments
  ADD COLUMN IF NOT EXISTS payment_reference TEXT;

-- 7. Add notes column to customer_payments
ALTER TABLE customer_payments
  ADD COLUMN IF NOT EXISTS notes TEXT;
