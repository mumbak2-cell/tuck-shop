# Role-Scoped Write RLS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manager-role predicate to every INSERT/UPDATE/DELETE RLS policy a `member` account can currently abuse via PostgREST, without breaking a real cashier (`role='member'`) login.

**Architecture:** One SQL migration (`119_role_scoped_write_rls.sql`) adds a set-returning helper `current_user_manager_org_ids()` and rewrites write policies to append `AND org_id IN (SELECT current_user_manager_org_ids())`. The migration body is transcribed from a live `pg_policy` dump, not from reading old migrations. A local Supabase stack (Docker) is the dry-run rig for structural verification; runtime RLS behaviour is verified by the owner post-apply against production. A handful of small client-side role guards ship in the same PR so a blocked write shows a message, not a raw error.

**Tech Stack:** Supabase (Postgres 16), `supabase` CLI 2.109.1 + Docker, PostgREST, Next.js 16 / React 19 (client guards), no automated test suite (repo uses `npx tsc --noEmit` + `npm run lint` + `npm run build`).

**Spec:** `docs/superpowers/specs/2026-09-08-role-scoped-write-rls-design.md` — read it first; this plan argues from it.

## Global Constraints

- **Source of truth:** every table's bucket, real policy names, and verbatim current policy expressions come from a live `pg_policy` dump. Nothing is decided from reading migration files. The local dump (Task 1) drives authoring; the owner re-dumps **production** before apply and the plan's executor diffs the two (Task 15) — production may have manual drift.
- **No production DB changes by Claude.** The migration is written and PR'd; the owner applies it in the Supabase SQL Editor (project `pkufxpyrvcygobrgneep`) during a full closed day, then `npx supabase migration repair --status applied 119`.
- **`gh pr create` is classifier-blocked for Claude** — the owner runs the final `gh pr create` command (provided verbatim in the last task).
- **Shared working tree:** all work happens in `C:\26June\Dev\tilify`. Exactly one builder in the tree at a time; the parent session drives every `git checkout`. Branch: `security/role-scoped-write-rls` (already exists, spec v2 committed at `527c5d7`).
- **Explicit-path `git add` only** — never `-A` / `.` / `-a`. `git status --short` before every commit (sensitive untracked docs sit in the repo root).
- **Migration number is `119`.** Do not renumber the pre-existing `081`/`097` duplicates or the lone `20260819000000_*` file.
- **Helper `search_path = ''`**, every object schema-qualified (`public.org_members`, `auth.uid()`).
- **Member-write whitelist (Bucket B), frozen:** `customer_payments` (INSERT), `customers` (INSERT), `stock_counts` (INSERT/UPDATE/DELETE — unchanged), `shifts` (INSERT/UPDATE), `daily_reconciliation` (INSERT/UPDATE), `stock_count_audit` (INSERT). Every other command on every other org-scoped table gets the manager gate. Append-only ledgers (`stock_movements`, `stock_oversells`, `stock_transfers`, `production_log`) get **no** write policy.
- **Commit cadence:** commit after each task's deliverable is green. Commit messages end with the Co-Authored-By / Claude-Session trailer used on `527c5d7`.

---

## Local rig protocol (amended after Task 1 BLOCKED)

The local Supabase stack is a Postgres-only structural dry-run rig, **not** a
faithful prod replica. Two host facts and one migration-series defect force
this protocol; every task that runs `supabase` or `psql` follows it.

1. **Supabase CLI:** the npm `supabase` wrapper is broken on this host
   (`uv_spawn EUNKNOWN`). Use the legacy Go binary directly. Define once per
   shell:
   ```bash
   SB="./node_modules/@supabase/cli-windows-x64/bin/supabase-go.exe"
   ```
   Wherever a task step says `npx supabase X`, run `"$SB" X`.
2. **psql is not on PATH.** Wherever a task step says `psql "$LOCAL_DB" ...`,
   run it through the DB container:
   ```bash
   DBX(){ docker exec -i supabase_db_tilify psql -U postgres -d postgres "$@"; }
   ```
   (container name from `docker ps` — expected `supabase_db_tilify`). For
   `-f file.sql`, pipe it: `DBX < file.sql` or `docker exec -i supabase_db_tilify psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < file.sql`.
3. **Migrations `066` and `067` abort a fresh `supabase start` / `db reset`.**
   Both are tenant-specific one-shot **data** fixes (an `UPDATE products`
   markup backfill; an `app_settings.currency` fix for one org) guarded by a
   top-level `RAISE EXCEPTION` when `mariah.chilufya@gmail.com` owns no org —
   which is always true on a seedless local DB. They create **no** table,
   column, constraint, index, or policy, so the local `pg_policy` and
   column-presence state with them skipped is identical to a full apply.
   **Rig prep** — before every `supabase start` and every `db reset`:
   ```bash
   for n in 066_backfill_cost_prices_50pct_markup 067_fix_chichi_currency_zmw; do
     [ -f "supabase/migrations/$n.sql" ] && mv "supabase/migrations/$n.sql" "supabase/migrations/$n.sql.disabled"
   done
   ```
   **Rig restore** — as soon as the dumps / that reset's verification are
   captured, and unconditionally in Task 14:
   ```bash
   for n in 066_backfill_cost_prices_50pct_markup 067_fix_chichi_currency_zmw; do
     [ -f "supabase/migrations/$n.sql.disabled" ] && mv "supabase/migrations/$n.sql.disabled" "supabase/migrations/$n.sql"
   done
   git checkout -- supabase/migrations/  # belt-and-braces; the tracked .sql content was never edited
   ```
   `*.sql.disabled` is untracked scratch — never `git add` it; delete any
   stragglers in Task 14. The migration files' tracked content is never
   modified, only temporarily renamed on disk.
4. **Ruling (ledgered):** the local rig skips `066`/`067`; the **owner's
   production `pg_policy` dump remains the final authority** (Task 15
   checklist already diffs local vs prod). If `066`/`067` had a latent
   schema effect this misses — they don't, they are `UPDATE`-only — the
   Task 15 prod diff catches it. Cost if wrong: low.
