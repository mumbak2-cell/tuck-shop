-- ============================================================
-- 094_wms_tier2_approval_thresholds.sql
--
-- Tier 2 Phase 4 (part 2/3) — approval thresholds on adjustments.
--
-- Scope
-- -----
-- Per-org configurable ZAR threshold above which stock adjustments
-- require a designated approver's user_id on the RPC call. Below
-- threshold, adjustments still fire freely. Threshold NULL means
-- no gate (default).
--
-- Value = abs(adjustment_qty * cost_price). If p_cost_price is NULL,
-- inventory's avg_cost at the target bin is used. If both are NULL
-- (item never received; no cost basis), the threshold is bypassed
-- rather than blocking a value-unknown correction.
--
-- Approver validation (DB level)
--   Approver must be:
--     - org_members.role = 'owner',                      OR
--     - org_members.role = 'admin' with permissions.void_sales
--       neither false nor missing (see 077's default-grant rule:
--       absence-or-not-false = granted).
--   Approver's org must match the adjustment's org.
--
--   RPC does NOT verify the approver ACTUALLY authorized — that's the
--   frontend's job (Wave B11 will prompt for the approver's PIN or
--   equivalent). This RPC only enforces that the *claimed* approver
--   is eligible.
--
-- Idempotent. Safe to re-run.
--
-- Depends on 083 (audit_logs), 084 (idempotency, freeze), 087-089
-- (ledger, resolve_wms_main_location), 090's record_wms_adjustment
-- signature is preserved and widened.
--
-- Record with:
--   node node_modules/supabase/dist/supabase.js migration repair \
--     --status applied 094
-- ============================================================

-- ------------------------------------------------------------
-- 1. wms_org_settings — per-org WMS configuration.
--    Deliberately a new table (rather than piling onto organizations)
--    so future WMS-scoped settings — reserved bins, auto-close cadence,
--    default landed-cost method — live in one place with WMS RLS.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wms_org_settings (
  org_id                          UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  adjustment_approval_threshold   NUMERIC(12,2),   -- NULL = no gate
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by                      UUID
);

ALTER TABLE wms_org_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wms_org_settings_org_read"  ON wms_org_settings;
DROP POLICY IF EXISTS "wms_org_settings_org_write" ON wms_org_settings;

CREATE POLICY "wms_org_settings_org_read" ON wms_org_settings FOR SELECT
  USING (org_id IN (SELECT current_user_org_ids()));

-- Owners + writable-org admins may upsert. Client wraps writes with an
-- ON CONFLICT DO UPDATE.
CREATE POLICY "wms_org_settings_org_write" ON wms_org_settings FOR ALL
  USING      (org_id IN (SELECT current_user_writable_org_ids()))
  WITH CHECK (org_id IN (SELECT current_user_writable_org_ids()));

