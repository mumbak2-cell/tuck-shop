-- Tilify Phase 2 ground-truth dump. READ ONLY. Run in Supabase SQL Editor.
-- Download each result as CSV.

-- ============ QUERY 1: every RLS policy in public ============
SELECT
  c.relname                                   AS table_name,
  c.relrowsecurity                            AS rls_enabled,
  c.relforcerowsecurity                       AS rls_forced,
  p.polname                                   AS policy_name,
  CASE p.polcmd WHEN 'r' THEN 'SELECT'
                WHEN 'a' THEN 'INSERT'
                WHEN 'w' THEN 'UPDATE'
                WHEN 'd' THEN 'DELETE'
                WHEN '*' THEN 'ALL' END       AS command,
  pg_get_expr(p.polqual,      p.polrelid)     AS using_expr,
  pg_get_expr(p.polwithcheck, p.polrelid)     AS with_check_expr,
  (SELECT string_agg(r.rolname, ',' ORDER BY r.rolname)
     FROM pg_roles r WHERE r.oid = ANY(p.polroles)) AS roles,
  (pg_get_expr(p.polqual, p.polrelid) || ' ' ||
   COALESCE(pg_get_expr(p.polwithcheck, p.polrelid), '')) ~* 'role'
                                              AS mentions_role
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policy p ON p.polrelid = c.oid
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY c.relname, command;

-- ============ QUERY 2: tables with RLS on but ZERO policies, or RLS off ============
SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled,
       count(p.polname) AS policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policy p ON p.polrelid = c.oid
WHERE n.nspname = 'public' AND c.relkind = 'r'
GROUP BY c.relname, c.relrowsecurity
HAVING c.relrowsecurity = false OR count(p.polname) = 0
ORDER BY c.relname;

-- ============ QUERY 3: SECURITY DEFINER functions + who may execute ============
SELECT
  p.proname                                     AS function_name,
  pg_get_function_identity_arguments(p.oid)     AS args,
  p.prosecdef                                   AS security_definer,
  COALESCE(array_to_string(p.proconfig, ','), '') AS config,
  has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon_can_exec,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed_can_exec,
  pg_get_functiondef(p.oid) ~* 'org_members'    AS reads_org_members,
  pg_get_functiondef(p.oid) ~* '\mrole\M'       AS mentions_role
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
ORDER BY p.prosecdef DESC, p.proname;

-- ============ QUERY 4: role shape in the live org ============
SELECT org_id, role, count(*) AS members,
       count(*) FILTER (WHERE permissions <> '{}'::jsonb) AS with_permission_overrides
FROM org_members
GROUP BY org_id, role
ORDER BY org_id, role;

-- ============ QUERY 5: table-level grants (RLS is moot if a grant is missing/too wide) ============
SELECT table_name, grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND grantee IN ('anon','authenticated')
GROUP BY table_name, grantee
ORDER BY table_name, grantee;
