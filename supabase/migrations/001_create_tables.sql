-- ============================================================
-- MK Tuck Shop — Database Schema
-- Run this in Supabase SQL Editor (or via CLI migration)
-- ============================================================

-- 1. Products (pre-packaged and prepared)
CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  package_price DECIMAL(10,2),
  qty_in_pack INTEGER,
  cost_per_unit DECIMAL(10,2) GENERATED ALWAYS AS (
    CASE WHEN qty_in_pack > 0 THEN package_price / qty_in_pack ELSE NULL END
  ) STORED,
  selling_price DECIMAL(10,2) NOT NULL,
  is_prepared BOOLEAN DEFAULT FALSE,
  opening_stock INTEGER DEFAULT 0,
  reorder_level INTEGER DEFAULT 0,
  discontinued BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Ingredients (raw materials for prepared items)
CREATE TABLE ingredients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  purchase_size TEXT,
  purchase_price DECIMAL(10,2) NOT NULL,
  current_stock DECIMAL(10,2) DEFAULT 0,
  reorder_level DECIMAL(10,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Recipes (Bill of Materials)
CREATE TABLE recipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID REFERENCES products(id) ON DELETE CASCADE,
  ingredient_id UUID REFERENCES ingredients(id) ON DELETE RESTRICT,
  quantity_per_batch DECIMAL(10,4) NOT NULL,
  unit TEXT NOT NULL,
  UNIQUE(product_id, ingredient_id)
);

-- 4. Customers (credit accounts)
CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  phone TEXT,
  credit_limit DECIMAL(10,2) DEFAULT 0,
  balance DECIMAL(10,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Sales transactions
CREATE TABLE sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_date DATE NOT NULL DEFAULT CURRENT_DATE,
  product_id UUID REFERENCES products(id),
  quantity INTEGER NOT NULL,
  unit_price DECIMAL(10,2) NOT NULL,
  total_amount DECIMAL(10,2) NOT NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'card', 'credit')),
  customer_id UUID REFERENCES customers(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Daily stock counts
CREATE TABLE stock_counts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  count_date DATE NOT NULL,
  product_id UUID REFERENCES products(id),
  opening_units INTEGER DEFAULT 0,
  closing_units INTEGER DEFAULT 0,
  replenished_units INTEGER DEFAULT 0,
  units_sold_calc INTEGER GENERATED ALWAYS AS (
    opening_units + replenished_units - closing_units
  ) STORED,
  UNIQUE(count_date, product_id)
);

-- 7. Production log (prepared items)
CREATE TABLE production_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  production_date DATE NOT NULL DEFAULT CURRENT_DATE,
  product_id UUID REFERENCES products(id),
  batches_made INTEGER NOT NULL,
  units_produced INTEGER NOT NULL,
  batch_cost DECIMAL(10,2),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. Customer payments
CREATE TABLE customer_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  amount DECIMAL(10,2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 9. Daily cash reconciliation
CREATE TABLE daily_reconciliation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recon_date DATE UNIQUE NOT NULL,
  opening_float DECIMAL(10,2),
  cash_sales DECIMAL(10,2),
  card_sales DECIMAL(10,2),
  credit_sales DECIMAL(10,2),
  expected_cash DECIMAL(10,2),
  actual_cash DECIMAL(10,2),
  variance DECIMAL(10,2),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 10. Purchases (ingredient/product restocking)
CREATE TABLE purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_date DATE NOT NULL DEFAULT CURRENT_DATE,
  ingredient_id UUID REFERENCES ingredients(id),
  product_id UUID REFERENCES products(id),
  quantity INTEGER NOT NULL,
  unit_cost DECIMAL(10,2) NOT NULL,
  total_cost DECIMAL(10,2) NOT NULL,
  supplier TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Indexes for performance
-- ============================================================
CREATE INDEX idx_sales_date ON sales(sale_date);
CREATE INDEX idx_sales_product ON sales(product_id);
CREATE INDEX idx_sales_payment ON sales(payment_method);
CREATE INDEX idx_stock_counts_date ON stock_counts(count_date);
CREATE INDEX idx_production_date ON production_log(production_date);
CREATE INDEX idx_purchases_date ON purchases(purchase_date);
CREATE INDEX idx_products_category ON products(category);
CREATE INDEX idx_products_inventory_id ON products(inventory_id);