5. `066`/`067` also mean **`supabase migration list --local` and
   `migration repair` are not used locally** — the CLI's migration ledger is
   irrelevant to this rig. `db reset` re-runs the on-disk `*.sql` set; that
   is the only mechanism this plan needs.

---

## File Structure

| Path | Responsibility |
|---|---|
| `supabase/migrations/119_role_scoped_write_rls.sql` | the migration — helper + Part 2 canonical blocks + Part 3 explicit blocks |
| `docs/superpowers/plans/artifacts/pg_policy_pre119.local.tsv` | local dump of `pg_policy` after migrations 001–118 (reference data) |
| `docs/superpowers/plans/artifacts/columns_pre119.local.tsv` | local dump of `org_id`/`location_id`/`recorded_by_user_id` column presence |
| `docs/superpowers/plans/artifacts/table-classification.md` | every public table → bucket, real policy names, verbatim current exprs, planned new expr |
| `docs/superpowers/plans/artifacts/client-guard-inventory.md` | member-reachable `src/` writes to Bucket A tables → guard needed / not |
| `docs/superpowers/plans/artifacts/verification.sql` | the 4 post-apply verification queries, runnable as-is |
| `docs/superpowers/plans/artifacts/rollback_119.sql` | the rollback block, generated from the dump |
| `docs/superpowers/plans/artifacts/PR_BODY.md` | PR description incl. rollback block + owner apply/verify checklist |
| `src/app/(dashboard)/sales/page.tsx` (+ others from Task 10) | client role guard on the reconciliation panel etc. |

---

## Task 1: Local Supabase rig + authoritative dumps

**Files:**
- Create: `docs/superpowers/plans/artifacts/pg_policy_pre119.local.tsv`
- Create: `docs/superpowers/plans/artifacts/columns_pre119.local.tsv`

**Interfaces:**
- Produces: the two `.tsv` dumps every later task reads. Column order for `pg_policy_pre119.local.tsv`: `tbl, polname, polcmd, polpermissive, roles, using_expr, check_expr`.

Follow the **Local rig protocol** section above. `SB` and `DBX` as defined there.

- [ ] **Step 1: Rig prep + start the local stack**

Run the rig-prep block (renames `066`/`067` aside), then:
`cd /c/26June/Dev/tilify && "$SB" start`
Expected: containers come up; prints `DB URL` (`postgresql://postgres:postgres@127.0.0.1:54322/postgres`). Migrations `001`–`118` (minus the two disabled) + `20260819000000_*` apply. If a **different** migration fails (not `066`/`067`), STOP and report — do not proceed with a partial schema.

- [ ] **Step 2: Confirm the DB is up and migrations ran**

Run: `docker ps --format '{{.Names}} {{.Status}}' | grep supabase_db_tilify` and `docker exec -i supabase_db_tilify psql -U postgres -d postgres -c "SELECT count(*) FROM pg_policy;"`
Expected: container healthy; policy count > 100.

- [ ] **Step 3: Dump `pg_policy`**

```bash
docker exec -i supabase_db_tilify psql -U postgres -d postgres -At -F $'\t' -c "
SELECT c.relname, p.polname, p.polcmd, p.polpermissive,
       (SELECT string_agg(r.rolname,',') FROM pg_roles r WHERE r.oid = ANY (p.polroles)),
       pg_get_expr(p.polqual, p.polrelid),
       pg_get_expr(p.polwithcheck, p.polrelid)
FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
WHERE c.relnamespace = 'public'::regnamespace
ORDER BY 1,3,2;" > docs/superpowers/plans/artifacts/pg_policy_pre119.local.tsv
```

- [ ] **Step 4: Dump column presence**

```bash
docker exec -i supabase_db_tilify psql -U postgres -d postgres -At -F $'\t' -c "
SELECT table_name, column_name FROM information_schema.columns
WHERE table_schema='public' AND column_name IN ('org_id','location_id','recorded_by_user_id')
ORDER BY 1,2;" > docs/superpowers/plans/artifacts/columns_pre119.local.tsv
```

- [ ] **Step 5: Rig restore + sanity-check the dumps**

Run the rig-restore block immediately (066/067 back in place). Then:
`wc -l docs/superpowers/plans/artifacts/*.local.tsv`
Expected: `pg_policy` dump has ~150–250 rows; `grep 'shifts' pg_policy_pre119.local.tsv` shows its real write-policy names; `grep 'shifts.*location_id' columns_pre119.local.tsv` returns a row (confirms spec open item). Record the `shifts` policy names + whether `location_id` is present in the report.
Also run `git status --short supabase/migrations/` — expected: **no changes** (the two `.sql` files restored, no `.sql.disabled` left).

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/plans/artifacts/pg_policy_pre119.local.tsv docs/superpowers/plans/artifacts/columns_pre119.local.tsv
git status --short   # verify ONLY the two artifacts staged, no migration files
git commit -m "Add local pg_policy + column dumps (pre-119 reference)

