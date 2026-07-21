-- ============================================================
-- Migration 048: Make inventory-ID generation collision-proof
--
-- Bug: adding a product failed with
--   duplicate key value violates unique constraint "products_org_inventory_id_unique"
--
-- generate_inventory_id() (migration 019) trusted app_settings
-- 'next_inventory_number' as the sole source of the next number. Bulk imports
-- (StockPilot / CSV) write an explicit inventory_id, which skips the BEFORE
-- INSERT trigger entirely and so never advances that counter. Every org that
-- imported its catalogue was left with counter = 1 while products already
-- occupied IN0001..INV093 (Destiny) and up to 1336 (Chichi's Bakes) — so the
-- next generated id collided with an existing row and the insert was rejected.
--
-- Fix, in two parts:
--   1. The generator now never hands out a number at or below the highest
--      already in use for that org, and additionally skips any candidate that
--      is somehow still taken. It is therefore self-healing: a stale counter
--      can no longer produce a collision.
--   2. One-time repair of the existing counters so they reflect reality.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION generate_inventory_id(p_org_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  prefix TEXT;
  next_n INT;
  max_existing INT;
  candidate TEXT;
BEGIN
  -- Lock the counter row to prevent races between concurrent inserts.
  SELECT value::int INTO next_n
  FROM app_settings
  WHERE org_id = p_org_id AND key = 'next_inventory_number'
  FOR UPDATE;

  IF next_n IS NULL THEN
    next_n := 1;
  END IF;

  SELECT value INTO prefix
  FROM app_settings
  WHERE org_id = p_org_id AND key = 'inventory_id_prefix';

  IF prefix IS NULL OR prefix = '' THEN
    prefix := 'ITEM';
  END IF;

  -- Never reuse a number at or below the highest already in use. Only ids
  -- shaped like <letters><digits> are considered, so an odd id can't overflow
  -- the int cast; anything unusual is still caught by the loop below.
  SELECT COALESCE(MAX(
           CASE WHEN inventory_id ~ '^[A-Za-z]*[0-9]{1,9}$'
                THEN regexp_replace(inventory_id, '[^0-9]', '', 'g')::int
           END), 0)
    INTO max_existing
  FROM products
  WHERE org_id = p_org_id;

  IF next_n <= max_existing THEN
    next_n := max_existing + 1;
  END IF;

  -- Belt and braces: skip any candidate that is still taken (e.g. an imported
  -- id that doesn't match the pattern above, or a changed prefix).
  LOOP
    candidate := prefix || LPAD(next_n::text, 4, '0');
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM products
      WHERE org_id = p_org_id AND inventory_id = candidate
    );
    next_n := next_n + 1;
  END LOOP;

  INSERT INTO app_settings (org_id, key, value)
  VALUES (p_org_id, 'next_inventory_number', (next_n + 1)::text)
  ON CONFLICT (org_id, key) DO UPDATE SET value = (next_n + 1)::text;

  RETURN candidate;
END;
$$;

-- ------------------------------------------------------------
-- One-time repair: bring every org's counter up past its highest existing id.
-- (The generator above no longer depends on this being right, but leaving
-- stale counters would keep handing out numbers from 1 and walking the loop.)
-- ------------------------------------------------------------
INSERT INTO app_settings (org_id, key, value)
SELECT p.org_id, 'next_inventory_number', (p.max_num + 1)::text
FROM (
  SELECT org_id,
         COALESCE(MAX(
           CASE WHEN inventory_id ~ '^[A-Za-z]*[0-9]{1,9}$'
                THEN regexp_replace(inventory_id, '[^0-9]', '', 'g')::int
           END), 0) AS max_num
  FROM products
  GROUP BY org_id
) p
ON CONFLICT (org_id, key) DO UPDATE
  SET value = GREATEST(app_settings.value::int, EXCLUDED.value::int)::text,
      updated_at = NOW();

COMMIT;
