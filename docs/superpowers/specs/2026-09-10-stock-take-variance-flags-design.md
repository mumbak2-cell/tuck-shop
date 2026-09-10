# Stock-take variance flags (v1) — design

**Date:** 2026-09-10
**Status:** approved for planning
**Repo:** tilify (`tuck-shop`)

## Problem

A cashier can steal cash by manipulating the stock **count**, not the sale. Example
(Fizzpop, a ~R2 cost / ~R4 retail sweet):

1. Open with 10, sell 10 — all rung up, legitimately. Physical stock is now 0.
2. At the closing count the cashier enters **5** instead of 0.
3. The owner confirms the count. The system now believes 5 Fizzpop exist.
4. The next day the cashier sells 5 Fizzpop for cash and pockets it. Stock goes
   5 → 0. The books balance, because the phantom 5 "existed".

The fraud is **self-laundering**: once the inflated count is confirmed, that +5
becomes the next period's *opening* count, so Revenue Assurance's count-to-count
reconciliation (`revenue-assurance/page.tsx:343`,
`movement = openingStock + replenished - closingStock`) nets clean forever after.
The discrepancy is only visible on the single introduction period, where it lands
in RA's un-priced, misleadingly-captioned `oversoldUnits` bucket.

The interception point is therefore **the count itself** — comparing what the
cashier entered against what the system expects on hand, and putting that in front
of the owner at confirm time, attributed to the person who counted.

## What already exists

`src/app/(dashboard)/stock/page.tsx` already:

- Hides the expected figure and the variance from cashiers (`isCashierView`,
  `stock/page.tsx:58-63`) — a "blind count" so a wrong count can't be nudged to
  match. **This is deliberate and is kept.** If the counter sees "expected 0" a
  dishonest one just types 0 and steals a different way.
- Shows the owner `Expected: N` per row and a colour-coded
  `variance = closing_units - expected` (`stock/page.tsx:592-652`), where
  `expected` = `product_stock.quantity` **read at page load** (`:105-108`,
  `:170-175`) — stale for a next-morning confirm.
- Snapshots that page-load `expected` into `stock_counts.opening_units` at save
  (`stock/page.tsx:249`).
- Gates the Confirm button on `role === "owner" && tillRole === "admin"`
  (`canConfirm`, `stock/page.tsx:57`) — owner account AND admin till PIN.
- Applies a confirmed count with two client writes: `product_stock` upsert then
  `stock_counts` stamp (`stock/page.tsx:330-352`).

**Missing:** the variance is a raw number across ~83 rows with nothing marking a
line as worth attention, no view of products that have stock but weren't counted,
and no memory across counts or per cashier.

## Approach

Three approaches were considered:

- **A — Preventive gate.** A `SECURITY DEFINER` RPC blocks confirm until every
  flagged line carries a reason.
- **B — Detective + attribution.** No block. Flags are computed and stored, the
  owner sees them prominently plus a list of uncounted-but-in-stock products, and
  a per-cashier variance rollup accumulates.
- **C — Both.**

Three independent adversarial/code reviews concluded A's real-world strength is
capped by the human confirming it: an owner who sets every flag to "accept" on a
shared-tablet login (which `CLAUDE.md` says is the norm) largely defeats it, and
A additionally requires converting StockPilot Import + the product CSV upload off
their direct `product_stock` writes first. **B is chosen for v1.** A's apply-gate
becomes v2, once real flag data shows where thresholds belong and the direct
writers are on RPCs.

## Design

### 1. Data model

One migration, `supabase/migrations/121_stock_count_expected.sql`, pure DDL.

`stock_counts` gains:

| column | type | meaning |
|---|---|---|
| `expected_units` | `INTEGER` nullable | `COALESCE(product_stock.quantity, 0)` for this product + location, stamped by trigger **on INSERT only**. NULL only on pre-migration rows outside the backfill. |
| `flag_kind` | `TEXT` nullable | `NULL` \| `near_empty` \| `value` \| `unit_ceiling` \| `session_spread` \| `pattern` — the worst applicable, set by trigger at INSERT (plus a `session_spread` second pass, §3) |
| `review_note` | `TEXT` nullable | optional free text the owner may add at confirm; never required, never gates anything |

`stock_count_audit` gains `expected_units_old` / `expected_units_new` so a re-save
that ever shifts the baseline is on record (should not happen with an INSERT-only
trigger; belt and braces).

`opening_units` continues to be written exactly as today — Revenue Assurance reads
it (`revenue-assurance/page.tsx:240,248`). `expected_units` is a **new, separate,
frozen** baseline. A header comment in the migration and in `stock/page.tsx` must
state: RA trusts `opening_units`; the flag logic trusts `expected_units`; a future
change must not "reconcile" the two.