<trailer>"
```

---

## Task 2: Table classification

**Files:**
- Create: `docs/superpowers/plans/artifacts/table-classification.md`

**Interfaces:**
- Consumes: `pg_policy_pre119.local.tsv`, `columns_pre119.local.tsv` from Task 1.
- Produces: `table-classification.md` — the authoritative per-table spec every authoring task (3–8) transcribes from. One row per (table, command) with: real `polname`, current `using_expr`, current `check_expr`, bucket, planned new `polname` (usually same), planned new expr.

- [ ] **Step 1: Build the classification table**

For every distinct `tbl` in the dump, for `polcmd IN ('a','w','d','*')`, record the row(s). Assign a bucket using this decision order (stop at first match):

1. table in `{organizations, org_members, till_sessions, till_pin_attempts, period_locks, platform_admins, partners, referrals, commission_payouts, admin_org_overrides, invoice_events, audit_logs, wms_rpc_idempotency, partner_applications, product_stock, expenses}` → **C (untouched)**.
2. table in `{stock_movements, stock_oversells, stock_transfers, production_log}` → **C (append-only)**; assert the dump shows it has **no** `a`/`w`/`d` policy (only `r` or `*`-that-is-really-read). If it has a real write policy, STOP and report — the spec assumption is wrong.
3. table + command in the frozen Bucket B whitelist → **B**; the whitelisted command keeps its current expr verbatim, the non-whitelisted commands on that table get the gate.
4. `polcmd = '*'` (a `FOR ALL` policy) → **A / FOR-ALL-decompose**.
5. table has no `org_id` column (per column dump) → **A / child-table** (parent-scoped predicate).
6. else → **A / explicit block** (record the real `polname`; if it happens to be `<t>_org_<cmd>` and the expr is exactly `org_id IN (SELECT current_user_org_ids())` / `…writable…`, tag it **A / canonical** — eligible for the loop).

- [ ] **Step 2: For each Bucket A row, write the planned new expr**

`new_using = current_using + " AND org_id IN (SELECT current_user_manager_org_ids())"` (verbatim string append). Same for `new_check`. For child tables: `new_using = current_using` with the innermost `org_id IN (SELECT current_user_org_ids())` replaced by `org_id IN (SELECT current_user_manager_org_ids())` — quote the exact before/after string in the doc. For FOR-ALL decompose: list the 4 resulting policies (`<t>_org_read` FOR SELECT = old expr unchanged; `_org_insert/_update/_delete` = old expr + gate).

- [ ] **Step 3: Flag the `customer_payments` hardening decision**

Add a `## Decision: customer_payments hardening` section. Two options, recommend option A:
- **A (recommended, no schema change):** document residual risk — a member can insert any `customer_id`, any positive-or-not `amount`, backdated `payment_date`, unattributed. Accept for this phase; file a backlog item.
- **B:** add to migration 119 a `Part 0`: `ALTER TABLE public.customer_payments ADD COLUMN IF NOT EXISTS recorded_by_user_id uuid DEFAULT auth.uid()`, `ALTER … ADD CONSTRAINT customer_payments_amount_pos CHECK (amount > 0)`, and the INSERT policy gets `WITH CHECK (… AND (recorded_by_user_id IS NULL OR recorded_by_user_id = auth.uid()))`. Backfill left NULL (historical rows).

Leave the section marked **PENDING USER DECISION** — Task 3 does not start until it is resolved.

- [ ] **Step 4: Cross-check coverage**

List every `public` table with RLS enabled (`SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relrowsecurity` against the local DB). Every one must appear in `table-classification.md` in some bucket. Any table not classified → add it or STOP and report.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/artifacts/table-classification.md
git commit -m "Add role-scoped-write-rls table classification from live dump

<trailer>"
```

- [ ] **Step 6: Review gate**

STOP. Hand `table-classification.md` to the reviewer/user. Resolve the `customer_payments` decision. Do not proceed to Task 3 until both are approved.

---

## Task 3: Migration skeleton + helper function

**Files:**
- Create: `supabase/migrations/119_role_scoped_write_rls.sql`

**Interfaces:**
- Produces: `public.current_user_manager_org_ids() RETURNS SETOF uuid` — consumed by every policy in Tasks 4–8. The migration file's Part 1; Parts 2–8 are appended by later tasks.

- [ ] **Step 1: Write the verification query first**

Create `docs/superpowers/plans/artifacts/verification.sql` with query 1 (helper sanity), runnable now against local:
```sql
-- Q1 helper exists, is STABLE SECURITY DEFINER, search_path empty, correct ACL
SELECT proname, provolatile, prosecdef, proconfig,
       (SELECT string_agg(rolname,',') FROM pg_roles WHERE oid = ANY (
         (SELECT (aclexplode(proacl)).grantee FROM pg_proc WHERE proname='current_user_manager_org_ids')::oid[])) 
FROM pg_proc WHERE proname = 'current_user_manager_org_ids';
```
(If the ACL sub-select is awkward in your psql, substitute `SELECT proacl FROM pg_proc WHERE proname='current_user_manager_org_ids'` and eyeball it.)

- [ ] **Step 2: Run Q1 — expect zero rows**

Run: `psql "$LOCAL_DB" -f docs/superpowers/plans/artifacts/verification.sql`
Expected: 0 rows (function does not exist yet).

- [ ] **Step 3: Write the migration skeleton + helper**

```sql
-- ============================================================
-- Migration 119: Role-scoped write RLS
-- Spec: docs/superpowers/specs/2026-09-08-role-scoped-write-rls-design.md
-- Adds current_user_manager_org_ids() and gates INSERT/UPDATE/DELETE
-- policies across every org-scoped table on it, except the frozen
-- member-write whitelist. Reads unchanged. Body transcribed from
-- artifacts/table-classification.md.
--
-- Apply: Supabase SQL Editor, closed day. Then:
--   npx supabase migration repair --status applied 119
-- Rollback: artifacts/rollback_119.sql
-- ============================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ---- Part 1: helper --------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_user_manager_org_ids()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT m.org_id
  FROM public.org_members m
  WHERE m.user_id = auth.uid()
    AND m.role IN ('owner','admin');
$$;
REVOKE EXECUTE ON FUNCTION public.current_user_manager_org_ids() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.current_user_manager_org_ids() TO authenticated;

-- ---- Part 2: canonical Bucket A blocks (Task 4) --------------------
-- ---- Part 3: _loc_/bare/plp_ blocks (Task 5) ---------------------
-- ---- Part 4: FOR ALL decompose (Task 6) --------------------------
-- ---- Part 5: child tables (Task 7) ------------------------------
-- ---- Part 6: Bucket B (Task 8) --------------------------------

