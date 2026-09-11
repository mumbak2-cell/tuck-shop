# SECURITY DEFINER RPC role guards — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the role-check gap on SECURITY DEFINER RPCs that migrations 119-121 (table RLS) don't reach — 18 WMS write RPCs + `record_wms_adjustment` get an owner/admin-only guard, `void_sale_lines` gets a `void_sales`-permission guard, `submit_sale_batch` gets a cashier-own-branch guard.

**Architecture:** Two new SQL helper functions (`assert_org_manager`, `assert_org_permission`), each a one-line delegate to existing role/permission lookups. Every target RPC gets exactly one `PERFORM` line added to its existing body, inserted next to the `assert_org_writable` call it already has. No signatures change, no frontend code changes.

**Tech Stack:** PostgreSQL (Supabase), applied by hand via SQL Editor. No ORM, no migration-runner CI — `supabase migration repair` records history after manual apply.

**Spec:** `docs/superpowers/specs/2026-09-11-definer-rpc-role-guards-design.md`

## Global Constraints

- Never `supabase db push` — every migration is applied by hand in the SQL Editor, then recorded with `npx supabase migration repair --status applied <NNN>` (repo CLAUDE.md, Migrations section).
- Never apply a migration, GRANT, or policy change while shops are trading. PRs and reviews any time (`tilify-security-review` guardrails).
- Every migration file must be idempotent and runnable statement-by-statement — the SQL Editor rolls back the whole script on any failure, and may not share a connection across statements within one paste (repo CLAUDE.md, Migrations section). Mark files with `-- STATEMENT N:` headers.
- Re-verify the next free migration number against `supabase/migrations/` immediately before creating a file — migration 118 already collided once between two branches.
- No test runner exists in this repo ([[tilify-test-infra]]) — every "test" step in this plan is a SQL query or a `curl` call against PostgREST, run by hand and its output compared to the stated expectation. There is nothing to `pytest`.
- Never read a real cashier/admin PIN or credential out of the database to build a verification call — use a disposable test org and test accounts, or the Supabase SQL Editor's "run as user" / a service-role-created test session if available. Anything needing a real production credential becomes an OWNER MUST VERIFY item for Mumba.
- `CREATE OR REPLACE FUNCTION` bodies must be built from the function's **live** definition (`SELECT pg_get_functiondef('public.<name>'::regproc);` in the SQL Editor), never copy-pasted from migration history — migration 035 proved migration files are not evidence of the database's actual state (repo CLAUDE.md, Migrations section).

---

## File structure

- Create: `supabase/migrations/122_wms_rpc_role_guard.sql` — both helpers + `assert_org_manager` on all 18 WMS RPCs + `record_wms_adjustment`.
- Create: `supabase/migrations/123_sale_rpc_integrity_guards.sql` — `assert_org_permission` on `void_sale_lines` + location-scope check on `submit_sale_batch`.
- Create: `docs/superpowers/plans/artifacts/2026-09-11-verification-122.sql` — copy-pasteable verification queries + PostgREST `curl` calls for PR 1.
- Create: `docs/superpowers/plans/artifacts/2026-09-11-verification-123.sql` — same for PR 2.

No application code changes. No new tables, columns, or indexes.

---

### Task 1: Migration 122 skeleton — the two helper functions

**Files:**
- Create: `supabase/migrations/122_wms_rpc_role_guard.sql`

**Interfaces:**
- Produces: `assert_org_manager(p_org_id UUID) RETURNS VOID` — raises `42501` unless caller is owner/admin of `p_org_id`. Consumed by Task 2 and Task 3.
- Produces: `assert_org_permission(p_org_id UUID, p_permission TEXT) RETURNS VOID` — raises `42501` unless caller is owner, or admin with `permissions->>p_permission` not explicitly `false`. Consumed by Task 6 (migration 123).

- [ ] **Step 1: Confirm the next free migration number**

Run:
```bash
ls supabase/migrations | grep -E "^[0-9]+_" | sed -E 's/^([0-9]+)_.*/\1/' | sort -n | tail -5
```
Expected: highest plain-numbered file is `121_stock_count_expected.sql`. If a `122_*` or `123_*` file already exists (another branch landed one first), stop and pick the next free pair instead of the two used in this plan — rename both files here and in Tasks 4/6/7/8 consistently before continuing.

