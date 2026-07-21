-- ============================================================
-- Migration 049: Per-org inventory-ID zero padding
--
-- generate_inventory_id() hard-coded LPAD(n, 4, '0'), so every shop got
-- IN0001-style ids. Chichi's Bakes imported its catalogue with 5-digit ids
-- (IN01336), so its next generated id would have been IN1337 — correct and
-- collision-free, but visually inconsistent with its 1336 existing products.
--
-- Padding is now a per-org setting, mirroring the existing
-- 'inventory_id_prefix' key:
--
--   app_settings key 'inventory_id_padding'  (default 4, clamped to 1..9)
--
-- Also fixes a latent truncation bug: LPAD('12345', 4, '0') returns '1234',
-- so once an org passed 9999 items the generated id was silently truncated and
-- could collide. The width is now never less than the number's own length.
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
  pad_text TEXT;
  pad_n INT;
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

  -- Zero-padding width. Defaults to 4; ignore anything non-numeric or absurd.
  SELECT value INTO pad_text
  FROM app_settings
  WHERE org_id = p_org_id AND key = 'inventory_id_padding';

  IF pad_text ~ '^[0-9]+$' THEN
    pad_n := LEAST(GREATEST(pad_text::int, 1), 9);
  ELSE
    pad_n := 4;
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

  -- Belt and braces: skip any candidate that is still taken. GREATEST(...)
  -- keeps LPAD from truncating once the number outgrows the padding width.
  LOOP
    candidate := prefix || LPAD(next_n::text,
                                GREATEST(pad_n, length(next_n::text)), '0');
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
-- Set the padding for orgs whose existing ids are wider than the default, so
-- newly generated ids keep matching the catalogue they already have. Derived
-- from the data rather than hard-coding an org id.
-- ------------------------------------------------------------
INSERT INTO app_settings (org_id, key, value)
SELECT p.org_id, 'inventory_id_padding', p.width::text
FROM (
  SELECT org_id,
         MAX(length(regexp_replace(inventory_id, '[^0-9]', '', 'g'))) AS width
  FROM products
  WHERE inventory_id ~ '^[A-Za-z]*[0-9]{1,9}$'
  GROUP BY org_id
) p
WHERE p.width > 4
ON CONFLICT (org_id, key) DO UPDATE
  SET value = EXCLUDED.value, updated_at = NOW();

COMMIT;