COMMIT;
```

- [ ] **Step 4: Apply locally**

Run: `psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/migrations/119_role_scoped_write_rls.sql`
Expected: `BEGIN … CREATE FUNCTION … REVOKE … GRANT … COMMIT`, no error.

- [ ] **Step 5: Run Q1 — expect one row, correct attributes**

Run: `psql "$LOCAL_DB" -f docs/superpowers/plans/artifacts/verification.sql`
Expected: 1 row: `provolatile = s` (STABLE), `prosecdef = t`, `proconfig = {search_path=""}`, ACL grants `authenticated` and not `anon`/`PUBLIC`.

- [ ] **Step 6: Reset local DB to a clean pre-119 state for the next task**

Run: `npx supabase db reset` (re-applies 001–118 only, since 119 is not yet in a state the CLI tracks — confirm `migration list --local` shows 119 absent). If `db reset` picks up 119 as a file, temporarily move it out, reset, move it back — the local rig must start each authoring task at pre-119.
Note for executor: simpler alternative — keep a SQL script `artifacts/_local_apply_119_sofar.sql` that is just Parts 1..N written so far, and after each `db reset` run it to reach "pre-next-part" state.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/119_role_scoped_write_rls.sql docs/superpowers/plans/artifacts/verification.sql
git commit -m "119: migration skeleton + current_user_manager_org_ids() helper

<trailer>"
```

---

## Task 4: Canonical Bucket A blocks

**Files:**
- Modify: `supabase/migrations/119_role_scoped_write_rls.sql` (Part 2)
- Modify: `docs/superpowers/plans/artifacts/verification.sql` (add Q2, Q3)

**Interfaces:**
- Consumes: `current_user_manager_org_ids()` (Task 3); the `A / canonical` and `A / explicit block` rows of `table-classification.md` (Task 2).
- Produces: gated `_insert/_update/_delete` policies for every canonical + simple-explicit Bucket A table.

- [ ] **Step 1: Add Q2 (coverage) and Q3 (expr-diff) to verification.sql**

```sql
-- Q2 coverage: every A-table IUD policy must reference the helper in the right clause.
-- Params: :atables = comma-less quoted list built from table-classification.md Bucket A.
WITH a_tables(t) AS (VALUES ('products'),('ingredients') /* …full Bucket A list… */ )
SELECT c.relname, p.polname, p.polcmd
FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
JOIN a_tables ON a_tables.t = c.relname
WHERE p.polcmd IN ('a','w','d')
  AND CASE p.polcmd
        WHEN 'a' THEN COALESCE(pg_get_expr(p.polwithcheck,p.polrelid),'') NOT LIKE '%current_user_manager_org_ids%'
        WHEN 'w' THEN COALESCE(pg_get_expr(p.polqual,p.polrelid),'')      NOT LIKE '%current_user_manager_org_ids%'
                  OR  COALESCE(pg_get_expr(p.polwithcheck,p.polrelid),'') NOT LIKE '%current_user_manager_org_ids%'
        WHEN 'd' THEN COALESCE(pg_get_expr(p.polqual,p.polrelid),'')      NOT LIKE '%current_user_manager_org_ids%'
      END;
-- Expected after full migration: 0 rows.

-- Q3 expr-diff: dump post-119 pg_policy the same way as Task 1 and diff.
-- (run as a shell step, not SQL — see Step 5)
```

- [ ] **Step 2: Run Q2 against pre-119 local — expect many rows**

Every Bucket A table listed (gate absent everywhere). Record the count.

- [ ] **Step 3: Write Part 2 of the migration**

For each `A / canonical` and simple `A / explicit block` table in `table-classification.md`, emit exactly three statements, using the **verbatim current expression** from the classification doc:

```sql
DROP POLICY IF EXISTS "<real insert polname>" ON public.<t>;
CREATE POLICY "<real insert polname>" ON public.<t> FOR INSERT
  WITH CHECK (<verbatim current check_expr> AND org_id IN (SELECT current_user_manager_org_ids()));

DROP POLICY IF EXISTS "<real update polname>" ON public.<t>;
CREATE POLICY "<real update polname>" ON public.<t> FOR UPDATE
  USING      (<verbatim current using_expr>  AND org_id IN (SELECT current_user_manager_org_ids()))
  WITH CHECK (<verbatim current check_expr>  AND org_id IN (SELECT current_user_manager_org_ids()));

DROP POLICY IF EXISTS "<real delete polname>" ON public.<t>;
CREATE POLICY "<real delete polname>" ON public.<t> FOR DELETE
  USING (<verbatim current using_expr> AND org_id IN (SELECT current_user_manager_org_ids()));
```

Do **not** normalise `current_user_org_ids()` ↔ `current_user_writable_org_ids()` — copy whatever the table uses per command.

- [ ] **Step 4: Apply locally & run Q2**

Run: `npx supabase db reset && psql "$LOCAL_DB" -v ON_ERROR_STOP=1 -f supabase/migrations/119_role_scoped_write_rls.sql`
Expected: applies clean.
Run Q2. Expected: the Part-2 tables have dropped out of the result; only not-yet-done buckets (FOR ALL, child, `_loc_` not in this task) remain.

- [ ] **Step 5: Run Q3 expr-diff**

```bash
psql "$LOCAL_DB" -At -F $'\t' -c "<same SELECT as Task 1 Step 3>" > /tmp/pg_policy_post119.tsv
# For each Part-2 table, assert new expr == old expr + ' AND org_id IN (SELECT current_user_manager_org_ids())'
python - <<'EOF'
# load both tsvs, join on (tbl,polcmd) for Part-2 tables, assert the only delta is the appended clause
EOF
```
Expected: for every Part-2 policy, the sole difference is the appended gate. Any other delta → fix the block (you copied the expr wrong).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/119_role_scoped_write_rls.sql docs/superpowers/plans/artifacts/verification.sql
git commit -m "119 Part 2: gate canonical Bucket A write policies

