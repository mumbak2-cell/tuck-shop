-- ============================================================
-- Migration 121: Stock-take variance flags (v1)
--
-- Adds an immutable "expected on hand" snapshot and a per-line flag to
-- stock_counts, stamped by a BEFORE INSERT trigger from product_stock and
-- protected by a BEFORE UPDATE trigger that freezes the baseline and re-flags
-- whenever the closing count is edited.
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

-- flag_kind is written only by the functions below, but a CHECK keeps a stray
-- direct write from inventing a badge the frontend has no label for.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stock_counts_flag_kind_check'
  ) THEN
    ALTER TABLE public.stock_counts
      ADD CONSTRAINT stock_counts_flag_kind_check
      CHECK (flag_kind IS NULL OR flag_kind IN
        ('near_empty','value','unit_ceiling','session_spread','pattern'));
  END IF;
END $$;

-- ---- Part 2: flag thresholds (tune here) ----------------------------
--   near_empty   : expected <= 2 AND variance >= 3        (always flags, price-independent)
--   value        : abs(variance) * selling_price >= 100
--   unit_ceiling : abs(variance) >= 15
--   pattern      : same product+location, same-direction variance across the
--                  last 2 confirmed sessions + this one
--   session_spread : set by the app (needs session aggregates), not here
-- Priority: near_empty > value > unit_ceiling > pattern. First match wins.

-- ---- Part 3a: flag computation (pure) -------------------------------
-- Takes the baseline as an ARGUMENT and never reads product_stock, so the
-- BEFORE UPDATE path can re-run it against the FROZEN baseline rather than
-- against whatever product_stock happens to hold now.
CREATE OR REPLACE FUNCTION public.stock_count_flag_kind(
  p_expected    INTEGER,
  p_closing     INTEGER,
  p_product_id  UUID,
  p_location_id UUID
) RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_variance   INTEGER;
  v_price      NUMERIC;
  v_prepared   BOOLEAN;
  v_prev_dirs  INTEGER;   -- count of prior confirmed sessions with same-sign variance
