-- 066_backfill_cost_prices_50pct_markup.sql
--
-- Back-fill cost prices for Chichi's Bakes products that were entered with
-- selling prices but no buying prices (package_price = 0).
--
-- Formula: 50% markup means selling = cost × 1.5, so cost = selling / 1.5.
-- Sets package_price = ROUND(selling_price / 1.5 * qty_in_pack, 2) which
-- flows through the generated cost_per_unit column automatically.
--
-- Scoped to Chichi's org only (resolved by owner email, same pattern as 065).
-- Idempotent: only touches rows where package_price = 0 AND selling_price > 0.

DO $$
DECLARE
  owner_email CONSTANT TEXT := 'mariah.chilufya@gmail.com';
  target_org  UUID;
  match_count INT;
  updated     INT;
BEGIN
  -- Resolve org
  SELECT count(*) INTO match_count
  FROM org_members om
  JOIN auth.users u ON u.id = om.user_id
  WHERE lower(u.email) = owner_email
    AND om.role = 'owner';

  IF match_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly one org owned by %, found %.',
      owner_email, match_count;
  END IF;

  SELECT om.org_id INTO target_org
  FROM org_members om
  JOIN auth.users u ON u.id = om.user_id
  WHERE lower(u.email) = owner_email
    AND om.role = 'owner';

  -- Back-fill: cost = selling_price / 1.5, scaled by qty_in_pack
  UPDATE products
  SET package_price = ROUND(selling_price / 1.5 * COALESCE(qty_in_pack, 1), 2)
  WHERE org_id = target_org
    AND (package_price IS NULL OR package_price = 0)
    AND selling_price > 0;

  GET DIAGNOSTICS updated = ROW_COUNT;
  RAISE NOTICE 'Updated % products in org % with 50%% markup cost prices.', updated, target_org;
END $$;

-- Verification: show every product that now has a cost, confirming the markup.
-- Expect ~61 rows. The "markup" column should read ~50% for all.
SELECT
  name,
  selling_price                          AS sells_for,
  ROUND(package_price / COALESCE(NULLIF(qty_in_pack, 0), 1), 2) AS cost_per_unit,
  ROUND((selling_price /
         NULLIF(ROUND(package_price / COALESCE(NULLIF(qty_in_pack, 0), 1), 2), 0)
         - 1) * 100, 0)                 AS markup_pct
FROM products
WHERE org_id = (
  SELECT om.org_id FROM org_members om
  JOIN auth.users u ON u.id = om.user_id
  WHERE lower(u.email) = 'mariah.chilufya@gmail.com'
    AND om.role = 'owner'
)
AND selling_price > 0
ORDER BY name;