<trailer>"
```

---

## Task 5: `_loc_*` / bare-named / `plp_*` explicit blocks

**Files:**
- Modify: `supabase/migrations/119_role_scoped_write_rls.sql` (Part 3)

**Interfaces:**
- Consumes: `current_user_manager_org_ids()`; the `A / explicit block` rows whose real policy names are `<t>_loc_*`, bare `<t>_insert/_update/_delete`, or `plp_*` (from `table-classification.md`).
- Produces: gated write policies for `sales, stock_adjustments, balance_adjustments, combos, promotion_items, purchase_orders, purchase_order_items, location_settings, report_subscriptions, product_location_prices` (final list per classification doc).

- [ ] **Step 1: Note the `sales` special case**

`table-classification.md` will show whether `sales_loc_update` / `sales_loc_delete` still exist (mig 078's DROP was likely a no-op). If they exist: this task DROPs them and does **not** recreate them (078's intent was full removal — members and managers mutate sales only via `void_sale_lines` / `submit_sale_batch` DEFINER RPCs). If the classification shows they're already gone, no statement for those two. `sales` INSERT: keep a manager-gated policy (per spec Q4).

- [ ] **Step 2: Write Part 3**

Same three-statement shape as Task 4 Step 3, but the policy names are the **real `_loc_*` / bare / `plp_*` names** from the classification doc, and the current exprs carry their location / extra clauses — copy them verbatim, append the gate. Example (`stock_adjustments`, real names `stock_adjustments_loc_*`):

```sql
DROP POLICY IF EXISTS "stock_adjustments_loc_insert" ON public.stock_adjustments;
CREATE POLICY "stock_adjustments_loc_insert" ON public.stock_adjustments FOR INSERT
  WITH CHECK (<verbatim current check_expr, incl. location_id clause> AND org_id IN (SELECT current_user_manager_org_ids()));
-- _loc_update, _loc_delete likewise
```

- [ ] **Step 3: Apply locally, run Q2 + Q3**

Run: `npx supabase db reset && psql "$LOCAL_DB" -v ON_ERROR_STOP=1 -f supabase/migrations/119_role_scoped_write_rls.sql`
Q2 expected: Part-3 tables now gone from the result. `sales` — if its `_loc_update/_delete` were dropped, Q2's "policy exists but lacks gate" won't fire for them (they don't exist); add a one-off assert that `sales` has no `w`/`d` policy.
Q3 expected: Part-3 policies differ from pre-119 only by the appended clause (and for `sales` update/delete, they're absent — expected).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/119_role_scoped_write_rls.sql
git commit -m "119 Part 3: gate _loc_/bare-named/plp_ write policies; drop residual sales mutate policies

<trailer>"
```

---

## Task 6: `FOR ALL` decompose (WMS + `zra_*`)

**Files:**
- Modify: `supabase/migrations/119_role_scoped_write_rls.sql` (Part 4)

**Interfaces:**
- Consumes: `current_user_manager_org_ids()`; the `A / FOR-ALL-decompose` rows.
- Produces: for each such table, one `FOR SELECT` policy (member read preserved) + three gated write policies, replacing the single `FOR ALL` policy.

- [ ] **Step 1: For each FOR-ALL table, transcribe from the classification doc**

```sql
DROP POLICY IF EXISTS "<real FOR ALL polname>" ON public.<t>;

CREATE POLICY "<t>_org_read" ON public.<t> FOR SELECT
  USING (<verbatim old FOR ALL using_expr>);

CREATE POLICY "<t>_org_insert" ON public.<t> FOR INSERT
  WITH CHECK (<verbatim old using_expr or check_expr> AND org_id IN (SELECT current_user_manager_org_ids()));

CREATE POLICY "<t>_org_update" ON public.<t> FOR UPDATE
  USING      (<verbatim old using_expr> AND org_id IN (SELECT current_user_manager_org_ids()))
  WITH CHECK (<verbatim old using_expr> AND org_id IN (SELECT current_user_manager_org_ids()));

CREATE POLICY "<t>_org_delete" ON public.<t> FOR DELETE
  USING (<verbatim old using_expr> AND org_id IN (SELECT current_user_manager_org_ids()));
```

Note: a `FOR ALL` policy usually has only `polqual` (USING), no `polwithcheck` — PG applies `polqual` as the check for writes. Use `polqual` as the source for all four.

- [ ] **Step 2: Apply locally, verify member read is preserved**

Run: `npx supabase db reset && psql "$LOCAL_DB" -v ON_ERROR_STOP=1 -f …119….sql`
Add Q4 to `verification.sql`:
```sql
-- Q4: every FOR-ALL-decompose table now has exactly 4 policies (r,a,w,d) and the SELECT one has NO gate.
WITH forall_tables(t) AS (VALUES ('wms_inventory') /* … */ )
SELECT c.relname, count(*) FILTER (WHERE p.polcmd='r') AS n_read,
       bool_or(p.polcmd='r' AND pg_get_expr(p.polqual,p.polrelid) LIKE '%current_user_manager_org_ids%') AS read_wrongly_gated,
       count(*) FILTER (WHERE p.polcmd IN ('a','w','d')) AS n_write
FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN forall_tables ON forall_tables.t=c.relname
GROUP BY 1;
-- Expected: n_read=1, read_wrongly_gated=false, n_write=3, for every row.
```
Run Q4. Expected as noted. Run Q2 — FOR-ALL tables now clean.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/119_role_scoped_write_rls.sql docs/superpowers/plans/artifacts/verification.sql
git commit -m "119 Part 4: decompose FOR ALL policies (WMS, zra) into gated SELECT+IUD

<trailer>"
```

---

## Task 7: Child-table parent-scoped blocks

**Files:**
- Modify: `supabase/migrations/119_role_scoped_write_rls.sql` (Part 5)

**Interfaces:**
- Consumes: `current_user_manager_org_ids()`; the `A / child-table` rows (no `org_id` column).
- Produces: gated write policies for `combo_items`, `promotion_items` (if no `org_id`), `purchase_order_items`, and any WMS `*_items` without `org_id`.

- [ ] **Step 1: Transcribe, replacing the inner org check**

The current child policy looks like
`… IN (SELECT id FROM <parent> WHERE org_id IN (SELECT current_user_org_ids()))`.
The classification doc has the exact string. Emit:

```sql
DROP POLICY IF EXISTS "<real child insert polname>" ON public.<child>;
CREATE POLICY "<real child insert polname>" ON public.<child> FOR INSERT
  WITH CHECK (<child>_<fk> IN (SELECT id FROM public.<parent>
              WHERE org_id IN (SELECT current_user_manager_org_ids())));
