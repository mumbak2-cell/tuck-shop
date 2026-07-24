-- ============================================================
-- Migration 058: Record stock shortfalls instead of discarding them
--
-- deduct_stock_at_location floors the new quantity at zero:
--
--     SET quantity = GREATEST(quantity - p_quantity, 0)
--
-- so selling 10 units against 6 on hand left stock at 0 and destroyed every
-- trace of the 4-unit shortfall. The POS warns on this but deliberately does
-- not block it (see components/pos/cart.tsx), so it happens in normal trade.
--
-- The loss was unrecoverable after the fact: once the quantity is 0 there is
-- no way to tell "landed exactly on zero" from "went four under". Revenue
-- Assurance could only infer it from stock counts, which nets multiple events
-- together between counts and attributes nothing to a moment or a cashier.
-- Hence capture at the point of the write.
--
-- The clamp itself is KEPT. Letting quantity go negative would break the
-- "stock >= 0" assumption the POS, reporting and reorder logic all rely on.
-- The change is that the shortfall is now recorded before being clamped away.
--
-- Idempotent throughout: 057 taught us the SQL Editor runs a script as a
-- single transaction, so any failure rolls the whole thing back and it must
-- be safe to replay from the top.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. The record
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_oversells (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id  UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  -- A write-off can also exceed stock on hand, and means something different
  -- from a till oversell. Recording both under one label would misreport
  -- breakage as a sale, so the origin is stored explicitly.
  source      TEXT NOT NULL DEFAULT 'sale' CHECK (source IN ('sale', 'adjustment')),
  requested   INTEGER NOT NULL,
  available   INTEGER NOT NULL,
  shortfall   INTEGER NOT NULL CHECK (shortfall > 0),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stock_oversells_org ON stock_oversells(org_id);
CREATE INDEX IF NOT EXISTS idx_stock_oversells_product ON stock_oversells(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_oversells_occurred ON stock_oversells(occurred_at);

ALTER TABLE stock_oversells ENABLE ROW LEVEL SECURITY;

-- Read mirrors product_stock: your org, and only locations you can see.
DROP POLICY IF EXISTS "stock_oversells_read" ON stock_oversells;
CREATE POLICY "stock_oversells_read" ON stock_oversells
  FOR SELECT USING (
    org_id IN (SELECT current_user_org_ids())
    AND location_id IN (SELECT current_user_location_ids())
  );

-- No INSERT/UPDATE/DELETE policy, deliberately. Rows originate only from
-- deduct_stock_at_location, which is SECURITY DEFINER and so bypasses RLS.
-- With no write policy the client can neither fabricate an oversell nor
-- delete one that embarrasses it — the point of an assurance record.

-- ------------------------------------------------------------
-- 2. Capture the shortfall in the deduction path
--
--    A 4th argument is added, so the 3-arg signature has to go first: with
--    both present a 3-argument call is ambiguous and errors.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS deduct_stock_at_location(UUID, INTEGER, UUID);
DROP FUNCTION IF EXISTS deduct_stock_at_location(UUID, INTEGER, UUID, TEXT);

CREATE FUNCTION deduct_stock_at_location(
  p_product_id  UUID,
  p_quantity    INTEGER,
  p_location_id UUID,
  p_source      TEXT DEFAULT 'sale'
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id    UUID;
  v_available INTEGER;
BEGIN
  SELECT org_id INTO v_org_id FROM products WHERE id = p_product_id;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Product % not found', p_product_id USING ERRCODE = '42501';
  END IF;
  PERFORM assert_org_writable(v_org_id);

  IF NOT EXISTS (
    SELECT 1 FROM locations WHERE id = p_location_id AND org_id = v_org_id
  ) THEN
    RAISE EXCEPTION 'Location does not belong to this organisation'
      USING ERRCODE = '42501';
  END IF;

  -- Ensure a row exists so we can decrement it
  INSERT INTO product_stock (product_id, location_id, quantity, org_id)
  VALUES (p_product_id, p_location_id, 0, v_org_id)
  ON CONFLICT (product_id, location_id) DO NOTHING;

  -- Locked for the rest of the transaction: two concurrent tills reading the
  -- same quantity would otherwise each decide independently whether they went
  -- short, and both could miss it. The row is guaranteed to exist by the
  -- upsert above.
  SELECT quantity INTO v_available
    FROM product_stock
   WHERE product_id = p_product_id AND location_id = p_location_id
   FOR UPDATE;

  IF p_quantity > v_available THEN
    INSERT INTO stock_oversells (
      org_id, product_id, location_id, source, requested, available, shortfall
    ) VALUES (
      v_org_id, p_product_id, p_location_id, p_source,
      p_quantity, v_available, p_quantity - v_available
    );
  END IF;

  UPDATE product_stock
     SET quantity = GREATEST(quantity - p_quantity, 0),
         last_updated = NOW()
   WHERE product_id = p_product_id AND location_id = p_location_id;
END;
$$;

-- ------------------------------------------------------------
-- 3. Restore 040's grant hardening for the NEW signature
--
--    040 revoked PUBLIC and granted `authenticated` on the 3-arg form. A
--    freshly created function is executable by PUBLIC by default, so without
--    this the drop above would silently undo that.
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION deduct_stock_at_location(UUID, INTEGER, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION deduct_stock_at_location(UUID, INTEGER, UUID, TEXT) TO authenticated;

COMMIT;

-- PostgREST caches the schema; without this the new table and the changed
-- signature are invisible until it happens to reload (see 057).
NOTIFY pgrst, 'reload schema';
