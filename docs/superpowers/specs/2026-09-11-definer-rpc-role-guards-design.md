# Design — SECURITY DEFINER RPC role guards

**Status:** Approved by Mumba 2026-09-11, not yet built.
**Relates to:** [[tilify-security-review]] Phase 2 (role-scoped write RLS, migration 119).
Migrations 119/120/121 already closed the table-level RLS hole for `role='member'`
(cashier) accounts. This design closes the RPC-level hole those migrations explicitly
do not touch: SECURITY DEFINER functions bypass RLS entirely, so a caller who reaches
data through an RPC instead of a table is unaffected by any policy change.

Source catalogue: `.agents/p2-functions.csv` (54 SECURITY DEFINER functions, captured
2026-09-07). Two were already flagged there as needing their own role check
(`record_wms_adjustment`, `submit_sale_batch`) but left as "separate work item, no
design yet" — this is that design. Investigation for this spec also found a third,
previously uncatalogued gap on `void_sale_lines` (§2.3).

---

## 1. Problem

Of the 54 SECURITY DEFINER RPCs, most already call `assert_org_writable(org_id)` —
membership + active-subscription check, added by migration 039/114. None of them check
the caller's **role** within that org. `current_user_manager_org_ids()` (migration 119)
and the table-level RLS policies it drives only apply to direct PostgREST table access;
they do nothing for a caller who goes through an RPC.

Concretely, as of 2026-09-11, any authenticated `role='member'` (cashier) account can,
by calling the RPC directly over PostgREST instead of through the app UI:

- Run any WMS write (dispatch, receive, transfer, adjust, stock count) — §4 of
  `phase2-role-rls-design.md` (confirmed by Mumba 2026-09-07) marks every `wms_*`
  write path as admin-only. The UI hides the WMS module from cashiers entirely, but
  the RPCs underneath have no independent check.
- Void a sale (`void_sale_lines`) — migration 077 deliberately moved `void_sales` off
  the shared till PIN onto the named manager's own `permissions` grant, specifically
  because voiding needs individual accountability. The RPC does not enforce this at
  all; the UI gate is the only thing stopping a cashier today.
- Submit a sale (`submit_sale_batch`) at a branch other than the one they're assigned
  to. Cashiers *should* be able to sell — §4 keeps `sales` cashier-writable — so this
  isn't a role gate, but the client-side location pin (`org-context.tsx`,
  `switchLocation`) has no server-side counterpart on the RPC that actually writes and
  deducts stock.

## 2. Design

### 2.1 Two new helper functions

Same style as the existing guards — `STABLE`, `SET search_path = public`, `42501` on
failure (PostgREST → HTTP 403, already handled as a logical failure by
`offline-ops.ts`).

```sql
CREATE OR REPLACE FUNCTION assert_org_manager(p_org_id UUID)
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
```

```sql
CREATE OR REPLACE FUNCTION assert_org_permission(p_org_id UUID, p_permission TEXT)
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

  -- 077 rule: absence-or-not-false = granted. Same semantics as
  -- is_wms_adjustment_approver (094), generalised to the caller instead of
  -- an externally-supplied approver id.
  IF v_role = 'admin'
     AND COALESCE((v_perms ->> p_permission)::BOOLEAN IS DISTINCT FROM FALSE, TRUE) THEN
    RETURN;
  END IF;

  RAISE EXCEPTION 'Not authorised: requires the % permission', p_permission
    USING ERRCODE = '42501';
END;
$$;
```

Both `REVOKE ... FROM PUBLIC, anon` / `GRANT ... TO authenticated`, matching every
other helper in this family.

### 2.2 WMS RPCs + `record_wms_adjustment` — `assert_org_manager`

Every one of these already resolves an org-id variable and already calls
`assert_org_writable` on it exactly once (verified against each function's live
definition in the migration history). The fix is one line added immediately after
that existing call, using whatever variable it already resolved — no signature change:

| Function | Existing org variable |
|---|---|
| `record_wms_adjustment` | `v_org_id` |
| `adjust_wms_inventory` | `p_org_id` |
| `apply_wms_stock_count` | `v_org_id` |
| `cancel_wms_transfer` | `v_org_id` |
| `create_wms_dispatch` | `v_org_id` |
| `create_wms_dispatch_draft` | `v_org_id` |
| `create_wms_purchase_order` | `v_org_id` |
| `create_wms_transfer` | `v_org_id` |
| `freeze_wms_count_session` | `v_org` |
| `unfreeze_wms_count_session` | `v_org` |
| `pack_wms_dispatch` | `v_org_id` |
| `pick_wms_dispatch` | `v_org_id` |
| `ship_wms_dispatch` | `v_org_id` |
| `receive_wms_purchase_order` | `v_org_id` |
| `receive_wms_stock` | `v_org_id` |
| `receive_wms_transfer` | `v_org_id` |
| `set_wms_dispatch_status` | `v_org_id` |
| `set_wms_po_status` | `v_org_id` |

Add: `PERFORM assert_org_manager(<variable>);` directly after the existing
`PERFORM assert_org_writable(<variable>);` line in each function body (`CREATE OR
REPLACE`, full body restated — same pattern migration 114 used for its one-line diff
on `submit_sale_batch`).

This closes `record_wms_adjustment` specifically: only an owner/admin can call it at
all now, which collapses most of the practical value of the pre-existing
approver-spoofing gap (§3, below) since a cashier can no longer reach the function to
exploit it in the first place.

### 2.3 `void_sale_lines` — `assert_org_permission`