-- update (USING+CHECK), delete (USING) likewise
```

If a child command has **no** existing policy today (e.g. `promotion_items` UPDATE), do **not** create one — match the current surface. The classification doc records which commands exist.

- [ ] **Step 2: Apply locally**

Run: `npx supabase db reset && psql "$LOCAL_DB" -v ON_ERROR_STOP=1 -f …119….sql`
Expected: clean apply (this is the step that would have thrown `column "org_id" does not exist` under the v1 loop — confirm it doesn't).
Run Q2 (child tables use a parent subquery referencing the helper — Q2's `LIKE '%current_user_manager_org_ids%'` still matches). Expected: child tables clean.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/119_role_scoped_write_rls.sql
git commit -m "119 Part 5: parent-scope-gate child-item write policies

<trailer>"
```

---

## Task 8: Bucket B blocks

**Files:**
- Modify: `supabase/migrations/119_role_scoped_write_rls.sql` (Part 6)

**Interfaces:**
- Consumes: `current_user_manager_org_ids()`; the Bucket B rows.
- Produces: for `customer_payments`, `customers` — INSERT kept verbatim (member-allowed), UPDATE/DELETE gated. For `shifts` — INSERT/UPDATE kept verbatim, DELETE gated. For `daily_reconciliation` — INSERT/UPDATE kept verbatim, DELETE gated. For `stock_count_audit` — INSERT kept verbatim, UPDATE/DELETE gated (if they exist). For `stock_counts` — nothing, unless the classification doc flags drift.

- [ ] **Step 1: Write Part 6**

For each whitelisted (table, command): a `DROP POLICY IF EXISTS "<real name>"` + `CREATE POLICY "<real name>" … (<verbatim current expr>)` with **no gate appended** — this re-asserts the policy unchanged so the migration is self-documenting about what a member keeps. For the gated commands on the same table: current expr + gate, as in Task 4.

If Task 2 Step 3 resolved `customer_payments` hardening to **option B**, add the `ALTER TABLE` + constraint as `Part 0` immediately after `SET LOCAL …`, and the `customer_payments` INSERT policy gets the extra `recorded_by_user_id` clause.

- [ ] **Step 2: Apply locally — full migration now complete**

Run: `npx supabase db reset && psql "$LOCAL_DB" -v ON_ERROR_STOP=1 -f supabase/migrations/119_role_scoped_write_rls.sql`
Expected: clean apply end to end.

- [ ] **Step 3: Run the full verification suite**

Run: `psql "$LOCAL_DB" -f docs/superpowers/plans/artifacts/verification.sql`
Expected:
- Q1: helper correct.
- Q2: **0 rows** (every Bucket A IUD policy gated in the right clause).
- Q3 (shell diff): every touched policy differs from pre-119 by exactly the appended gate, OR is an intentional drop (`sales` mutate), OR is a FOR-ALL decompose result.
- Q4: FOR-ALL tables have 1 ungated read + 3 gated writes.
- Add Q5: `SELECT c.relname, p.polcmd FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid WHERE c.relname IN ('stock_movements','stock_oversells','stock_transfers','production_log') AND p.polcmd IN ('a','w','d');` → **0 rows** (no write policy added to append-only ledgers).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/119_role_scoped_write_rls.sql docs/superpowers/plans/artifacts/verification.sql
git commit -m "119 Part 6: Bucket B — keep member INSERT paths, gate the rest

<trailer>"
```

---

## Task 9: Full-migration idempotency + integration dry run

**Files:**
- Modify: `docs/superpowers/plans/artifacts/verification.sql` (freeze final form)

- [ ] **Step 1: Re-run the migration on an already-migrated DB (idempotency)**

Run: `psql "$LOCAL_DB" -v ON_ERROR_STOP=1 -f supabase/migrations/119_role_scoped_write_rls.sql` (a second time, no reset).
Expected: clean — every `DROP POLICY IF EXISTS` + `CREATE` re-runs, `CREATE OR REPLACE FUNCTION` re-runs. No "policy already exists" error.

- [ ] **Step 2: Full reset + apply + full verification, capture output**

Run: `npx supabase db reset && psql "$LOCAL_DB" -v ON_ERROR_STOP=1 -f supabase/migrations/119_role_scoped_write_rls.sql && psql "$LOCAL_DB" -f docs/superpowers/plans/artifacts/verification.sql | tee docs/superpowers/plans/artifacts/verification_local_output.txt`
Expected: Q2 = 0 rows, Q5 = 0 rows, Q4 all-pass, Q1 correct.

- [ ] **Step 3: Minimal RLS behaviour probe (local, seeded)**

```sql
-- seed two orgs, one owner, one member; set role + JWT claims via set_config
-- then, as the member, attempt an INSERT into products (expect failure) and
-- into customer_payments (expect success). Full script in this step:
BEGIN;
INSERT INTO auth.users (id,email) VALUES ('00000000-0000-0000-0000-0000000000aa','o@x.test'),('00000000-0000-0000-0000-0000000000bb','m@x.test');
INSERT INTO public.organizations (id,name,slug) VALUES ('00000000-0000-0000-0000-00000000000c','T','t-probe');
INSERT INTO public.org_members (org_id,user_id,role) VALUES
  ('00000000-0000-0000-0000-00000000000c','00000000-0000-0000-0000-0000000000aa','owner'),
  ('00000000-0000-0000-0000-00000000000c','00000000-0000-0000-0000-0000000000bb','member');