Note: `units_sold_calc` is a STORED generated column
`opening_units + replenished_units - closing_units` (`001_create_tables.sql:78-82`).
It is not read anywhere in `src/`, `daily-report.ts`, or `api/` (verified by grep),
but the migration's planning step must re-confirm no SQL view consumes it before
anyone changes how `opening_units` is written.

### 2. Snapshot mechanics — the trigger

`BEFORE INSERT` on `stock_counts` (explicitly **not** `INSERT OR UPDATE`):

```
IF NEW.closing_units IS NOT NULL THEN
  NEW.expected_units := COALESCE(
    (SELECT quantity FROM product_stock
      WHERE product_id = NEW.product_id AND location_id = NEW.location_id),
    0);
  NEW.flag_kind := <computed, see section 3>;
END IF;
```

- **INSERT-only** — `saveAllCounts` upserts on
  `onConflict:"session_id,product_id,location_id"` (`stock/page.tsx:263-265`); an
  edited row is an UPDATE. An `INSERT OR UPDATE` trigger would re-stamp
  `expected_units` from live `product_stock` on every re-save, and again on the
  `confirmSession` stamp UPDATE (`stock/page.tsx:349`) after `product_stock` has
  already been overwritten — retroactively zeroing every variance. INSERT-only
  freezes the baseline at first save.
- **`COALESCE(…, 0)`** — a never-stocked product (no `product_stock` row) counted
  at 12 flags as +12, not "no baseline, skip". `deduct_stock_at_location`
  auto-creates a `0` row on first sale (`058_stock_oversells.sql:102-105`), so a
  missing row genuinely means never-touched; treating it as 0 is correct and
  matches the UI's own `expectedMap.get(p.id) ?? 0` (`stock/page.tsx:107,173`).

**Documented v1 blind spot — StockPilot Import.** `stockpilot-import/page.tsx:178`
upserts `product_stock = qtyCounted` *before* inserting its `stock_counts` row
(`:199`), so the trigger reads the already-overwritten value and stamps
`expected_units == closing_units` (variance 0, no flag). StockPilot is a bulk,
owner-run import, not a cashier surface — acceptable for v1. Fixing it belongs
with the v2 RPC work (insert the count row first, or derive expected from
last-confirmed-count + movement).

### 3. Flag rules

