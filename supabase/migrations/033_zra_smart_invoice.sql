-- 033: ZRA Smart Invoice / VSDC integration
--
-- Stores per-org VSDC configuration and logs every invoice submission
-- so we have an audit trail and can retry failures.

-- 1. VSDC configuration per org
CREATE TABLE IF NOT EXISTS zra_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- VSDC connection
  vsdc_url TEXT NOT NULL,                    -- e.g. http://192.168.1.100:8080/zravsdc
  -- ZRA credentials (provided during registration)
  tpin TEXT NOT NULL,                        -- 10-digit Taxpayer ID
  bhf_id TEXT NOT NULL DEFAULT '000',        -- Branch ID (000 = head office)
  device_serial TEXT NOT NULL,               -- Device serial number from ZRA
  -- Security keys returned by initDevice (stored after first init)
  security_key TEXT,
  -- Tax defaults
  default_tax_cd TEXT NOT NULL DEFAULT 'B',  -- B = Standard 16%, A = Exempt, etc.
  default_tax_rate NUMERIC(5,2) NOT NULL DEFAULT 16.00,
  -- State
  initialized BOOLEAN NOT NULL DEFAULT FALSE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,    -- master switch
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id)
);

ALTER TABLE zra_config ENABLE ROW LEVEL SECURITY;

-- Only org owners/admins can read/write ZRA config
CREATE POLICY "zra_config_read" ON zra_config FOR SELECT
  USING (org_id = default_user_org_id());
CREATE POLICY "zra_config_write" ON zra_config FOR ALL
  USING (org_id = default_user_org_id());

-- 2. Invoice submission log — every sale posted to VSDC
CREATE TABLE IF NOT EXISTS zra_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sale_id UUID,                              -- links back to sales table
  -- ZRA response
  rcpt_no TEXT,                              -- ZRA receipt number (printed on receipt)
  intrl_data TEXT,                           -- internal data from VSDC
  rcpt_sign TEXT,                            -- receipt signature
  vsdc_rcpt_pbct_date TEXT,                  -- VSDC receipt publish date
  -- Request snapshot
  request_payload JSONB,                     -- full request body sent to VSDC
  response_payload JSONB,                    -- full response from VSDC
  -- Status
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'submitted', 'failed', 'retrying')),
  error_code TEXT,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_zra_invoices_org ON zra_invoices(org_id);
CREATE INDEX idx_zra_invoices_sale ON zra_invoices(sale_id);
CREATE INDEX idx_zra_invoices_status ON zra_invoices(status);
CREATE INDEX idx_zra_invoices_rcpt ON zra_invoices(rcpt_no);

ALTER TABLE zra_invoices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "zra_invoices_read" ON zra_invoices FOR SELECT
  USING (org_id = default_user_org_id());
CREATE POLICY "zra_invoices_write" ON zra_invoices FOR ALL
  USING (org_id = default_user_org_id());

COMMENT ON TABLE zra_config IS 'Per-org VSDC configuration for ZRA Smart Invoice integration';
COMMENT ON TABLE zra_invoices IS 'Audit log of every invoice submitted to ZRA via VSDC';
COMMENT ON COLUMN zra_invoices.rcpt_no IS 'ZRA receipt number — MUST be printed on every receipt';
