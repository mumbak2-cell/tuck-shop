-- ============================================================
-- Migration 121: Stock-take variance flags (v1)
--
-- Adds an immutable "expected on hand" snapshot and a per-line flag to
-- stock_counts, stamped by a BEFORE INSERT trigger from product_stock.
-- Detective control only: nothing here blocks a confirm. See
-- docs/superpowers/specs/2026-09-10-stock-take-variance-flags-design.md
--
-- Apply: Supabase SQL Editor, outside trading hours. Then:
--   node node_modules/supabase/dist/supabase.js migration repair --status applied 121
-- Idempotent, safe to re-run.
-- ============================================================

BEGIN;

-- ---- Part 1: columns --------------------------------------------------
ALTER TABLE public.stock_counts
  ADD COLUMN IF NOT EXISTS expected_units INTEGER,
  ADD COLUMN IF NOT EXISTS flag_kind      TEXT,
  ADD COLUMN IF NOT EXISTS review_note    TEXT;

ALTER TABLE public.stock_count_audit
  ADD COLUMN IF NOT EXISTS expected_units_old INTEGER,
  ADD COLUMN IF NOT EXISTS expected_units_new INTEGER;

-- ---- Part 2: flag thresholds (tune here) ----------------------------
--   near_empty   : expected <= 2 AND variance >= 3        (always flags, price-independent)
--   value        : abs(variance) * selling_price >= 100
--   unit_ceiling : abs(variance) >= 15
--   pattern      : same product+location, same-direction variance across the
--                  last 2 confirmed sessions + this one
--   session_spread : set by the app (needs session aggregates), not here
-- Priority: near_empty > value > unit_ceiling > pattern. First match wins.

-- ---- Part 3: trigger function -------------------------------------
CREATE OR REPLACE FUNCTION public.stamp_stock_count_expected()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expected   INTEGER;
  v_variance   INTEGER;
  v_price      NUMERIC;
  v_prepared   BOOLEAN;
  v_prev_dirs  INTEGER;   -- count of prior confirmed sessions with same-sign variance
BEGIN
  IF NEW.closing_units IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(ps.quantity, 0)
    INTO v_expected
    FROM (SELECT 1) _
    LEFT JOIN public.product_stock ps
      ON ps.product_id = NEW.product_id
     AND ps.location_id = NEW.location_id;
  v_expected := COALESCE(v_expected, 0);

  NEW.expected_units := v_expected;
  v_variance := NEW.closing_units - v_expected;

  SELECT p.selling_price, p.is_prepared
    INTO v_price, v_prepared
    FROM public.products p
   WHERE p.id = NEW.product_id;

  -- Prepared-food items legitimately run +variance every count until a
  -- production_log -> product_stock credit flow exists. No flag.
  IF COALESCE(v_prepared, false) THEN
    NEW.flag_kind := NULL;
    RETURN NEW;
  END IF;

  IF v_expected <= 2 AND v_variance >= 3 THEN
    NEW.flag_kind := 'near_empty';
  ELSIF abs(v_variance) * COALESCE(v_price, 0) >= 100 THEN
    NEW.flag_kind := 'value';
  ELSIF abs(v_variance) >= 15 THEN
    NEW.flag_kind := 'unit_ceiling';
  ELSE
    -- pattern: last 2 CONFIRMED sessions for this product+location with a
    -- variance in the same direction as this one.
    IF v_variance <> 0 THEN
      SELECT count(*)
        INTO v_prev_dirs
        FROM (
          SELECT sc.closing_units - sc.expected_units AS prev_var
            FROM public.stock_counts sc
           WHERE sc.product_id = NEW.product_id
             AND sc.location_id = NEW.location_id
             AND sc.confirmed_at IS NOT NULL
             AND sc.expected_units IS NOT NULL
             AND sc.closing_units IS NOT NULL
           ORDER BY sc.confirmed_at DESC
           LIMIT 2
        ) recent
       WHERE sign(recent.prev_var) = sign(v_variance)
         AND recent.prev_var <> 0;

      IF v_prev_dirs = 2 THEN
        NEW.flag_kind := 'pattern';
      ELSE
        NEW.flag_kind := NULL;
      END IF;
    ELSE
      NEW.flag_kind := NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.stamp_stock_count_expected() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stamp_stock_count_expected() TO authenticated;

-- ---- Part 4: trigger (INSERT only — never re-stamp on edit/confirm) --
DROP TRIGGER IF EXISTS trg_stamp_stock_count_expected ON public.stock_counts;
CREATE TRIGGER trg_stamp_stock_count_expected
  BEFORE INSERT ON public.stock_counts
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_stock_count_expected();

-- ---- Part 5: backfill open (unconfirmed) sessions ------------------
-- Only rows still pending review — older confirmed rows stay NULL and
-- simply carry no badge. Uses the same COALESCE(...,0) rule; does NOT
-- compute flag_kind for backfilled rows (no trigger fires on UPDATE),
-- which is acceptable: the owner reviews these once with variance visible.
UPDATE public.stock_counts sc
   SET expected_units = COALESCE(
         (SELECT ps.quantity FROM public.product_stock ps
           WHERE ps.product_id = sc.product_id
             AND ps.location_id = sc.location_id), 0)
 WHERE sc.confirmed_at IS NULL
   AND sc.closing_units IS NOT NULL
   AND sc.expected_units IS NULL;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- Verification (run manually in the SQL Editor after applying):
--
-- 1. columns exist:
--    SELECT column_name FROM information_schema.columns
--     WHERE table_name = 'stock_counts'
--       AND column_name IN ('expected_units','flag_kind','review_note');
--    -- expect 3 rows
--
-- 2. trigger stamps on INSERT (use a real product_id + location_id from
--    your org; pick a product whose product_stock.quantity you know):
--    INSERT INTO stock_counts (session_id, product_id, location_id,
--        count_date, closing_units, counted_by, org_id)
--    VALUES (gen_random_uuid(), '<product_id>', '<location_id>',
--        CURRENT_DATE, 999, 'migration test', '<org_id>')
--    RETURNING expected_units, flag_kind;
--    -- expect expected_units = that product's product_stock.quantity,
--    --        flag_kind = 'unit_ceiling' (999 is way over) or 'value'
--
-- 3. re-save does NOT move the baseline:
--    UPDATE stock_counts SET closing_units = 1
--     WHERE counted_by = 'migration test'
--    RETURNING expected_units;
--    -- expect expected_units UNCHANGED from step 2
--
-- 4. clean up:  DELETE FROM stock_counts WHERE counted_by = 'migration test';
-- ============================================================
