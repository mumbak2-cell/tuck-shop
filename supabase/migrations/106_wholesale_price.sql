-- Fixed wholesale price per product, used as the default discount when a
-- cashier ticks "Wholesale" at the till (still editable per sale in POS).
ALTER TABLE products ADD COLUMN IF NOT EXISTS wholesale_price NUMERIC(10,2);
