-- ============================================================
-- Migration 055: Cost prepared food from its recipe
--
-- products.cost_per_unit was generated as package_price / qty_in_pack — the
-- maths for buying a pack and splitting it. A prepared item is not bought in a
-- pack, so both inputs are empty, cost_per_unit computed to NULL, and the POS
-- fell back to `?? 0`. Every prepared item therefore sold at ZERO cost and
-- contributed nothing to COGS, while its ingredients were logged as expenses.
--
-- The recipes table (migration 001) has held the bill of materials all along
-- but was never wired to anything. Two pieces were missing to make it costable:
--
--   1. ingredients.purchase_qty — purchase_price buys ONE pack, and
--      purchase_size is free text ("2.5kg bag"), so there was no numeric way
--      to reach a per-unit cost. This stores how many `unit`s that price buys.
--   2. products.units_per_batch — recipes.quantity_per_batch gives ingredient
--      amounts per batch, but nothing recorded how many units a batch yields.
--
--       recipe_cost_per_unit =
--         SUM(quantity_per_batch * purchase_price / purchase_qty) / units_per_batch
--
-- Both new columns are deliberately left NULL rather than defaulted. A guessed
-- pack size produces a confidently wrong cost, and this figure feeds COGS and
-- therefore profit. NULL means "not costed yet" and behaves exactly as today
-- (zero cost at the POS) until an operator fills it in — so this migration
-- cannot make any existing number worse.
--
-- cost_per_unit keeps its name and stays generated, now preferring the recipe
-- cost and falling back to the pack maths. Every existing reader (POS cart,
-- dashboard, products list) is unchanged and starts seeing real costs for
-- prepared items the moment a recipe is complete.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. The two missing inputs
-- ------------------------------------------------------------

ALTER TABLE ingredients
  ADD COLUMN IF NOT EXISTS purchase_qty NUMERIC(12,4)
    CHECK (purchase_qty IS NULL OR purchase_qty > 0);

COMMENT ON COLUMN ingredients.purchase_qty IS
  'How many `unit`s one purchase_price buys. R50 for a 2.5kg bag with unit=kg → 2.5. NULL = not set, so recipes using it cannot be costed.';

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS units_per_batch INTEGER
    CHECK (units_per_batch IS NULL OR units_per_batch > 0);

COMMENT ON COLUMN products.units_per_batch IS
  'How many sellable units one batch of the recipe yields. NULL = not set.';

-- Stored result of the recipe calculation. Maintained by trigger below; never
-- written by the app, so it cannot drift from the recipe it claims to describe.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS recipe_cost_per_unit NUMERIC(12,4);

COMMENT ON COLUMN products.recipe_cost_per_unit IS
  'Derived from recipes + ingredient costs by recalc_recipe_cost(). NULL when the recipe is absent or incomplete. Do not write directly.';

-- ------------------------------------------------------------
-- 2. Redefine cost_per_unit to prefer the recipe cost
--
-- A generated column's expression cannot be altered in place, so it is dropped
-- and re-added. It is computed, so no data is lost. Verified beforehand that
-- no view, policy, index or function references it — only application reads.
-- ------------------------------------------------------------

ALTER TABLE products DROP COLUMN IF EXISTS cost_per_unit;

ALTER TABLE products
  ADD COLUMN cost_per_unit NUMERIC(12,4) GENERATED ALWAYS AS (
    COALESCE(
      recipe_cost_per_unit,
      CASE WHEN qty_in_pack > 0 THEN package_price / qty_in_pack ELSE NULL END
    )
  ) STORED;

-- ------------------------------------------------------------
-- 3. Recalculation
--
-- Returns NULL unless the recipe is complete: at least one line, every
-- ingredient priced per unit, and a batch yield. A partial recipe must not
-- produce a plausible-looking number — SUM() skips NULL rows silently, which
-- would quietly understate cost, so missing inputs are counted explicitly.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION recalc_recipe_cost(p_product_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch_cost   NUMERIC;
  v_units_batch  INTEGER;
  v_lines        INTEGER;
  v_incomplete   INTEGER;
BEGIN
  SELECT units_per_batch INTO v_units_batch FROM products WHERE id = p_product_id;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (
      WHERE i.purchase_qty IS NULL OR i.purchase_qty <= 0 OR i.purchase_price IS NULL
    ),
    SUM(r.quantity_per_batch * (i.purchase_price / NULLIF(i.purchase_qty, 0)))
  INTO v_lines, v_incomplete, v_batch_cost
  FROM recipes r
  JOIN ingredients i ON i.id = r.ingredient_id
  WHERE r.product_id = p_product_id;

  IF v_lines = 0 OR v_incomplete > 0 OR v_units_batch IS NULL OR v_units_batch <= 0 THEN
    UPDATE products SET recipe_cost_per_unit = NULL WHERE id = p_product_id;
  ELSE
    UPDATE products
    SET recipe_cost_per_unit = ROUND(v_batch_cost / v_units_batch, 4)
    WHERE id = p_product_id;
  END IF;
END;
$$;

-- ------------------------------------------------------------
-- 4. Keep it current
--
-- Without these, a cost goes stale the moment an ingredient price changes —
-- the silent-wrong-number failure this whole feature exists to remove.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_recalc_from_recipe()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM recalc_recipe_cost(OLD.product_id);
    RETURN OLD;
  END IF;
  PERFORM recalc_recipe_cost(NEW.product_id);
  -- An UPDATE that moves a line to another product must refresh both.
  IF TG_OP = 'UPDATE' AND OLD.product_id IS DISTINCT FROM NEW.product_id THEN
    PERFORM recalc_recipe_cost(OLD.product_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS recipes_recalc_cost ON recipes;
CREATE TRIGGER recipes_recalc_cost
  AFTER INSERT OR UPDATE OR DELETE ON recipes
  FOR EACH ROW EXECUTE FUNCTION trg_recalc_from_recipe();

-- Ingredient price or pack size changed → every product using it is restated.
CREATE OR REPLACE FUNCTION trg_recalc_from_ingredient()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
BEGIN
  IF NEW.purchase_price IS DISTINCT FROM OLD.purchase_price
     OR NEW.purchase_qty IS DISTINCT FROM OLD.purchase_qty THEN
    FOR r IN SELECT DISTINCT product_id FROM recipes WHERE ingredient_id = NEW.id LOOP
      PERFORM recalc_recipe_cost(r.product_id);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ingredients_recalc_cost ON ingredients;
CREATE TRIGGER ingredients_recalc_cost
  AFTER UPDATE ON ingredients
  FOR EACH ROW EXECUTE FUNCTION trg_recalc_from_ingredient();

-- Batch yield changed → that product is restated. Guarded on the column so an
-- ordinary product edit does not recurse through its own UPDATE.
CREATE OR REPLACE FUNCTION trg_recalc_from_product()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.units_per_batch IS DISTINCT FROM OLD.units_per_batch THEN
    PERFORM recalc_recipe_cost(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS products_recalc_cost ON products;
CREATE TRIGGER products_recalc_cost
  AFTER UPDATE OF units_per_batch ON products
  FOR EACH ROW EXECUTE FUNCTION trg_recalc_from_product();

CREATE INDEX IF NOT EXISTS idx_recipes_ingredient ON recipes(ingredient_id);

COMMIT;
