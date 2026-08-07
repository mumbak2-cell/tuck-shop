-- Migration 079: Audit log table + location limit enforcement
--
-- 1. audit_logs — append-only table for accountability-sensitive events
--    (voids, billing changes). RLS: SELECT for org members, no client write.
-- 2. Trigger on sales that auto-logs void events into audit_logs.
-- 3. BEFORE INSERT trigger on locations enforcing plan-based location limits.
--
-- Idempotent: safe to re-run.

BEGIN;

-- ============================================================
-- Part 1: audit_logs table
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id UUID,
  action      TEXT NOT NULL,
  entity_table TEXT,
  entity_id   UUID,
  details     JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_org_created
  ON audit_logs (org_id, created_at DESC);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "audit_logs_org_read" ON audit_logs;
CREATE POLICY "audit_logs_org_read" ON audit_logs
  FOR SELECT USING (org_id IN (SELECT current_user_org_ids()));

-- No INSERT/UPDATE/DELETE policies for authenticated users.
-- Only SECURITY DEFINER triggers and service-role can write.

-- ============================================================
-- Part 2: Auto-log sale voids
-- ============================================================

CREATE OR REPLACE FUNCTION log_sale_void()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.voided = true AND (OLD.voided IS DISTINCT FROM true) THEN
    INSERT INTO audit_logs (org_id, actor_user_id, action, entity_table, entity_id, details)
    VALUES (
      NEW.org_id,
      auth.uid(),
      'void_sale',
      'sales',
      NEW.id,
      jsonb_build_object(
        'product_id', NEW.product_id,
        'quantity', NEW.quantity,
        'unit_price', NEW.unit_price,
        'total_amount', NEW.total_amount,
        'voided_by', NEW.voided_by
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_sale_void ON sales;
CREATE TRIGGER trg_log_sale_void
  AFTER UPDATE ON sales
  FOR EACH ROW
  EXECUTE FUNCTION log_sale_void();

-- ============================================================
-- Part 3: Location limit enforcement
-- ============================================================

CREATE OR REPLACE FUNCTION check_location_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan  TEXT;
  v_limit INT;
  v_count INT;
BEGIN
  SELECT subscription_plan INTO v_plan
  FROM organizations WHERE id = NEW.org_id;

  v_limit := CASE v_plan
    WHEN 'starter' THEN 1
    WHEN 'trial'   THEN 1
    WHEN 'growth'  THEN 3
    WHEN 'pro'     THEN NULL
    ELSE 1
  END;

  IF v_limit IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count
    FROM locations WHERE org_id = NEW.org_id AND active = true;

    IF v_count >= v_limit THEN
      RAISE EXCEPTION 'Location limit reached for your % plan (% of % allowed). Upgrade to add more.',
        v_plan, v_count, v_limit
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_location_limit ON locations;
CREATE TRIGGER trg_check_location_limit
  BEFORE INSERT ON locations
  FOR EACH ROW
  EXECUTE FUNCTION check_location_limit();

COMMIT;