COMMIT;
-- impersonate the member
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000bb","role":"authenticated"}';
SET ROLE authenticated;
-- expect: ERROR new row violates row-level security policy for table "products"
INSERT INTO public.products (org_id,name,selling_price) VALUES ('00000000-0000-0000-0000-00000000000c','probe',1);
-- expect: success
INSERT INTO public.customer_payments (org_id,amount) VALUES ('00000000-0000-0000-0000-00000000000c',5);
RESET ROLE;
```
Expected: the `products` insert raises the RLS error; the `customer_payments` insert succeeds. If `products` succeeds, the gate is not effective — STOP.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/artifacts/verification.sql docs/superpowers/plans/artifacts/verification_local_output.txt
git commit -m "119: idempotency + integration dry run green (local)

<trailer>"
```

---

## Task 10: Client guard inventory

**Files:**
- Create: `docs/superpowers/plans/artifacts/client-guard-inventory.md`

**Interfaces:**
- Consumes: `table-classification.md`.
- Produces: the list of `src/` sites that write a Bucket A table and are reachable by a `role='member'` session — each marked `guard needed` (with file:line + the role check to add) or `already gated`.

- [ ] **Step 1: Grep every client write**

Run (repeat per Bucket A table, and handle multi-line):
```bash
rg -nU --type ts --type tsx '\.from\(\s*["'"'"']<table>["'"'"']\s*\)\s*\.\s*(insert|update|delete|upsert)' src/
```
Also check `src/lib/offline-ops.ts` replay handlers and any `insertOrQueue({table:"<A-table>"})` call sites.

- [ ] **Step 2: For each hit, determine member reachability**

Trace the containing screen/route. Is it in the cashier nav (`src/components/layout/sidebar.tsx` `roles` arrays)? Does the component/render path have a `role`/`can()` guard already? Record file:line, the screen, reachable-by-member (Y/N), guard-exists (Y/N).

- [ ] **Step 3: Write the inventory**

