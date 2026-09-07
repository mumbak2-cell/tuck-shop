-- Tilify Phase 2 ground truth, v2. READ ONLY.
-- Supabase SQL Editor returns ONLY the last statement's result.
-- Run ONE query at a time. Download each as CSV with the filename shown.

-- ####################################################################
-- QUERY 1  ->  save as .agents/p2-policies.csv
-- ####################################################################
SELECT
  c.relname                               AS table_name,
  c.relrowsecurity                        AS rls_enabled,
  p.polname                               AS policy_name,
  CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
                WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE'
                WHEN '*' THEN 'ALL' END   AS command,
  (SELECT string_agg(r.rolname, '+' ORDER BY r.rolname)
     FROM pg_roles r WHERE r.oid = ANY(p.polroles)) AS applies_to_roles,
  pg_get_expr(p.polqual,      p.polrelid) AS using_expr,
  pg_get_expr(p.polwithcheck, p.polrelid) AS with_check_expr
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policy p ON p.polrelid = c.oid
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY c.relname, command, p.polname;

-- ####################################################################
-- QUERY 2  ->  save as .agents/p2-unprotected.csv
-- Tables with RLS off, or RLS on but zero policies.
-- ####################################################################
SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled,
       count(p.polname) AS policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policy p ON p.polrelid = c.oid
WHERE n.nspname = 'public' AND c.relkind = 'r'
GROUP BY c.relname, c.relrowsecurity
HAVING c.relrowsecurity = false OR count(p.polname) = 0
ORDER BY c.relname;

-- ####################################################################
-- QUERY 3  ->  save as .agents/p2-functions.csv
-- ####################################################################
SELECT
  p.proname                                   AS function_name,
  pg_get_function_identity_arguments(p.oid)   AS args,
  p.prosecdef                                 AS security_definer,
  COALESCE(array_to_string(p.proconfig, ','), '') AS config,
  has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon_can_exec,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed_can_exec,
  pg_get_functiondef(p.oid) ~* 'org_members'  AS reads_org_members,
  pg_get_functiondef(p.oid) ~* '\mrole\M'     AS mentions_role
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prokind = 'f'
ORDER BY p.prosecdef DESC, p.proname;

-- ####################################################################
-- QUERY 4  ->  paste inline, it is a handful of rows
-- ####################################################################
SELECT o.name AS org, m.role, count(*) AS members,
       count(*) FILTER (WHERE m.permissions <> '{}'::jsonb) AS with_perm_overrides
FROM org_members m JOIN organizations o ON o.id = m.org_id
GROUP BY o.name, m.role
ORDER BY o.name, m.role;

-- ####################################################################
-- QUERY 6  ->  paste inline. VIEWS: does each honour RLS?
-- security_invoker=off (the default) means the view runs as its OWNER
-- and BYPASSES RLS on every table it reads.
-- ####################################################################
SELECT
  c.relname AS view_name,
  pg_get_userbyid(c.relowner) AS owner,
  COALESCE(
    (SELECT option_value FROM pg_options_to_table(c.reloptions)
      WHERE option_name = 'security_invoker'), 'off (DEFAULT - BYPASSES RLS)'
  ) AS security_invoker,
  has_table_privilege('anon',          c.oid, 'SELECT') AS anon_can_select,
  has_table_privilege('authenticated', c.oid, 'SELECT') AS authed_can_select
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('v','m')
ORDER BY security_invoker, c.relname;
