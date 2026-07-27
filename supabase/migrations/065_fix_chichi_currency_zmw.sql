-- 065_fix_chichi_currency_zmw.sql
--
-- Set Chichi's Bakes and Accessories to the Zambian Kwacha (ZMW).
--
-- Currency in Tilify is a SINGLE org-wide setting: app_settings.currency, keyed
-- (org_id, key). Every cashier and manager in the org reads that one value via
-- currency-context, so updating this single row fixes the display for ALL of
-- her users at once (owner + the six branch logins) — there is no per-user
-- currency to set.
--
-- Display-only: this swaps the symbol shown in the POS/reports from R to K. It
-- does NOT convert or touch any stored amounts. Prices were always entered as
-- Kwacha values; only the symbol was wrong (the org was left on the ZAR default
-- that create_organization_for_user seeds when no currency is chosen at signup).
--
-- Code note: ZMW is the current ISO 4217 code for the Zambian Kwacha. The old
-- "ZMK" was redenominated to ZMW in 2013 and is not in the app's currency
-- catalog (src/lib/currency.ts), so ZMK would fall back to the ZAR default —
-- ZMW is the only correct value.
--
-- Org resolution: by the owner's exact login, mariah.chilufya@gmail.com. There
-- is no org named "Chilufya"; the org is "Chichi's Bakes and Accessories" and
-- the branches are cashier logins under this one org, so the owner email is the
-- reliable key (a name match is fuzzy and could hit the wrong tenant).
--
-- Idempotent: re-running sets ZMW again with no side effect. Guarded so it
-- refuses to run rather than touch the wrong org.

DO $$
DECLARE
  owner_email CONSTANT TEXT := 'mariah.chilufya@gmail.com';
  target_org UUID;
  match_count INT;
BEGIN
  SELECT count(*) INTO match_count
  FROM org_members om
  JOIN auth.users u ON u.id = om.user_id
  WHERE lower(u.email) = owner_email
    AND om.role = 'owner';

  IF match_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly one org owned by %, found %. Confirm the owner login and org with the verification query below before applying.',
      owner_email, match_count;
  END IF;

  SELECT om.org_id INTO target_org
  FROM org_members om
  JOIN auth.users u ON u.id = om.user_id
  WHERE lower(u.email) = owner_email
    AND om.role = 'owner';

  -- The currency row is always seeded at org creation, so this UPDATE is the
  -- real fix; the INSERT below is belt-and-braces in case it was ever removed.
  UPDATE app_settings
     SET value = 'ZMW', updated_at = now()
   WHERE org_id = target_org
     AND key = 'currency';

  INSERT INTO app_settings (org_id, key, value)
  SELECT target_org, 'currency', 'ZMW'
  WHERE NOT EXISTS (
    SELECT 1 FROM app_settings
    WHERE org_id = target_org AND key = 'currency'
  );

  RAISE NOTICE 'Set currency to ZMW for org % (owner %)', target_org, owner_email;
END $$;

-- Verification (single result set — the SQL editor shows only the last
-- statement's output). Expect one row: Chichi's org, currency = ZMW.
SELECT o.id AS org_id,
       o.name,
       s.value AS currency,
       s.updated_at
FROM organizations o
JOIN org_members om ON om.org_id = o.id AND om.role = 'owner'
JOIN auth.users u ON u.id = om.user_id
JOIN app_settings s ON s.org_id = o.id AND s.key = 'currency'
WHERE lower(u.email) = 'mariah.chilufya@gmail.com';