Known starting points (verify, don't trust): `/sales` Till Reconciliation panel (`src/app/(dashboard)/sales/page.tsx` ~line 313 `saveRecon`, panel renders with no role gate ~line 935) writes `daily_reconciliation` — but `daily_reconciliation` is Bucket B (member INSERT/UPDATE allowed), so **no guard needed**. Re-confirm against the frozen whitelist: a guard is needed only where a member-reachable screen writes a table whose command is **manager-gated**. Expect the true list to be short or empty.

- [ ] **Step 4: Commit + review gate**

```bash
git add docs/superpowers/plans/artifacts/client-guard-inventory.md
git commit -m "Add client guard inventory for role-scoped write RLS

<trailer>"
```
STOP. If the inventory lists any `guard needed` site, the reviewer/user approves the guard approach before Task 11. If the list is empty, note that and skip Tasks 11–12.

---

## Task 11: Client guards (only if Task 10 found any)

**Files:**
- Modify: each `guard needed` file from `client-guard-inventory.md`

**Interfaces:**
- Consumes: `client-guard-inventory.md`.
- Produces: each listed screen shows a disabled control or a clear "Ask a manager" message instead of calling the write; no behavioural change for owner/admin.

- [ ] **Step 1: For each site, add the guard following the repo's existing pattern**

Use the same `role` / `useOrg().can(...)` check the codebase already uses on manager-only screens (find one with `rg -n "role !== \"admin\"|can\(" src/app/(dashboard)`). Gate the button/handler, not just the render. Match surrounding style.

- [ ] **Step 2: Typecheck + lint + build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all clean (pre-existing unrelated lint errors in files you didn't touch are out of scope — note them, don't fix).

- [ ] **Step 3: Browser-verify one guard**

Per `mkglobal_verification_practices` / `tilify_dev_reference`: `npm run dev` (port 3001), hard-reload, and with `sessionStorage.tilify_auth` cleared to force the PIN pad — actually, a real `member` session is needed to see the guard fire. If a throwaway member account exists from Task 9's planning, log in as it and confirm the guarded control is disabled. Otherwise, verify the owner path is unchanged (control still works) and leave the member-path check to the owner's Task 15 runtime test.

- [ ] **Step 4: Commit**

```bash
git add <the guard files>
git commit -m "Guard <screen(s)> for cashier accounts under role-scoped write RLS

<trailer>"
```

---

## Task 12: Rollback script

**Files:**
- Create: `docs/superpowers/plans/artifacts/rollback_119.sql`

**Interfaces:**
- Consumes: `pg_policy_pre119.local.tsv` (Task 1).
- Produces: a script that returns `pg_policy` for every touched table to its exact pre-119 state and drops the helper.

- [ ] **Step 1: Generate from the dump**

For every policy the migration `DROP`s or `CREATE`s (enumerate from `119_role_scoped_write_rls.sql`), emit:
```sql
DROP POLICY IF EXISTS "<current/new name>" ON public.<t>;
```
then, for every row in `pg_policy_pre119.local.tsv` belonging to a touched table:
```sql
CREATE POLICY "<pre119 polname>" ON public.<t> FOR <cmd from polcmd>
  [USING (<pre119 using_expr>)] [WITH CHECK (<pre119 check_expr>)];
```
Wrap in `BEGIN; SET LOCAL lock_timeout='5s'; … DROP FUNCTION IF EXISTS public.current_user_manager_org_ids(); COMMIT;`.
`polcmd` map: `r`→`FOR SELECT` (USING only), `a`→`FOR INSERT` (WITH CHECK only), `w`→`FOR UPDATE` (USING + WITH CHECK), `d`→`FOR DELETE` (USING only), `*`→`FOR ALL` (USING only).

- [ ] **Step 2: Dry-run the rollback locally**

Run:
```bash
npx supabase db reset \
 && psql "$LOCAL_DB" -v ON_ERROR_STOP=1 -f supabase/migrations/119_role_scoped_write_rls.sql \
 && psql "$LOCAL_DB" -v ON_ERROR_STOP=1 -f docs/superpowers/plans/artifacts/rollback_119.sql \
 && psql "$LOCAL_DB" -At -F $'\t' -c "<Task 1 Step 3 SELECT>" > /tmp/pg_policy_after_rollback.tsv \
 && diff <(sort docs/superpowers/plans/artifacts/pg_policy_pre119.local.tsv) <(sort /tmp/pg_policy_after_rollback.tsv)
```
Expected: `diff` is empty — post-rollback policy state is byte-identical to pre-119. Any difference → fix `rollback_119.sql`.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/artifacts/rollback_119.sql
git commit -m "119: rollback script (restores exact pre-119 policy state)

<trailer>"
```

---

## Task 13: PR body + owner checklist

**Files:**
- Create: `docs/superpowers/plans/artifacts/PR_BODY.md`

- [ ] **Step 1: Assemble PR_BODY.md**

Sections:
- **What / why** — 3 sentences from the spec's Problem + Goal.
- **Deployment models** — one paragraph: Model 1 unaffected; Model 2 is what this protects and what the whitelist preserves.
- **Scope** — link the spec + this plan + `table-classification.md`.
- **Local verification** — paste `verification_local_output.txt` highlights (Q2=0, Q5=0, Q4 pass, behaviour probe pass).
- **Owner apply checklist** (closed day):
  1. Re-run the two dump queries from the spec against **prod**; `diff` against `pg_policy_pre119.local.tsv`. If prod has drift on a touched table, STOP and ping — the migration/rollback may need a tweak.
  2. Paste `supabase/migrations/119_role_scoped_write_rls.sql` into the SQL Editor, run.
  3. Run `docs/superpowers/plans/artifacts/verification.sql`; confirm Q2=0, Q5=0, Q4 pass, Q1 correct.
  4. Impersonation checks: helper returns non-empty for a known admin, empty for a known member; `SELECT DISTINCT role FROM org_members` = `{owner,admin,member}`.
  5. `npx supabase migration repair --status applied 119`.
  6. Runtime test with a throwaway `member` account — the list from the spec's "Runtime (mandatory)" section.
  7. First trading day: grep PostgREST logs / `pg_stat_statements` for `42501` spikes.
  8. If anything fails: run `docs/superpowers/plans/artifacts/rollback_119.sql`, then `migration repair --status reverted 119`.
- **Rollback block** — inline the full `rollback_119.sql`.
- Trailer: `🤖 Generated with [Claude Code](https://claude.com/claude-code)` + session URL.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/plans/artifacts/PR_BODY.md
git commit -m "Add PR body + owner apply/verify checklist for migration 119

<trailer>"
```

---

## Task 14: Stop local stack, push, hand off PR

- [ ] **Step 1: Stop the local stack**

Run: `npx supabase stop`
Expected: containers down. (Local dumps stay committed as reference.)

- [ ] **Step 2: Final tree check**

Run: `git status --short && git log --oneline main..HEAD`
Expected: working tree clean except the pre-existing `CLAUDE.md` / untracked root docs noted in Global Constraints; commit list = spec v1, spec v2, then Tasks 1–13.

- [ ] **Step 3: Push**

Run: `git push -u origin security/role-scoped-write-rls`

- [ ] **Step 4: Hand the PR command to the owner**

`gh pr create` is classifier-blocked for Claude. Output this for the owner to run with `!`:
```
! cd /c/26June/Dev/tilify && gh pr create --repo mumbak2-cell/tuck-shop --base main --head security/role-scoped-write-rls --title "Security Phase 2: role-scoped write RLS (migration 119)" --body-file docs/superpowers/plans/artifacts/PR_BODY.md
```

- [ ] **Step 5: Update memory**

Append to `tilify_security_audit_2026_09_04.md`: Phase 2 status → PR open, migration 119 written + locally dry-run + rollback verified, awaiting owner prod-apply during closed hours. Note the local-Supabase dry-run rig and the `pg_policy` dump artifacts location.

---

## Task 15: Owner apply (out of band — not a Claude task)

Documented in `PR_BODY.md` Step "Owner apply checklist". The owner runs it during a closed day. If drift or a runtime failure surfaces, reopen this plan at Task 2 (re-classify from the prod dump) or Task 5/6/7 (fix the affected block).

---

## Self-Review

**Spec coverage:**
- Helper `current_user_manager_org_ids()` + `search_path=''` → Task 3. ✓
- Dump-driven body → Tasks 1, 2 (+ every authoring task transcribes from `table-classification.md`). ✓
- Canonical loop / explicit blocks split → Tasks 4 (canonical), 5 (`_loc_`/bare/`plp_`), 6 (FOR ALL), 7 (child). ✓
- Bucket B whitelist incl. `shifts`/`daily_reconciliation`/`stock_count_audit` → Task 8. ✓
- Append-only ledgers excluded + asserted → Task 2 Step 1 rule 2, Task 8 Step 3 Q5. ✓
- `sales` residual mutate policies dropped → Task 5 Step 1. ✓
- `report_subscriptions` gated → Task 5 (bare-named list). ✓
- `customer_payments` hardening decision → Task 2 Step 3 (review gate). ✓
- Client guards → Tasks 10–11. ✓
- Rollback from dump → Task 12. ✓
- Verification: per-column gate (Q2), per-table expr diff (Q3), FOR-ALL read preserved (Q4), no new ledger surface (Q5), behaviour probe (Task 9 Step 3), owner runtime test (Task 13 checklist). ✓
- `lock_timeout`/`statement_timeout` → Task 3 Step 3. ✓
- Migration number 119, no renumbering → Global Constraints. ✓
- Sibling-helper `search_path` follow-up → noted in spec; Task 14 Step 5 memory note carries it.

**Placeholder scan:** `<real … polname>`, `<verbatim current … expr>`, `/* …full Bucket A list… */` are deliberate — they are transcription slots filled from `table-classification.md`, which is itself a task deliverable with a review gate (Task 2 Step 6). Every such slot has an explicit source. No "add error handling" / "similar to Task N" / bare TODO.

**Type consistency:** helper name `current_user_manager_org_ids()` used identically in Tasks 3–8, 12. Verification query names Q1–Q5 consistent across Tasks 3, 4, 6, 8, 9. Artifact paths consistent with the File Structure table.

**Gap accepted:** no TDD red/green on the client guards beyond `tsc`/`lint`/`build` + one manual check — the repo has no component test harness; this matches repo convention.
