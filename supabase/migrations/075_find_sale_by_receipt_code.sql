-- ============================================================
-- Migration 075: Look a sale up by its printed receipt code
--
-- The receipt code is the last six hex digits of a UUID (see
-- src/lib/receipt-code.ts). Matching that suffix needs a cast, which
-- PostgREST cannot express as a filter on a uuid column, so the lookup lives
-- here instead.
--
-- Matches the transaction id first — that is what a receipt normally carries.
-- Also matches an individual sale row's id, because a receipt printed while
-- the till was offline is numbered from the line id: the transaction id does
-- not exist until the queued sale reaches the server.
--
-- SECURITY INVOKER on purpose. RLS then scopes the search to the caller's own
-- shop, so a code cannot be used to fish for another org's sales.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION find_sale_by_receipt_code(p_code TEXT)
RETURNS TABLE (transaction_id UUID, sale_date DATE, location_id UUID)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT DISTINCT s.transaction_id, s.sale_date, s.location_id
    FROM sales s
   WHERE length(COALESCE(TRIM(p_code), '')) >= 4
     AND (
           upper(right(replace(s.transaction_id::text, '-', ''), 6)) = upper(TRIM(p_code))
        OR upper(right(replace(s.id::text, '-', ''), 6)) = upper(TRIM(p_code))
         )
   LIMIT 20;
$$;

REVOKE ALL ON FUNCTION find_sale_by_receipt_code(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION find_sale_by_receipt_code(TEXT) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
