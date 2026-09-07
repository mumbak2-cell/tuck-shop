-- ============================================================
-- Migration 117: Org last-sale lookup
--
-- Feeds the "shop activity" chart on /admin/customers (active this week /
-- dormant / never used) — one aggregate query instead of pulling every
-- sales row into the API route.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION org_last_sale_dates()
RETURNS TABLE (org_id UUID, last_sale_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT org_id, MAX(created_at) AS last_sale_at
  FROM sales
  GROUP BY org_id;
$$;

-- Platform-admin only: called from the admin API route with the service
-- role, which bypasses this anyway, but keep PUBLIC revoked for consistency
-- with the other SECURITY DEFINER functions (migration 040).
REVOKE ALL ON FUNCTION org_last_sale_dates() FROM PUBLIC;

COMMIT;