- [ ] **Step 2: Write the migration file**

```sql
-- ============================================================
-- Migration 122: WMS admin-only RPC guard (Security Phase 2 — RPC layer)
-- Spec: docs/superpowers/specs/2026-09-11-definer-rpc-role-guards-design.md
--
-- Migrations 119-121 gated table-level RLS by role. SECURITY DEFINER RPCs
-- bypass RLS entirely, so a caller reaching data through an RPC instead of
-- a table was unaffected. This migration adds two helper functions and
-- applies the first to every WMS write RPC + record_wms_adjustment — all
-- of which already resolve an org-id variable and already call
-- assert_org_writable() on it once. One line is added next to that
-- existing call in each; no signature changes anywhere in this file.
--
-- No legitimate caller can ever fail the new check: the app UI never lets
-- a cashier reach the WMS module, so this closes a direct-PostgREST-call
-- backdoor only. No frontend deploy required.
--
-- Idempotent. Safe to re-run.
--
-- Apply: Supabase SQL Editor (project pkufxpyrvcygobrgneep), any time —
--   this migration only restricts a path the UI never exercises, so it
--   carries none of the trading-hours risk a table RLS change would.
-- Record with:
--   node node_modules/supabase/dist/supabase.js migration repair \
--     --status applied 122
-- ============================================================

-- STATEMENT 1: assert_org_manager — raises unless caller is owner/admin.
CREATE OR REPLACE FUNCTION public.assert_org_manager(p_org_id UUID)
RETURNS VOID
LANGUAGE plpgsql STABLE
SET search_path = public
AS $$
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'assert_org_manager: org_id is required' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM current_user_manager_org_ids() m WHERE m = p_org_id
  ) THEN
    RAISE EXCEPTION 'Not authorised: this action requires an owner or manager role'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_org_manager(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assert_org_manager(UUID) TO authenticated;

-- STATEMENT 2: assert_org_permission — owner always; admin unless the
-- named permission key is explicitly false (077's absence-or-not-false
-- rule). Generalises 094's is_wms_adjustment_approver to the caller's own
-- auth.uid() instead of an externally supplied approver id.
CREATE OR REPLACE FUNCTION public.assert_org_permission(p_org_id UUID, p_permission TEXT)
RETURNS VOID
LANGUAGE plpgsql STABLE
SET search_path = public
AS $$
DECLARE
  v_role  TEXT;
  v_perms JSONB;
BEGIN
  SELECT role, permissions INTO v_role, v_perms
    FROM org_members
   WHERE org_id = p_org_id AND user_id = auth.uid();

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Not authorised for this organisation' USING ERRCODE = '42501';
  END IF;

  IF v_role = 'owner' THEN
    RETURN;
  END IF;

  IF v_role = 'admin'
     AND COALESCE((v_perms ->> p_permission)::BOOLEAN IS DISTINCT FROM FALSE, TRUE) THEN
    RETURN;
  END IF;

  RAISE EXCEPTION 'Not authorised: requires the % permission', p_permission
    USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.assert_org_permission(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assert_org_permission(UUID, TEXT) TO authenticated;

-- ============================================================
-- Verification (run manually in SQL Editor after applying):
--   SELECT assert_org_manager(<an org id you are NOT owner/admin of>);
--   -- must raise 42501
--   SELECT assert_org_manager(<an org id you ARE owner/admin of>);
--   -- must return with no error
-- ============================================================
```

- [ ] **Step 3: "Run the test" — verify the helpers standalone**

