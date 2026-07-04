-- 032: Add TPIN and VAT fields to organizations
-- Supports per-org tax identification and VAT-inclusive pricing display on receipts.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS tpin TEXT,
  ADD COLUMN IF NOT EXISTS vat_percent NUMERIC(5,2);

COMMENT ON COLUMN organizations.tpin IS 'Tax Payer Identification Number (TPIN) displayed on receipts';
COMMENT ON COLUMN organizations.vat_percent IS 'VAT rate (e.g. 16 for 16%). When set, receipts back-calculate VAT from inclusive prices.';
