#!/usr/bin/env bash
# Drop + recreate the rls_rig schema, load the synthetic policy layer, then
# apply migration 119. Every later verification step starts from this clean state.
set -euo pipefail
D="docs/superpowers/plans/artifacts"
RIGX() { docker exec -i rls_rig psql -U postgres -d postgres "$@"; }

RIGX -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS auth CASCADE;" >/dev/null
RIGX -v ON_ERROR_STOP=1 -f - < "$D/synth_schema.sql" >/dev/null
RIGX -v ON_ERROR_STOP=1 -f - < supabase/migrations/119_role_scoped_write_rls.sql
echo "rig_load OK"
