-- 069: Period locks — prevents voids, expense deletes, adjustments, and returns
-- from modifying data in a closed accounting period.
--
-- One row per org. locked_through = the last date that's frozen (inclusive).
-- Only owners can set/advance the lock.

CREATE TABLE IF NOT EXISTS period_locks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  locked_through DATE NOT NULL,
  locked_by UUID REFERENCES auth.users(id),
  locked_at TIMESTAMPTZ DEFAULT now(),
  notes TEXT,
  UNIQUE(org_id)
);

ALTER TABLE period_locks ENABLE ROW LEVEL SECURITY;

-- Read: any org member
DROP POLICY IF EXISTS "period_locks_read" ON period_locks;
CREATE POLICY "period_locks_read" ON period_locks
  FOR SELECT USING (
    org_id IN (SELECT current_user_org_ids())
  );

-- Write: owner only
DROP POLICY IF EXISTS "period_locks_write" ON period_locks;
CREATE POLICY "period_locks_write" ON period_locks
  FOR ALL USING (
    org_id IN (SELECT current_user_org_ids())
    AND EXISTS (
      SELECT 1 FROM org_members
      WHERE org_members.org_id = period_locks.org_id
        AND org_members.user_id = auth.uid()
        AND org_members.role = 'owner'
    )
  );
