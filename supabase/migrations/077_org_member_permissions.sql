-- Per-manager permission toggles. A manager (org_members.role = 'admin')
-- defaults to full access, matching pre-existing behavior: absence of a key,
-- or a key set to anything other than `false`, means granted. Only an
-- explicit `false` revokes it. Owners are unaffected by this column (always
-- full access); cashiers (role = 'member') are unaffected too (never had
-- these functions).
ALTER TABLE org_members ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{}'::jsonb;
