-- 047: ZRA fiscal receipt fields
--
-- The compliant ZRA Smart Invoice receipt prints an SDC ID (e.g. SDC0030002973)
-- and, for some device types, an MRC number. The VSDC returns both on saveSales
-- (SaveSalesResult.sdcId / mrcNo) but migration 033 had nowhere to store them, so
-- we could not print the SDC ID that every fiscal receipt requires. Add the
-- columns to the invoice log so the receipt can render the full fiscal block.

ALTER TABLE zra_invoices
  ADD COLUMN IF NOT EXISTS sdc_id TEXT,
  ADD COLUMN IF NOT EXISTS mrc_no TEXT;

COMMENT ON COLUMN zra_invoices.sdc_id IS 'VSDC SDC ID (printed on the fiscal receipt, e.g. SDC0030002973)';
COMMENT ON COLUMN zra_invoices.mrc_no IS 'VSDC MRC number returned by saveSales, when present';
