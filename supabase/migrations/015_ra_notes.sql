-- ============================================================
-- Migration 015: Revenue Assurance Notes
-- Allows users to comment on discrepancies found in RA reports.
-- ============================================================

CREATE TABLE IF NOT EXISTS ra_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID REFERENCES products(id) ON DELETE CASCADE,
  opening_session_id UUID NOT NULL,
  closing_session_id UUID NOT NULL,
  note TEXT NOT NULL,
  noted_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ra_notes_sessions ON ra_notes(opening_session_id, closing_session_id);
CREATE INDEX idx_ra_notes_product ON ra_notes(product_id);

ALTER TABLE ra_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all on ra_notes" ON ra_notes FOR ALL USING (true) WITH CHECK (true);