-- ------------------------------------------------------------
-- 2. Helper — is a user a valid adjustment approver for an org?
--    Owner OR admin-with-void_sales-not-false. Mirrors the 077 rule.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION is_wms_adjustment_approver(
  p_org_id  UUID,
  p_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role  TEXT;
  v_perms JSONB;
BEGIN
  IF p_user_id IS NULL OR p_org_id IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT role, permissions INTO v_role, v_perms
    FROM org_members
   WHERE org_id = p_org_id AND user_id = p_user_id;

  IF v_role IS NULL THEN RETURN FALSE; END IF;

  IF v_role = 'owner' THEN RETURN TRUE; END IF;

  IF v_role = 'admin' THEN
    -- 077 rule: absence-or-not-false = granted.
    RETURN COALESCE((v_perms->>'void_sales')::BOOLEAN IS DISTINCT FROM FALSE, TRUE);
  END IF;

  RETURN FALSE;
END;
$$;

REVOKE EXECUTE ON FUNCTION is_wms_adjustment_approver(UUID, UUID) FROM PUBLIC, anon;

-- ------------------------------------------------------------
-- 3. Widen record_wms_adjustment with p_approver_user_id.
--    Same DROP-then-CREATE compat pattern as 084/089.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.record_wms_adjustment(BIGINT, INT, TEXT, TEXT, TEXT, NUMERIC, UUID, UUID);

CREATE OR REPLACE FUNCTION record_wms_adjustment(
  p_wms_item_id     BIGINT,
  p_adjustment_qty  INT,
  p_reason          TEXT,
  p_notes           TEXT    DEFAULT NULL,
  p_recorded_by     TEXT    DEFAULT NULL,
  p_cost_price      NUMERIC DEFAULT NULL,
  p_idempotency_key UUID    DEFAULT NULL,
  p_location_id     UUID    DEFAULT NULL,
  p_approver_user_id UUID   DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id        UUID;
  v_adjustment_id BIGINT;
  v_cached        JSONB;
  v_location_id   UUID;
  v_threshold     NUMERIC;
  v_effective_cost NUMERIC;
  v_value         NUMERIC;
BEGIN
  IF p_adjustment_qty = 0 THEN
    RAISE EXCEPTION 'Adjustment qty cannot be zero';
  END IF;
  IF p_reason NOT IN ('Breakage', 'Expired', 'Theft', 'Correction', 'Other') THEN
    RAISE EXCEPTION 'Invalid reason %', p_reason USING ERRCODE = '22023';
  END IF;

  SELECT org_id INTO v_org_id FROM wms_catalog WHERE id = p_wms_item_id;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Unknown wms_item_id %', p_wms_item_id USING ERRCODE = '42501';
  END IF;

  PERFORM assert_org_writable(v_org_id);
  PERFORM assert_no_active_freeze(v_org_id, ARRAY[p_wms_item_id]::BIGINT[]);

  v_location_id := COALESCE(p_location_id, resolve_wms_main_location(v_org_id));

  -- ------------------------------------------------------------
  -- Approval gate
  -- ------------------------------------------------------------
  SELECT adjustment_approval_threshold INTO v_threshold
    FROM wms_org_settings WHERE org_id = v_org_id;

  IF v_threshold IS NOT NULL AND v_threshold > 0 THEN
    -- Resolve effective cost: caller-supplied → inventory avg_cost.
    v_effective_cost := p_cost_price;
    IF v_effective_cost IS NULL THEN
      SELECT avg_cost INTO v_effective_cost
        FROM wms_inventory
       WHERE org_id = v_org_id
         AND wms_item_id = p_wms_item_id
         AND location_id = v_location_id;
    END IF;

    IF v_effective_cost IS NOT NULL THEN
      v_value := abs(p_adjustment_qty) * v_effective_cost;

      IF v_value > v_threshold THEN
        IF p_approver_user_id IS NULL THEN
          RAISE EXCEPTION 'Approval required: R% exceeds threshold R%', v_value, v_threshold
            USING ERRCODE = 'P0001',
                  HINT    = 'Have an owner or manager with void permission approve this adjustment.';
        END IF;
        IF NOT is_wms_adjustment_approver(v_org_id, p_approver_user_id) THEN
          RAISE EXCEPTION 'Supplied approver is not authorized to approve WMS adjustments for this org'
            USING ERRCODE = '42501';
        END IF;
      END IF;
    END IF;
    -- If cost is completely unknown (no p_cost_price + no avg_cost),
    -- the threshold is bypassed — value-unknown correction proceeds.
  END IF;

  v_cached := claim_rpc_idempotency(p_idempotency_key, v_org_id, 'record_wms_adjustment');
  IF v_cached IS NOT NULL THEN
    RETURN (v_cached->>'result')::BIGINT;
  END IF;

  INSERT INTO wms_adjustments (
    org_id, wms_item_id, reason, adjustment_qty, notes, recorded_by, cost_price
  ) VALUES (
    v_org_id, p_wms_item_id, p_reason, p_adjustment_qty,
    NULLIF(TRIM(p_notes), ''), p_recorded_by, p_cost_price
  )
  RETURNING id INTO v_adjustment_id;

  UPDATE wms_inventory
     SET physical_qty = GREATEST(physical_qty + p_adjustment_qty, 0),
         updated_at   = NOW()
   WHERE org_id = v_org_id AND wms_item_id = p_wms_item_id AND location_id = v_location_id;

  PERFORM emit_stock_movement(
    v_org_id, p_wms_item_id, v_location_id, p_adjustment_qty, p_cost_price,
    'adjust', 'wms_adjustments', v_adjustment_id, p_reason
  );

  -- Audit the approval (only when it actually gated).
  IF p_approver_user_id IS NOT NULL AND v_threshold IS NOT NULL AND v_effective_cost IS NOT NULL
     AND abs(p_adjustment_qty) * v_effective_cost > v_threshold THEN
    INSERT INTO audit_logs (org_id, actor_user_id, action, entity_table, details)
    VALUES (v_org_id, auth.uid(), 'wms_adjustment_approved', 'wms_adjustments',
            jsonb_build_object(
              'id', v_adjustment_id,
              'approver_user_id', p_approver_user_id,
              'value', abs(p_adjustment_qty) * v_effective_cost,
              'threshold', v_threshold
            ));
  END IF;

  PERFORM store_rpc_idempotency_response(
    p_idempotency_key, v_org_id, 'record_wms_adjustment',
    jsonb_build_object('result', v_adjustment_id)
  );

  RETURN v_adjustment_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION record_wms_adjustment(BIGINT, INT, TEXT, TEXT, TEXT, NUMERIC, UUID, UUID, UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION record_wms_adjustment(BIGINT, INT, TEXT, TEXT, TEXT, NUMERIC, UUID, UUID, UUID) TO authenticated;

-- ============================================================
-- Verification (run manually in SQL Editor after applying)
-- ============================================================
-- -- 1. Table + helper + RPC exist:
-- SELECT 'wms_org_settings',
--        EXISTS (SELECT 1 FROM information_schema.tables
--                 WHERE table_schema='public' AND table_name='wms_org_settings')::text UNION ALL
-- SELECT 'is_wms_adjustment_approver',
--        EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--                 WHERE n.nspname='public' AND p.proname='is_wms_adjustment_approver')::text UNION ALL
-- SELECT 'record_wms_adjustment overloads = 1',
--        ((SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--            WHERE n.nspname='public' AND p.proname='record_wms_adjustment') = 1)::text;
-- -- Expect: 3 rows, all 'true'.
--
-- -- 2. Threshold gate (pick <ITEM> in your org, has known avg_cost):
-- DO $$
-- DECLARE v_item BIGINT := <ITEM>;
--         v_org  UUID   := (SELECT org_id FROM wms_catalog WHERE id = v_item);
-- BEGIN
--   -- Set a very low threshold.
--   INSERT INTO wms_org_settings (org_id, adjustment_approval_threshold)
--   VALUES (v_org, 0.01)
--   ON CONFLICT (org_id) DO UPDATE SET adjustment_approval_threshold = 0.01;
--
--   BEGIN
--     PERFORM record_wms_adjustment(v_item, -1, 'Correction', 'threshold-test', NULL,
--       10.00, NULL, NULL, NULL);
--     RAISE EXCEPTION 'FAIL: no approval required raised';
--   EXCEPTION WHEN OTHERS THEN
--     IF SQLERRM ILIKE '%Approval required%' THEN
--       RAISE NOTICE 'PASS: approval gate fired';
--     ELSE
--       RAISE EXCEPTION 'FAIL: unexpected: %', SQLERRM;
--     END IF;
--   END;
--
--   -- Clean up: remove threshold.
--   UPDATE wms_org_settings SET adjustment_approval_threshold = NULL WHERE org_id = v_org;
-- END $$;