This has no app code to exercise, so the test is the two `SELECT` statements in the file's trailing comment, run in the Supabase SQL Editor while signed in (via `auth.uid()`) as a known owner and a known non-member. Confirm: non-member call raises `42501`; owner call returns with no error. Do this on a non-production project or org — do not run ad hoc `SELECT assert_org_manager(...)` calls against real prod org ids from this step; Task 4 covers the full production-safe verification pass.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/122_wms_rpc_role_guard.sql
git commit -m "security: add assert_org_manager and assert_org_permission helpers"
```

---

### Task 2: Guard `record_wms_adjustment`

**Files:**
- Modify: `supabase/migrations/122_wms_rpc_role_guard.sql` (append)

**Interfaces:**
- Consumes: `assert_org_manager(UUID)` from Task 1.

- [ ] **Step 1: Confirm the live definition matches what this task assumes**

Run in the SQL Editor: `SELECT pg_get_functiondef('public.record_wms_adjustment'::regproc);`

Expected: a function whose body contains, in order, `PERFORM assert_org_writable(v_org_id);` then (a few lines later) `PERFORM assert_no_active_freeze(v_org_id, ARRAY[p_wms_item_id]::BIGINT[]);`. This matches migration 094's version, which is the last one on record. If the live body differs from what Step 2 assumes, stop and re-base Step 2's `CREATE OR REPLACE` on the actual live output instead of the text below.

- [ ] **Step 2: Append the guarded function to the migration file**

```sql
-- STATEMENT 3: record_wms_adjustment — add assert_org_manager next to the
-- existing assert_org_writable call. Body otherwise unchanged from 094.
CREATE OR REPLACE FUNCTION public.record_wms_adjustment(
  p_wms_item_id      BIGINT,
  p_adjustment_qty   INT,
  p_reason           TEXT,
  p_notes            TEXT    DEFAULT NULL,
  p_recorded_by      TEXT    DEFAULT NULL,
  p_cost_price       NUMERIC DEFAULT NULL,
  p_idempotency_key  UUID    DEFAULT NULL,
  p_location_id      UUID    DEFAULT NULL,
  p_approver_user_id UUID    DEFAULT NULL
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
  PERFORM assert_org_manager(v_org_id);
  PERFORM assert_no_active_freeze(v_org_id, ARRAY[p_wms_item_id]::BIGINT[]);

  v_location_id := COALESCE(p_location_id, resolve_wms_main_location(v_org_id));

  SELECT adjustment_approval_threshold INTO v_threshold
    FROM wms_org_settings WHERE org_id = v_org_id;

  IF v_threshold IS NOT NULL AND v_threshold > 0 THEN
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

  IF p_approver_user_id IS NOT NULL AND v_threshold IS NOT NULL AND v_effective_cost IS NOT NULL
     AND abs(p_adjustment_qty) * v_effective_cost > v_threshold THEN
    INSERT INTO audit_logs (org_id, actor_user_id, action, entity_table, details)
    VALUES (v_org_id, auth.uid(), 'wms_adjustment_approved', 'wms_adjustments',
      jsonb_build_object('adjustment_id', v_adjustment_id, 'approver_user_id', p_approver_user_id,
                          'value', v_value, 'threshold', v_threshold));
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM store_rpc_idempotency_response(p_idempotency_key, v_org_id, 'record_wms_adjustment',
      jsonb_build_object('result', v_adjustment_id));
  END IF;

  RETURN v_adjustment_id;
END;
$$;
```

**Note for the implementer:** if Step 1's live `pg_get_functiondef` output has a trailing section (idempotency store, audit insert) that differs even slightly from what's shown above, use the live output as the base and insert only the one `PERFORM assert_org_manager(v_org_id);` line — do not silently adopt this plan's copy over a live body that has since changed.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/122_wms_rpc_role_guard.sql
git commit -m "security: guard record_wms_adjustment with assert_org_manager"
```

---

### Task 3: Guard the other 17 WMS RPCs

**Files:**
- Modify: `supabase/migrations/122_wms_rpc_role_guard.sql` (append)

**Interfaces:**
- Consumes: `assert_org_manager(UUID)` from Task 1.

Same procedure, repeated per function — this is one task because a reviewer approves or rejects this batch as a unit (identical mechanical change, not independently interesting per function).

- [ ] **Step 1: For each function below, pull its live definition**

Run, once per function: `SELECT pg_get_functiondef('public.<function_name>'::regproc);`

| Function | Org variable | Anchor line to insert after |
|---|---|---|
| `adjust_wms_inventory` | `p_org_id` | `PERFORM assert_org_writable(p_org_id);` |
| `apply_wms_stock_count` | `v_org_id` | `PERFORM assert_org_writable(v_org_id);` |
| `cancel_wms_transfer` | `v_org_id` | `PERFORM assert_org_writable(v_org_id);` |
| `create_wms_dispatch` | `v_org_id` | `PERFORM assert_org_writable(v_org_id);` |
| `create_wms_dispatch_draft` | `v_org_id` | `PERFORM assert_org_writable(v_org_id);` |
| `create_wms_purchase_order` | `v_org_id` | `PERFORM assert_org_writable(v_org_id);` |
| `create_wms_transfer` | `v_org_id` | `PERFORM assert_org_writable(v_org_id);` |
| `freeze_wms_count_session` | `v_org` | `PERFORM assert_org_writable(v_org);` |
| `unfreeze_wms_count_session` | `v_org` | `PERFORM assert_org_writable(v_org);` |
| `pack_wms_dispatch` | `v_org_id` | `PERFORM assert_org_writable(v_org_id);` |
| `pick_wms_dispatch` | `v_org_id` | `PERFORM assert_org_writable(v_org_id);` |
| `ship_wms_dispatch` | `v_org_id` | `PERFORM assert_org_writable(v_org_id);` |
| `receive_wms_purchase_order` | `v_org_id` | `PERFORM assert_org_writable(v_org_id);` |
| `receive_wms_stock` | `v_org_id` | `PERFORM assert_org_writable(v_org_id);` |
| `receive_wms_transfer` | `v_org_id` | `PERFORM assert_org_writable(v_org_id);` |
| `set_wms_dispatch_status` | `v_org_id` | `PERFORM assert_org_writable(v_org_id);` |
| `set_wms_po_status` | `v_org_id` | `PERFORM assert_org_writable(v_org_id);` |

For each row, confirm the live output contains that exact anchor line exactly once. If a function's anchor line doesn't appear verbatim (renamed variable, refactored guard), stop and re-derive that one function's edit from its actual live body rather than forcing the table's assumption.

- [ ] **Step 2: For each function, append a `CREATE OR REPLACE` to the migration file**

For each of the 17 functions, take the exact text returned by its `pg_get_functiondef` call in Step 1, and insert one new line directly after the anchor line from the table:

```sql
  PERFORM assert_org_manager(<org variable for this function>);
```

Wrap the result as `-- STATEMENT N: <function_name> — add assert_org_manager next to the existing assert_org_writable call.` followed by the full `CREATE OR REPLACE FUNCTION ...` block, appended to `supabase/migrations/122_wms_rpc_role_guard.sql` in the same order as the table. Nothing else in any of the 17 bodies changes.

- [ ] **Step 3: Sanity-check the whole file**

Run: `grep -c "PERFORM assert_org_manager" supabase/migrations/122_wms_rpc_role_guard.sql`
Expected: `18` (17 from this task + `record_wms_adjustment` from Task 2).

Run: `grep -c "^CREATE OR REPLACE FUNCTION public\." supabase/migrations/122_wms_rpc_role_guard.sql`
Expected: `20` (2 helpers from Task 1 + 18 guarded RPCs).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/122_wms_rpc_role_guard.sql
git commit -m "security: guard remaining WMS write RPCs with assert_org_manager"
```

---

### Task 4: Verification script + PR 1

**Files:**
- Create: `docs/superpowers/plans/artifacts/2026-09-11-verification-122.sql`

**Interfaces:**
- Consumes: `assert_org_manager` behaviour from Tasks 1-3 (raises `42501` for non-manager callers).

- [ ] **Step 1: Write the verification script**

```sql
-- Verification for migration 122 — WMS admin-only RPC guard.
-- Run each block against a NON-PRODUCTION org with three real test
-- logins: an owner, an admin, and a member (cashier). Do not use real
-- customer PINs/credentials — create disposable test accounts.
--
-- Every block should be run twice: once authenticated as the member
-- (expect 42501 / HTTP 403), once as the owner or admin (expect success).

-- 1. Direct SQL check (run as each role via `SET request.jwt.claims` or
--    the SQL Editor's "run as user", or via a PostgREST curl call):
SELECT record_wms_adjustment(
  p_wms_item_id := <a real wms_catalog.id in the test org>,
  p_adjustment_qty := 1,
  p_reason := 'Correction'
);
-- Member: must raise 42501. Owner/admin: must succeed.

-- 2. PostgREST — the path a direct-bypass attempt would actually use.
-- Replace <PROJECT_URL>, <ANON_KEY>, <MEMBER_JWT> with the test org's values.
--
-- curl -s -X POST '<PROJECT_URL>/rest/v1/rpc/record_wms_adjustment' \
--   -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <MEMBER_JWT>" \
--   -H "Content-Type: application/json" \
--   -d '{"p_wms_item_id": <id>, "p_adjustment_qty": 1, "p_reason": "Correction"}'
-- Expect: HTTP 42501-mapped error (403-class), NOT a 200 with a new
-- wms_adjustments row.

-- 3. Spot-check two more of the 17 batch-guarded functions the same way
--    (pick one dispatch-flow function and one receiving-flow function,
--    e.g. create_wms_dispatch and receive_wms_stock) — full behavioural
--    coverage of all 17 isn't required, they're mechanically identical,
--    but confirm at least two actually reject a member call over
--    PostgREST, not just in the SQL Editor.

-- 4. Confirm nothing legitimate broke: as the OWNER test account, run a
--    real WMS receive → dispatch → adjust cycle through the actual app UI
--    (not just the RPC) and confirm each step still succeeds.
```

- [ ] **Step 2: Run the verification script's Postgres blocks against a non-production org**

Confirm each result matches the "Expect" comment. Record the actual output (not just pass/fail) in the PR description — the repo's own convention after PR #91/#95 review findings is to show the query result, not just assert it passed.

- [ ] **Step 3: Commit the verification artifact**

```bash
git add docs/superpowers/plans/artifacts/2026-09-11-verification-122.sql
git commit -m "docs: verification script for migration 122"
```

- [ ] **Step 4: Push and open PR 1**

```bash
git push -u origin security/definer-rpc-role-guards
gh pr create --title "Security: WMS admin-only RPC guard (migration 122)" --body "$(cat <<'EOF'
Adds assert_org_manager/assert_org_permission helpers and guards all 18
admin-only WMS write RPCs + record_wms_adjustment against direct-call
role bypass. Spec: docs/superpowers/specs/2026-09-11-definer-rpc-role-guards-design.md
Verification: docs/superpowers/plans/artifacts/2026-09-11-verification-122.sql

No frontend change. No legitimate caller can fail the new check — the
UI never exposes WMS to a cashier. Safe to apply any time (not
trading-hours-restricted the way a table RLS change is), but still
apply by hand per the standing guardrail, then:
  npx supabase migration repair --status applied 122

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Do not merge — per repo guardrails, PRs stay open for Mumba to merge.

---

### Task 5: Migration 123 skeleton + `void_sale_lines` guard

**Files:**
- Create: `supabase/migrations/123_sale_rpc_integrity_guards.sql`

**Interfaces:**
- Consumes: `assert_org_permission(UUID, TEXT)` from Task 1.

- [ ] **Step 1: Confirm the live definition**

Run: `SELECT pg_get_functiondef('public.void_sale_lines'::regproc);`

Expected: a body whose loop contains `PERFORM assert_org_writable(r.org_id);` inside a `FOR r IN SELECT * FROM sales WHERE id = ANY(p_sale_ids) LOOP`. This matches migration 074, the last one on record. If different, re-base Step 2 on the live output.

- [ ] **Step 2: Write the migration file**

```sql
-- ============================================================
-- Migration 123: Sale RPC integrity guards (Security Phase 2 — RPC layer)
-- Spec: docs/superpowers/specs/2026-09-11-definer-rpc-role-guards-design.md
--
-- void_sale_lines: migration 077 moved void_sales off the shared till PIN
-- onto the named manager's own permission grant, specifically for
-- accountability. The RPC itself never enforced this — a cashier calling
-- it directly over PostgREST bypassed the UI gate entirely. This adds
-- assert_org_permission(r.org_id, 'void_sales') next to the existing
-- per-row assert_org_writable call.
--
-- submit_sale_batch: cashiers ARE meant to sell (see migration 123's
-- companion, task 7) — see that statement's own header for the location-
-- scope fix.
--
-- Idempotent. Safe to re-run.
--
-- BEHAVIOUR CHANGE — read before applying:
--   An admin without the void_sales permission key (or any cashier) will
--   now be REJECTED by void_sale_lines even if called directly, not just
--   hidden from in the UI. No legitimate current user should be affected
--   (the UI already prevents them from reaching the void action), but
--   this is a live-sales-path function — apply outside trading hours,
--   after the verification in
--   docs/superpowers/plans/artifacts/2026-09-11-verification-123.sql
--   passes on a non-production org.
--
-- Record with:
--   node node_modules/supabase/dist/supabase.js migration repair \
--     --status applied 123
-- ============================================================

-- STATEMENT 1: void_sale_lines — add assert_org_permission next to the
-- existing per-row assert_org_writable call. Body otherwise unchanged
-- from 074.
CREATE OR REPLACE FUNCTION public.void_sale_lines(
  p_sale_ids  UUID[],
  p_reason    TEXT,
  p_voided_by TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r        sales%ROWTYPE;
  v_count  INTEGER := 0;
BEGIN
  IF p_sale_ids IS NULL OR array_length(p_sale_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'void_sale_lines: no lines given' USING ERRCODE = '22023';
  END IF;

  FOR r IN SELECT * FROM sales WHERE id = ANY(p_sale_ids) LOOP
    IF r.voided THEN
      CONTINUE;
    END IF;
    IF r.return_of_sale_id IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot void a return' USING ERRCODE = '22023';
    END IF;

    PERFORM assert_org_writable(r.org_id);
    PERFORM assert_org_permission(r.org_id, 'void_sales');

    UPDATE sales
       SET voided = TRUE,
           voided_at = NOW(),
           voided_by = p_voided_by,
           void_reason = NULLIF(TRIM(p_reason), '')
     WHERE id = r.id;

    IF r.location_id IS NOT NULL THEN
      PERFORM restock_at_location(r.product_id, r.quantity, r.location_id);
    END IF;

    IF lower(r.payment_method) LIKE '%credit%' AND r.customer_id IS NOT NULL THEN
      PERFORM adjust_customer_balance(r.customer_id, -r.total_amount);
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;
```

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/123_sale_rpc_integrity_guards.sql
git commit -m "security: guard void_sale_lines with assert_org_permission"
```

---

### Task 6: `submit_sale_batch` location-scope guard

**Files:**
- Modify: `supabase/migrations/123_sale_rpc_integrity_guards.sql` (append)

**Interfaces:**
- Consumes: nothing new — inline `org_members` lookup, no helper function (cashiers ARE allowed to call this; it's a value check, not a role gate).

- [ ] **Step 1: Confirm the live definition**

Run: `SELECT pg_get_functiondef('public.submit_sale_batch'::regproc);`

Expected: matches migration 114's version — `PERFORM assert_org_writable(p_org_id);` as the first statement, then the array-length checks, then the three-phase idempotency block. If different, re-base Step 2 on the live output.

- [ ] **Step 2: Append the guarded function**

```sql
-- STATEMENT 2: submit_sale_batch — add a location-scope check for
-- role='member' callers. Owner/admin unchanged. No new parameter, same
-- 15-argument signature as 114/101 — none of the overload-ambiguity risk
-- CLAUDE.md warns about applies, since nothing about the call site changes.
CREATE OR REPLACE FUNCTION public.submit_sale_batch(
  p_sale_ids         UUID[],
  p_org_id           UUID,
  p_location_id      UUID,
  p_product_ids      UUID[],
  p_quantities       INTEGER[],
  p_unit_prices      NUMERIC[],
  p_total_amounts    NUMERIC[],
  p_payment_method   TEXT,
  p_payment_reference TEXT,
  p_customer_id      UUID,
  p_sale_date        DATE,
  p_created_at       TIMESTAMPTZ,
  p_cost_prices      NUMERIC[] DEFAULT NULL,
  p_is_wholesale     BOOLEAN[] DEFAULT NULL,
  p_cash_back        NUMERIC   DEFAULT 0
)
RETURNS UUID[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_i              INTEGER;
  v_n              INTEGER;
  v_credit_total   NUMERIC := 0;
  v_existing_count INTEGER;
  v_undeducted     INTEGER;
  v_cost           NUMERIC;
  v_wholesale      BOOLEAN;
  v_txn_id         UUID;
  v_role           TEXT;
  v_assigned       UUID;
BEGIN
  PERFORM assert_org_writable(p_org_id);

  SELECT role, assigned_location_id INTO v_role, v_assigned
    FROM org_members
   WHERE org_id = p_org_id AND user_id = auth.uid();

  IF v_role = 'member' AND v_assigned IS NOT NULL AND v_assigned <> p_location_id THEN
    RAISE EXCEPTION 'Not authorised to record sales at this location'
      USING ERRCODE = '42501';
  END IF;

  IF array_length(p_sale_ids, 1) IS NULL OR array_length(p_sale_ids, 1) = 0 THEN
    RAISE EXCEPTION 'submit_sale_batch: at least one sale row required';
  END IF;
  v_n := array_length(p_sale_ids, 1);
  IF array_length(p_product_ids, 1) <> v_n
     OR array_length(p_quantities, 1) <> v_n
     OR array_length(p_unit_prices, 1) <> v_n
     OR array_length(p_total_amounts, 1) <> v_n THEN
    RAISE EXCEPTION 'submit_sale_batch: array lengths mismatch';
  END IF;

  SELECT COUNT(*),
         COUNT(*) FILTER (WHERE stock_deducted_at IS NULL)
    INTO v_existing_count, v_undeducted
    FROM sales
   WHERE id = ANY(p_sale_ids);

  IF v_existing_count = v_n AND v_undeducted = 0 THEN
    RETURN p_sale_ids;
  END IF;

  IF v_existing_count = v_n AND v_undeducted > 0 THEN
    FOR v_i IN 1..v_n LOOP
      IF EXISTS (
        SELECT 1 FROM sales
         WHERE id = p_sale_ids[v_i] AND stock_deducted_at IS NULL
      ) THEN
        PERFORM deduct_stock_at_location(
          p_product_ids[v_i],
          p_quantities[v_i],
          p_location_id
        );

        UPDATE sales
           SET stock_deducted_at = NOW()
         WHERE id = p_sale_ids[v_i];
      END IF;
    END LOOP;
    RETURN p_sale_ids;
  END IF;

  IF v_existing_count > 0 THEN
    RAISE EXCEPTION 'submit_sale_batch: partial overlap — % of % sale IDs already exist',
      v_existing_count, v_n
      USING ERRCODE = '23505';
  END IF;

  v_txn_id := gen_random_uuid();

  FOR v_i IN 1..v_n LOOP
    IF p_cost_prices IS NOT NULL AND array_length(p_cost_prices, 1) >= v_i THEN
      v_cost := p_cost_prices[v_i];
    ELSE
      SELECT CASE WHEN qty_in_pack > 0 THEN ROUND(package_price / qty_in_pack, 2) ELSE 0 END
        INTO v_cost
        FROM products WHERE id = p_product_ids[v_i];
    END IF;

    IF p_is_wholesale IS NOT NULL AND array_length(p_is_wholesale, 1) >= v_i THEN
      v_wholesale := p_is_wholesale[v_i];
    ELSE
      v_wholesale := FALSE;
    END IF;

    INSERT INTO sales (
      id, org_id, sale_date, product_id, quantity, unit_price, total_amount,
      payment_method, payment_reference, customer_id, location_id, created_at,
      cost_price, is_wholesale, cash_back, transaction_id, stock_deducted_at
    ) VALUES (
      p_sale_ids[v_i], p_org_id, p_sale_date,
      p_product_ids[v_i], p_quantities[v_i], p_unit_prices[v_i], p_total_amounts[v_i],
      p_payment_method, NULLIF(p_payment_reference, ''), p_customer_id, p_location_id, p_created_at,
      v_cost, v_wholesale,
      CASE WHEN v_i = 1 THEN COALESCE(p_cash_back, 0) ELSE 0 END,
      v_txn_id,
      NOW()
    );

    PERFORM deduct_stock_at_location(
      p_product_ids[v_i],
      p_quantities[v_i],
      p_location_id
    );

    IF lower(p_payment_method) LIKE '%credit%' THEN
      v_credit_total := v_credit_total + p_total_amounts[v_i];
    END IF;
  END LOOP;

  IF v_credit_total > 0 AND p_customer_id IS NOT NULL THEN
    UPDATE customers
       SET balance = COALESCE(balance, 0) + v_credit_total
     WHERE id = p_customer_id;
  END IF;

  RETURN p_sale_ids;
END;
$$;

NOTIFY pgrst, 'reload schema';
```

- [ ] **Step 3: Sanity-check the file**

Run: `grep -c "^CREATE OR REPLACE FUNCTION public\." supabase/migrations/123_sale_rpc_integrity_guards.sql`
Expected: `2` (`void_sale_lines`, `submit_sale_batch`).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/123_sale_rpc_integrity_guards.sql
git commit -m "security: guard submit_sale_batch with a per-cashier location-scope check"
```

---

### Task 7: Verification script + PR 2

**Files:**
- Create: `docs/superpowers/plans/artifacts/2026-09-11-verification-123.sql`

**Interfaces:**
- Consumes: behaviour from Task 5 and Task 6.

- [ ] **Step 1: Write the verification script**

```sql
-- Verification for migration 123 — sale RPC integrity guards.
-- Run against a NON-PRODUCTION org with real test logins for owner,
-- admin (with void_sales permission), admin (without it), and member
-- (cashier), plus two test locations (A = the cashier's assigned
-- location, B = a different one). Do not use real credentials.

-- 1. void_sale_lines — permission check
--    As owner: void a test sale line. Expect: success.
--    As admin WITH void_sales permission (permissions->>'void_sales' is
--      absent or true): void a test sale line. Expect: success.
--    As admin WITHOUT void_sales permission (permissions->>'void_sales'
--      = false): void a test sale line. Expect: 42501, over PostgREST
--      directly, not just hidden by the UI.
--    As member (cashier): void a test sale line. Expect: 42501, over
--      PostgREST directly.
--
-- curl -s -X POST '<PROJECT_URL>/rest/v1/rpc/void_sale_lines' \
--   -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <MEMBER_JWT>" \
--   -H "Content-Type: application/json" \
--   -d '{"p_sale_ids": ["<a real sale id>"], "p_reason": "test", "p_voided_by": "test"}'

-- 2. submit_sale_batch — location scope
--    As member assigned to location A, submit a sale with
--    p_location_id = A. Expect: success (this is the normal checkout
--    path — confirm it still works before anything else).
--    As member assigned to location A, submit a sale with
--    p_location_id = B (call the RPC directly — the UI would never do
--    this). Expect: 42501.
--    As owner/admin, submit a sale with p_location_id = B while assigned
--    (or not assigned) anywhere. Expect: success — owner/admin stay
--    unrestricted.

-- 3. End-to-end: as the cashier test account, actually use the POS UI to
--    ring up a real sale at their assigned location, online. Confirm the
--    sale appears, stock deducts, and no error is shown. Then go offline
--    (airplane mode / devtools offline), ring up another sale, come back
--    online, and confirm it drains from the queue successfully. Both
--    exercise the exact call the new check must never reject.
```

- [ ] **Step 2: Run the verification script**

Confirm every result matches its "Expect" line, especially step 3 (the real till path) — this is the one this whole plan must never break.

- [ ] **Step 3: Commit the verification artifact**

```bash
git add docs/superpowers/plans/artifacts/2026-09-11-verification-123.sql
git commit -m "docs: verification script for migration 123"
```

- [ ] **Step 4: Push and open PR 2**

```bash
git push
gh pr create --title "Security: sale RPC integrity guards (migration 123)" --body "$(cat <<'EOF'
Guards void_sale_lines (void_sales permission, matches the UI gate
that migration 077 already intended) and submit_sale_batch (cashier
can no longer submit a sale at a branch they aren't assigned to, via
direct RPC call — the UI already pins them, this closes the RPC side).

Spec: docs/superpowers/specs/2026-09-11-definer-rpc-role-guards-design.md
Verification: docs/superpowers/plans/artifacts/2026-09-11-verification-123.sql

This touches the till's core write path. Before merge: a final
whole-branch review (not just per-commit), same weight the
stock-take-variance-flags work got. Apply outside trading hours, after
a policy/function snapshot, then:
  npx supabase migration repair --status applied 123

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Do not merge — Mumba merges, per repo guardrails. Flag PR 2 explicitly as needing the whole-branch review pass before it does.