Add `PERFORM assert_org_permission(r.org_id, 'void_sales');` inside the existing
per-row loop, next to its existing `PERFORM assert_org_writable(r.org_id);`. Mirrors
exactly what the UI's `can("void_sales")` check already does (owner: always;
admin: unless explicitly revoked; cashier: never) — this was found during design
investigation, not in the original catalogue, and is the same category of bug as
`record_wms_adjustment`: an intended permission gate that only exists client-side.

### 2.4 `submit_sale_batch` — location-scope check, not a role gate

Cashiers are supposed to sell (§4 keeps `sales` cashier-writable). The gap here is
that `p_location_id` is caller-supplied with no server-side check it matches the
caller's own assigned branch — the client-side pin
(`org-context.tsx:switchLocation` — "Cashiers cannot switch off their assigned
location") has no RPC-side equivalent.

Add, as the first statement after the existing `assert_org_writable(p_org_id)` call:

```sql
DECLARE
  v_role      TEXT;
  v_assigned  UUID;
BEGIN
  ...
  SELECT role, assigned_location_id INTO v_role, v_assigned
    FROM org_members WHERE org_id = p_org_id AND user_id = auth.uid();

  IF v_role = 'member' AND v_assigned IS NOT NULL AND v_assigned <> p_location_id THEN
    RAISE EXCEPTION 'Not authorised to record sales at this location'
      USING ERRCODE = '42501';
  END IF;
```

`v_assigned IS NOT NULL` guards a cashier with no assigned branch (should not happen in
practice — the app requires branch assignment for cashiers — but fails open rather than
locking out an edge case this design didn't set out to fix). Owner/admin unrestricted,
unchanged. No new parameter, no signature change — the existing 15-argument signature
this function already has is untouched, so none of the overload/PostgREST-ambiguity
risk the repo CLAUDE.md warns about applies.

## 3. Explicitly out of scope

Named here so it isn't silently forgotten, per this repo's own convention
(`phase2-role-rls-design.md` §3.3 does the same for the `permissions` fail-open issue):

- **`adjust_customer_balance`, `deduct_stock`/`deduct_stock_at_location`,
  `add_product_stock`/`add_product_stock_at_location`, `restock_at_location`** — shared
  primitives called from both cashier-permitted flows (sale, return, void) and
  admin-permitted ones (adjustment, receiving). `auth.uid()` resolves to the original
  caller all the way down a nested SECURITY DEFINER call chain (per migration 039's own
  comment on why `assert_org_writable` works this way), so a caller-role check on these
  would break the legitimate nested calls from `submit_sale_batch`/`void_sale_lines`/
  `record_sale_return`. No safe fix here without redesigning those call sites to pass an
  explicit "acting as" context — not attempted in this design.
- **`record_wms_adjustment`'s approver-identity spoofing** — `p_approver_user_id` is
  checked for *eligibility* (`is_wms_adjustment_approver`) but not that the named person
  actually consented. Migration 094's own header already documents this as a
  frontend-only control ("Wave B11 will prompt for the approver's PIN or equivalent").
  This design restricts *who can call the function at all* to owner/admin, which shrinks
  the exposure, but does not close the spoofing gap itself.
- **`ensure_wms_main_location`, `ensure_wms_stock_count_session`,
  `resolve_wms_main_location`** — internal plumbing helpers with no privileged write of
  consequence on their own (they resolve or lazily create a default location/session
  row). Left alone.
- **Permission-key parity** — an admin without the `manage_warehouse` permission key can
  still call WMS RPCs directly, same fail-open shape as `phase2-role-rls-design.md`
  §3.3's already-deferred `permissions` JSONB issue. Not reopened here; `assert_org_manager`
  checks role only, matching what migration 119's table-level policies already do for
  WMS tables (`current_user_manager_org_ids()` is also role-only, not permission-aware).

## 4. Rollout

Two migrations/PRs, next free numbers **122** and **123** — re-verify against
`supabase/migrations/` immediately before creating either file; migration 118 already
collided once between two branches (see [[tilify-security-review]]).

**PR 1 — migration 122, "WMS admin-only RPC guard".** Both helper functions
(§2.1) + `assert_org_manager` applied to all 18 WMS functions + `record_wms_adjustment`
(§2.2). Mechanical, uniform, no legitimate caller can ever fail the new check (the UI
never exposes WMS to a cashier), so this is safe to review and apply with the repo's
normal PR process — no special trading-hours restriction beyond the standing guardrail
(never apply migrations while shops are trading; PRs/reviews any time).

**PR 2 — migration 123, "sale RPC integrity guards".** `void_sale_lines` (§2.3) +
`submit_sale_batch` (§2.4). Isolated from PR 1 because `submit_sale_batch` is the till's
core write path. Gets the same weight the stock-count-variance work used: a final
whole-branch review pass (not just per-change review), the standard Phase 2 verification
protocol before applying —

- Owner: void and sell — succeeds, unaffected.
- Admin with `void_sales` permission: void succeeds; without it: void rejected,
  directly over PostgREST, not just hidden in the UI.
- Member (cashier): void rejected regardless of permission JSONB content; sale at their
  own assigned location succeeds; sale at a different location rejected, directly over
  PostgREST.
- A till sale still completes end to end, at the assigned location, with an open
  connection and via the offline queue (drain-and-replay), after the migration is
  applied.

— and applied by hand outside trading hours, per the standing guardrail, with a
policy/function snapshot taken first (same pattern as migration 119/121).

Both migrations are pure `CREATE OR REPLACE FUNCTION` bodies — additive checks only, no
column/table changes, no frontend deploy required for either PR to take effect
correctly (the client already only ever sends values that pass the new checks).