Computed in the trigger at INSERT, stored in `flag_kind`. Only for lines where
`closing_units` is set **and** the product's `is_prepared = false`. `variance :=
closing_units - expected_units`. Priority order (first match wins):

1. **`near_empty`** — `expected_units <= 2 AND variance >= 3`. A positive surplus
   on stock the system believes is gone. The exact fraud signature; always flags,
   price-independent.
2. **`value`** — `abs(variance) * products.selling_price >= 100`. `selling_price`
   is NOT NULL (`001_create_tables.sql:17`); the cash value of phantom stock is
   retail, not cost, and `cost_per_unit` is NULL for prepared food and many
   high-value low-volume items.
3. **`unit_ceiling`** — `abs(variance) >= 15`. Catches low-retail bulk inflation
   the rand threshold misses.
4. **`session_spread`** — fills `flag_kind` on counted lines that are **still
   `NULL`** (a line already flagged 1–3 or 5 keeps its own, stronger kind) when,
   across the session, `count(lines with a same-direction variance of magnitude
   >= 1) >= 8` OR `sum(positive variances) * (session avg selling_price) >= 150`.
   Catches "+2 on 30 lines". Session-level aggregates aren't visible to a per-row
   `BEFORE INSERT` trigger, so this is a second pass: after its upsert,
   `saveAllCounts` runs one `UPDATE stock_counts SET flag_kind = 'session_spread'
   WHERE session_id = ? AND location_id = ? AND flag_kind IS NULL AND closing_units
   IS NOT NULL` guarded by the session-level condition. (Alternatives the plan may
   revisit: an `AFTER STATEMENT` trigger, or computing `session_spread` only in
   the UI / verify script and not storing it.)
5. **`pattern`** — same product + location shows a same-direction variance across
   the **2 most recent confirmed sessions plus this one**. Advisory badge only;
   like `session_spread`, only fills `flag_kind` where it is still `NULL`.

**Prepared-food items** (`is_prepared = true`) get **no** `flag_kind` — they
legitimately run +variance every count until a `production_log` → `product_stock`
credit flow exists (separate item). Their variance number still renders; just no
badge, and they never trip `pattern`.

Thresholds are hard-coded constants in the migration with a comment block listing
them for tuning.

**Planning note:** `session_spread` needs session aggregates that a per-row
`BEFORE INSERT` trigger cannot see cleanly (rows arrive one INSERT at a time in
the `upsert`). Options for the plan to choose: (a) a second pass —
`saveAllCounts` runs an `UPDATE ... SET flag_kind = 'session_spread'` over the
session after the upsert; (b) an `AFTER STATEMENT` trigger; (c) compute
`session_spread` only in the owner UI / verify script and not store it. Prefer
(a) — keeps all flag state in one column, one extra write on save.

### 4. Owner UI — `stock/page.tsx` (owner view only)

`isCashierView` path is untouched: still blind, no expected, no variance.

- **Per row:** the existing variance number gets a badge when `flag_kind` is set —
  `near-empty` (red), `R{exposure}` (value), `+{units}` (unit ceiling), `spread`,
  `↻ 3rd count` (pattern) — with an `over` / `under` direction word. `Expected: N`
  now renders from the stored `expected_units`, not the stale `row.expected`.
- **Pending-session banner** (replaces the "check the variance column" text at
  `stock/page.tsx:421-446`):
  > "{flaggedCount} flagged lines — {overCount} over expected, {underCount} under.
  > {uncountedWithStock} products with stock on hand weren't counted."

  Flagged rows sort to the top; a "Flagged only" filter toggle. **Every count and
  query here is scoped to `session_id AND location_id`** — `sessionId` is React
  state independent of `currentLocationId`, so a session can span locations; a
  `session_id`-only query would show another branch's flag count.
- **Uncounted-with-stock list:** a collapsible section under the banner listing
  every product with `product_stock.quantity > 0` at this location and no row in
  this session. This is the "don't count what you took" surface — visible even
  though there is no count row to carry a flag.
- **Confirm:** stays a single button. **No per-line gate, nothing enforced
  server-side.** One lightweight client-only beat: a checkbox — *"I've reviewed
  the {N} flagged lines and {M} uncounted items"* — that must be ticked to enable
  the button when either count is > 0. It is friction, not a control; the DB
  accepts the confirm regardless of the checkbox (consistent with B — no DB
  apply-gate in v1). Optional per-row `review_note` free text stays available,
  never required.
- **`confirmSession`:** mechanically unchanged (same two client writes — no RPC in
  v1). Additionally writes any `review_note`s and one `audit_logs` row:
  `action = 'stock_count_confirmed'`, `{session_id, location_id, flagged: N,
  uncounted_with_stock: M, confirmed_by}`. `audit_logs` is append-only via RLS
  (migration 079) — writes come from triggers / service role today; confirm the
  planning step's client insert path is allowed, or route this one log write
  through a tiny DEFINER helper.

### 5. Per-cashier variance view

A card on the existing **Team** page (`src/components/settings/team-section.tsx`
area), owner-only, **not a new route**.

Per team member, over a selectable 30 / 60 / 90-day window:

- count sessions they entered (`stock_counts.counted_by`)
- flagged lines they entered, split `over` / `under`
- total rand exposure — `Σ abs(expected_units - closing_units) * selling_price`
  over their flagged lines
- worst repeat — the product with the most same-direction flags by that person

One query over `stock_counts` joined to `products`, grouped by `counted_by`. No
new table; the Section 1 columns hold everything. Read-only — a place to look,
not an action surface.

This is the part that survives a rubber-stamping owner: even if every count is
confirmed unread, the pattern accumulates against a name, and three months of
small same-direction overs by one cashier becomes a visible, quantified case.

### 6. Error handling & edge cases

- **`expected_units` NULL** only for pre-migration rows (trigger always sets it
  going forward). Migration backfills open (unconfirmed) sessions' rows from
  current `product_stock` with a single `UPDATE`; older confirmed rows stay NULL
  and simply carry no badge.
- **`cost_per_unit` is not used** by any flag rule — `selling_price` only.
- **Re-save into a confirmed session.** Save is only
  `disabled={unsavedCount === 0}` (`stock/page.tsx:414`) and new rows carry
  `confirmed_at: null`, so a session can flip back to "confirmable". v1 UI change:
  disable Save when the active session is already confirmed. (The deeper fix —
  RPC processes only `confirmed_at IS NULL` rows — is v2.)
- **Older / concurrent session confirm.** Two sessions for the same location/day
  are allowed (`UNIQUE(session_id, product_id, location_id)`, migration 026).
  `confirmSession` has no recency guard. v1: the pending banner shows the session
  timestamp and warns if a newer confirmed session exists for this location.
  (Hard refusal is v2 / RPC.)
- **Confirm overwrites interim movement.** `product_stock = closing_units` still
  erases sales / voids / transfers / WMS credits between count-save and confirm —
  this is unchanged v1 behaviour and is **not fixed here**. Called out so v2's
  RPC applies the delta (`+= closing_units - expected_units`) instead. v1
  mitigation: the pending banner shows "stock moved by N at this location since
  this count was taken" when `product_stock.quantity != expected_units` for
  counted rows.
- **`stockMode = "central"`** is a display label only — POS still deducts at
  `currentLocationId` and per-location `product_stock` rows are real
  (`org-context.tsx:345`, `pos/page.tsx:133-149`). Per-location `expected_units`
  works mechanically. Planning step should verify no central-mode org runs more
  than one active location (mental-model mismatch only, not a correctness bug).
- **Offline** — `stock/page.tsx` save/confirm use the raw `db` client with no
  enqueue path; counts are already online-only (an offline attempt `alert()`s).
  The trigger and any queries not existing client-side is moot. Document
  "stock count requires connectivity" as a precondition.
- **PostgREST errors** — read `.message` off the error object, not
  `err instanceof Error` (PGRST errors are plain objects — `CLAUDE.md`).
- **Frontend degrades** if migration 121 is not yet applied: `expected_units` /
  `flag_kind` columns absent → no badges, no uncounted list, old behaviour. That
  is a clean *degradation*, not a licence to ship early: the frontend must not be
  **merged** before 121 is applied, because a silently flag-less Stock page gives
  the owner no signal that the control is pending — it just looks like nothing
  ever trips a flag.

### 7. Rollout

1. `supabase/migrations/121_stock_count_expected.sql` — columns + audit columns +
   `BEFORE INSERT` trigger + function + open-session backfill `UPDATE`. Pure DDL,
   no temp tables → safe as one SQL-Editor transaction. Idempotent:
   `ADD COLUMN IF NOT EXISTS`, `DROP TRIGGER IF EXISTS ... ON stock_counts`
   before `CREATE TRIGGER`, `CREATE OR REPLACE FUNCTION`. End with
   `NOTIFY pgrst, 'reload schema';`.
2. Apply by hand in the Supabase SQL Editor, then
   `node node_modules/supabase/dist/supabase.js migration repair --status applied 121`.
3. Merge the frontend PR (`stock/page.tsx` + Team card + verify script).

Migration number is **121** (highest existing file is 120; no collision — the
prompt's "118 collision" was a misread, the real historical dup is
`097_expense_categories` / `097_per_user_pins`, irrelevant here).

Forward-only otherwise; the backfill handles open sessions.

### 8. Testing

Repo has no test harness (`tilify-test-infra` is a separate open decision), so
verification matches the codebase's existing style:

- **`scripts/verify-stock-count-flags.mjs`** — read-only, service key, dry-run
  only. Given `--org`, replays the flag logic over recent confirmed sessions and
  prints what would have flagged, with rand exposure. Run against Destiny
  Independent before rollout to sanity-check thresholds against real data.
- **SQL checks** (in the PR body): insert a `stock_counts` row, assert
  `expected_units` and `flag_kind` populated; `UPDATE` its `closing_units`,
  assert `expected_units` unchanged (INSERT-only trigger).
- **Manual script** (PR body): (1) cashier counts a known-zero item at +5 →
  owner sees a `near_empty` badge; skip it instead → it appears in the
  uncounted-with-stock list; (2) +2 on 10 items in one session → `session_spread`
  on all; (3) Team card shows that cashier's 30-day flagged count and rand
  exposure; (4) `is_prepared` item at +40 → variance shown, no badge.

## Out of scope for v1 (→ v2)

- `confirm_stock_count_session` `SECURITY DEFINER` RPC; any hard gate on confirm.
- Tightening `product_stock` write RLS; converting StockPilot Import + product
  CSV upload off their direct `product_stock` writes.
- Delta-apply at confirm (`+= closing_units - expected_units`) instead of
  overwrite — the overwrite-erases-interim-movement hazard stays in v1.
- `production_log` → `product_stock` credit flow for prepared food.
- Configurable thresholds UI; making `pattern` anything more than an advisory
  badge; running RA's own count-to-count reconciliation inside a gate.
- Per-cashier view as its own route with drill-down / date ranges.

## Residual risk accepted for v1

- An owner who ignores the flags and the uncounted list, and ticks the review
  checkbox reflexively, is not stopped from confirming a fraudulent count. The
  per-cashier rollup is the compensating control — it makes the pattern visible
  over time even when individual confirms are unread.
- Below-threshold inflation on a single low-retail item across counts that stay
  under `near_empty` (e.g. `expected_units` maintained > 2 by the fraud itself)
  and under `value` / `unit_ceiling` can still pass, though `session_spread` and
  `pattern` raise the odds of catching a sustained campaign.
- The confirm still overwrites interim stock movement (see §6). v1 warns; v2
  fixes.
