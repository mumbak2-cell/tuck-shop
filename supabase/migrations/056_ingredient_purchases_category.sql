-- ============================================================
-- Migration 056: "Ingredient Purchases" expense category
--
-- Ingredients are bought and typed straight into Expenses under a general
-- category (Consumables, Other, …). That was correct while prepared food had
-- no cost: the expense line was the ONLY place the ingredient cost appeared,
-- since every prepared item sold at zero cost.
--
-- Migration 055 changed that. A prepared item with a recipe now carries a real
-- cost_per_unit, which is snapshotted onto the sale and lands in COGS. From the
-- moment a recipe is complete, an ingredient bought and logged as an operating
-- expense is charged TWICE — once as the expense, again through COGS — which is
-- exactly the double-count removed for stock in PR #48.
--
-- Buying ingredients is not an expense. It converts cash into inventory and
-- becomes a cost when the finished item sells. This adds a category that says
-- so, which Profit & Loss holds out of operating expenses alongside
-- "Stock Purchases".
--
-- Cash-spent reporting treats it the OPPOSITE way, and that is deliberate:
-- money genuinely left the till on the day it was bought. The two reports
-- disagree because one is accrual and the other is cash basis.
--
-- Existing rows are NOT recategorised. "Consumables" legitimately covers both
-- ingredients and cleaning supplies, and nothing recorded which is which, so
-- any automatic reassignment would be a guess that silently moves money between
-- reports. Operators recategorise their own history if they want past periods
-- restated.
-- ============================================================

BEGIN;

-- The original CHECK was declared inline on the column (migration 006), so its
-- name was auto-generated. Guessing it wrong would leave the old constraint in
-- place, still rejecting the new value, while this migration reported success —
-- so drop every CHECK on the table that constrains the category list, by
-- definition rather than by name.
DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'expenses'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%Stock Purchases%'
  LOOP
    EXECUTE format('ALTER TABLE expenses DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE expenses
  ADD CONSTRAINT expenses_category_check
  CHECK (category IN (
    'Transport', 'Fuel', 'Rent', 'Electricity',
    'Consumables', 'Wages', 'Stock Purchases',
    'Ingredient Purchases',
    'Director Withdrawal', 'Other'
  ));

COMMIT;