BEGIN
  IF p_closing IS NULL OR p_expected IS NULL THEN
    RETURN NULL;
  END IF;

  v_variance := p_closing - p_expected;

  SELECT p.selling_price, p.is_prepared
    INTO v_price, v_prepared
    FROM public.products p
   WHERE p.id = p_product_id;

  -- Prepared-food items legitimately run +variance every count until a
  -- production_log -> product_stock credit flow exists. No flag.
  IF COALESCE(v_prepared, false) THEN
    RETURN NULL;
  END IF;

  IF p_expected <= 2 AND v_variance >= 3 THEN
    RETURN 'near_empty';
  ELSIF abs(v_variance) * COALESCE(v_price, 0) >= 100 THEN
    RETURN 'value';
  ELSIF abs(v_variance) >= 15 THEN
    RETURN 'unit_ceiling';
  END IF;

  -- pattern: last 2 CONFIRMED sessions for this product+location with a
  -- variance in the same direction as this one.
  IF v_variance <> 0 THEN
    SELECT count(*)
      INTO v_prev_dirs
      FROM (
        SELECT sc.closing_units - sc.expected_units AS prev_var
          FROM public.stock_counts sc
         WHERE sc.product_id = p_product_id
           AND sc.location_id = p_location_id
           AND sc.confirmed_at IS NOT NULL
           AND sc.expected_units IS NOT NULL
           AND sc.closing_units IS NOT NULL
         ORDER BY sc.confirmed_at DESC
         LIMIT 2
      ) recent
     WHERE sign(recent.prev_var) = sign(v_variance)
       AND recent.prev_var <> 0;

    IF v_prev_dirs = 2 THEN
      RETURN 'pattern';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.stock_count_flag_kind(INTEGER, INTEGER, UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stock_count_flag_kind(INTEGER, INTEGER, UUID, UUID) TO authenticated;

-- ---- Part 3b: BEFORE INSERT trigger function ------------------------
CREATE OR REPLACE FUNCTION public.stamp_stock_count_expected()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.closing_units IS NULL THEN
    RETURN NEW;
  END IF;

  NEW.expected_units := COALESCE(
    (SELECT ps.quantity FROM public.product_stock ps
      WHERE ps.product_id = NEW.product_id
        AND ps.location_id = NEW.location_id), 0);

  NEW.flag_kind := public.stock_count_flag_kind(
    NEW.expected_units, NEW.closing_units, NEW.product_id, NEW.location_id);

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.stamp_stock_count_expected() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stamp_stock_count_expected() TO authenticated;

-- ---- Part 3c: BEFORE UPDATE trigger function ------------------------
-- The evidence columns are not the client's to write. saveAllCounts re-upserts
-- an edited line (ON CONFLICT DO UPDATE), which fires no INSERT trigger — so
-- without this, counting a zero-stock item at 0, saving, then changing it to 5
-- would keep the first insert's flag_kind (NULL) and leave no trace at all.
-- Here: the baseline is frozen to OLD, and any change to closing_units
-- re-computes the flag FROM THAT FROZEN BASELINE. flag_kind may otherwise only
-- stay as it is, or go NULL -> 'session_spread' (the app's session-level pass).
CREATE OR REPLACE FUNCTION public.protect_stock_count_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Pre-migration / not-yet-stamped row: leave it alone so a later backfill
  -- or process can still stamp it.
  IF OLD.expected_units IS NULL THEN
    RETURN NEW;
  END IF;

  NEW.expected_units := OLD.expected_units;

  IF NEW.closing_units IS DISTINCT FROM OLD.closing_units
     AND NEW.closing_units IS NOT NULL THEN
    NEW.flag_kind := public.stock_count_flag_kind(
      OLD.expected_units, NEW.closing_units, NEW.product_id, NEW.location_id);
  ELSE
    IF NOT (NEW.flag_kind IS NOT DISTINCT FROM OLD.flag_kind
            OR (OLD.flag_kind IS NULL AND NEW.flag_kind = 'session_spread')) THEN
      NEW.flag_kind := OLD.flag_kind;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.protect_stock_count_evidence() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.protect_stock_count_evidence() TO authenticated;

-- ---- Part 4: BEFORE INSERT trigger ----------------------------------
DROP TRIGGER IF EXISTS trg_stamp_stock_count_expected ON public.stock_counts;
CREATE TRIGGER trg_stamp_stock_count_expected
  BEFORE INSERT ON public.stock_counts
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_stock_count_expected();

-- ---- Part 5: backfill open (unconfirmed) sessions ------------------
-- Only rows still pending review — older confirmed rows stay NULL and
-- simply carry no badge. Uses the same COALESCE(...,0) rule; does NOT
-- compute flag_kind for backfilled rows, which is acceptable: the owner
-- reviews these once with variance visible.
-- MUST run BEFORE trg_protect_stock_count_evidence exists — that trigger
-- forces expected_units back to OLD on every UPDATE. (Its OLD.expected_units
-- IS NULL early return also covers this; the ordering is defence in depth.)
UPDATE public.stock_counts sc
   SET expected_units = COALESCE(
         (SELECT ps.quantity FROM public.product_stock ps
           WHERE ps.product_id = sc.product_id
             AND ps.location_id = sc.location_id), 0)
 WHERE sc.confirmed_at IS NULL
   AND sc.closing_units IS NOT NULL
   AND sc.expected_units IS NULL;

-- ---- Part 6: BEFORE UPDATE trigger (after the backfill) -------------
DROP TRIGGER IF EXISTS trg_protect_stock_count_evidence ON public.stock_counts;
CREATE TRIGGER trg_protect_stock_count_evidence
  BEFORE UPDATE ON public.stock_counts
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_stock_count_evidence();

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
-- 3. re-save does NOT move the baseline, but DOES re-flag:
--    UPDATE stock_counts SET closing_units = 1
--     WHERE counted_by = 'migration test'
--    RETURNING expected_units, flag_kind;
--    -- expect expected_units UNCHANGED from step 2, and flag_kind recomputed
--    --        against that frozen baseline (likely NULL now that closing = 1)
--
-- 4. an edit that re-introduces a variance re-flags it:
--    UPDATE stock_counts SET closing_units = 999
--     WHERE counted_by = 'migration test'
--    RETURNING expected_units, flag_kind;
--    -- expect flag_kind non-NULL again ('unit_ceiling' or 'value')
--
-- 5. tampering with the evidence columns is reverted:
--    UPDATE stock_counts SET flag_kind = NULL, expected_units = 999
--     WHERE counted_by = 'migration test'
--    RETURNING expected_units, flag_kind;
--    -- expect BOTH unchanged from step 4 (closing_units did not move, so
--    --        flag_kind is restored to OLD and expected_units to OLD)
--
-- 6. confirming passes through untouched:
--    UPDATE stock_counts SET confirmed_by = 'test', confirmed_at = now()
--     WHERE counted_by = 'migration test'
--    RETURNING expected_units, flag_kind, confirmed_by;
--    -- expect expected_units / flag_kind unchanged, confirmed_by = 'test'
--
-- 7. clean up:  DELETE FROM stock_counts WHERE counted_by = 'migration test';
-- ============================================================
