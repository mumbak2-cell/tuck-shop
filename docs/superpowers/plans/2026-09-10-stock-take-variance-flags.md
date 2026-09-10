# Stock-take Variance Flags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flag stock-count lines that diverge from the system's expected on-hand, show the owner the flagged lines plus every uncounted-but-in-stock product at confirm time, and accumulate a per-cashier variance picture — a detective control for phantom-stock fraud.

**Architecture:** One hand-applied SQL migration adds `expected_units` + `flag_kind` to `stock_counts`, stamped by a `BEFORE INSERT` trigger from `product_stock.quantity`. The Stock Count page (`stock/page.tsx`) renders flag badges and an uncounted-with-stock list for the owner only (cashier view stays blind), and a `session_spread` second-pass `UPDATE` after each save. A read-only per-cashier rollup card is added to the Team settings section. No `SECURITY DEFINER` RPC, no RLS changes, no hard gate in v1.

**Tech Stack:** Next.js 16 App Router (client components), Supabase (PostgreSQL + PostgREST), TypeScript, Tailwind. No test runner in this repo — verification is `tsc --noEmit` + `eslint` + SQL assertions in the Supabase SQL Editor + a dry-run `.mjs` script + manual browser checks on a Vercel preview.

**Spec:** `docs/superpowers/specs/2026-09-10-stock-take-variance-flags-design.md` — read it alongside this plan.

## Global Constraints

- **Never `supabase db push`.** Every migration is applied by hand in the Supabase SQL Editor, then recorded with `node node_modules/supabase/dist/supabase.js migration repair --status applied <NNN>`.
- **Never apply migrations while shops are trading.** PRs and reviews any time; migration 121 is pure additive DDL and low-risk, but still owner-applied outside trading hours.
- **`main` auto-deploys production.** Open PRs only; the owner (Mumba) merges.
- Migration number is **121** (highest existing file is `120_*`; no collision).
- Migration 121 must be **idempotent** and safe as one SQL-Editor transaction: `ADD COLUMN IF NOT EXISTS`, `DROP TRIGGER IF EXISTS ... ON stock_counts` before `CREATE TRIGGER`, `CREATE OR REPLACE FUNCTION`. No temp tables. End the file with `NOTIFY pgrst, 'reload schema';`.
- **Cashiers must never see `expected_units` or the variance.** All flag/variance/uncounted UI is gated behind `!isCashierView` (`stock/page.tsx:63`), exactly as the existing `Expected: N` text and variance number are.
- **Flag pricing uses `products.selling_price`** (NOT NULL) — never `cost_per_unit` (frequently NULL).
- **`is_prepared = true` products get no `flag_kind`** and never trip `pattern`.
- Type-check with the incremental cache cleared: `rm -f tsconfig.tsbuildinfo && node node_modules/typescript/bin/tsc --noEmit`.
- Lint a single file with `node node_modules/eslint/bin/eslint.js "<path>"`. `stock/page.tsx` and `team-section.tsx` already carry pre-existing `@typescript-eslint/no-explicit-any` and hook-ordering errors on `main` — the bar is **no new errors**, not zero errors. Confirm by linting the file on `main` first and diffing the count.
- Deviation from spec, pre-approved: the `audit_logs` write on confirm (spec §4) is **dropped from v1**. `audit_logs` has no client INSERT policy (append-only, migration 079) so a client insert fails RLS silently; adding a `SECURITY DEFINER` helper is v2 scope. The `stock_counts` columns (`counted_by`, `confirmed_by`, `confirmed_at`, `flag_kind`, `review_note`) already carry the accountability trail the Team card reads.

---

### Task 1: Migration 121 — `expected_units`, `flag_kind`, trigger, backfill

**Files:**
- Create: `supabase/migrations/121_stock_count_expected.sql`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `stock_counts.expected_units INTEGER` (nullable), `stock_counts.flag_kind TEXT` (nullable, one of `near_empty` | `value` | `unit_ceiling` | `session_spread` | `pattern` | NULL), `stock_counts.review_note TEXT` (nullable), `stock_count_audit.expected_units_old INTEGER`, `stock_count_audit.expected_units_new INTEGER`. A `BEFORE INSERT` trigger `trg_stamp_stock_count_expected` on `stock_counts` calling `public.stamp_stock_count_expected()` that sets `NEW.expected_units` and `NEW.flag_kind`. The `session_spread` value is produced by Task 3's app code, not this trigger.

- [ ] **Step 1: Write the migration file**

Create `supabase/migrations/121_stock_count_expected.sql`:

```sql
-- ============================================================
-- Migration 121: Stock-take variance flags (v1)
--
-- Adds an immutable "expected on hand" snapshot and a per-line flag to
-- stock_counts, stamped by a BEFORE INSERT trigger from product_stock.
-- Detective control only: nothing here blocks a confirm. See
-- docs/superpowers/specs/2026-09-10-stock-take-variance-flags-design.md
--
-- Apply: Supabase SQL Editor, outside trading hours. Then:
--   node node_modules/supabase/dist/supabase.js migration repair --status applied 121
-- Idempotent, safe to re-run.
-- ============================================================

BEGIN;

-- ---- Part 1: columns --------------------------------------------------
ALTER TABLE public.stock_counts
  ADD COLUMN IF NOT EXISTS expected_units INTEGER,
  ADD COLUMN IF NOT EXISTS flag_kind      TEXT,
  ADD COLUMN IF NOT EXISTS review_note    TEXT;

ALTER TABLE public.stock_count_audit
  ADD COLUMN IF NOT EXISTS expected_units_old INTEGER,
  ADD COLUMN IF NOT EXISTS expected_units_new INTEGER;

-- ---- Part 2: flag thresholds (tune here) ----------------------------
--   near_empty   : expected <= 2 AND variance >= 3        (always flags, price-independent)
--   value        : abs(variance) * selling_price >= 100
--   unit_ceiling : abs(variance) >= 15
--   pattern      : same product+location, same-direction variance across the
--                  last 2 confirmed sessions + this one
--   session_spread : set by the app (needs session aggregates), not here
-- Priority: near_empty > value > unit_ceiling > pattern. First match wins.

-- ---- Part 3: trigger function -------------------------------------
CREATE OR REPLACE FUNCTION public.stamp_stock_count_expected()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expected   INTEGER;
  v_variance   INTEGER;
  v_price      NUMERIC;
  v_prepared   BOOLEAN;
  v_prev_dirs  INTEGER;   -- count of prior confirmed sessions with same-sign variance
BEGIN
  IF NEW.closing_units IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(ps.quantity, 0)
    INTO v_expected
    FROM (SELECT 1) _
    LEFT JOIN public.product_stock ps
      ON ps.product_id = NEW.product_id
     AND ps.location_id = NEW.location_id;
  v_expected := COALESCE(v_expected, 0);

  NEW.expected_units := v_expected;
  v_variance := NEW.closing_units - v_expected;

  SELECT p.selling_price, p.is_prepared
    INTO v_price, v_prepared
    FROM public.products p
   WHERE p.id = NEW.product_id;

  -- Prepared-food items legitimately run +variance every count until a
  -- production_log -> product_stock credit flow exists. No flag.
  IF COALESCE(v_prepared, false) THEN
    NEW.flag_kind := NULL;
    RETURN NEW;
  END IF;

  IF v_expected <= 2 AND v_variance >= 3 THEN
    NEW.flag_kind := 'near_empty';
  ELSIF abs(v_variance) * COALESCE(v_price, 0) >= 100 THEN
    NEW.flag_kind := 'value';
  ELSIF abs(v_variance) >= 15 THEN
    NEW.flag_kind := 'unit_ceiling';
  ELSE
    -- pattern: last 2 CONFIRMED sessions for this product+location with a
    -- variance in the same direction as this one.
    IF v_variance <> 0 THEN
      SELECT count(*)
        INTO v_prev_dirs
        FROM (
          SELECT sc.closing_units - sc.expected_units AS prev_var
            FROM public.stock_counts sc
           WHERE sc.product_id = NEW.product_id
             AND sc.location_id = NEW.location_id
             AND sc.confirmed_at IS NOT NULL
             AND sc.expected_units IS NOT NULL
             AND sc.closing_units IS NOT NULL
           ORDER BY sc.confirmed_at DESC
           LIMIT 2
        ) recent
       WHERE sign(recent.prev_var) = sign(v_variance)
         AND recent.prev_var <> 0;

      IF v_prev_dirs = 2 THEN
        NEW.flag_kind := 'pattern';
      ELSE
        NEW.flag_kind := NULL;
      END IF;
    ELSE
      NEW.flag_kind := NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.stamp_stock_count_expected() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stamp_stock_count_expected() TO authenticated;

-- ---- Part 4: trigger (INSERT only — never re-stamp on edit/confirm) --
DROP TRIGGER IF EXISTS trg_stamp_stock_count_expected ON public.stock_counts;
CREATE TRIGGER trg_stamp_stock_count_expected
  BEFORE INSERT ON public.stock_counts
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_stock_count_expected();

-- ---- Part 5: backfill open (unconfirmed) sessions ------------------
-- Only rows still pending review — older confirmed rows stay NULL and
-- simply carry no badge. Uses the same COALESCE(...,0) rule; does NOT
-- compute flag_kind for backfilled rows (no trigger fires on UPDATE),
-- which is acceptable: the owner reviews these once with variance visible.
UPDATE public.stock_counts sc
   SET expected_units = COALESCE(
         (SELECT ps.quantity FROM public.product_stock ps
           WHERE ps.product_id = sc.product_id
             AND ps.location_id = sc.location_id), 0)
 WHERE sc.confirmed_at IS NULL
   AND sc.closing_units IS NOT NULL
   AND sc.expected_units IS NULL;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- Verification (run manually in the SQL Editor after applying):
--
-- 1. columns exist:
--    SELECT column_name FROM information_schema.columns
--     WHERE table_name = 'stock_counts'
--       AND column_name IN ('expected_units','flag_kind','review_note');
--    -- expect 3 rows
--
-- 2. trigger stamps on INSERT (use a real product_id + location_id from
--    your org; pick a product whose product_stock.quantity you know):
--    INSERT INTO stock_counts (session_id, product_id, location_id,
--        count_date, closing_units, counted_by, org_id)
--    VALUES (gen_random_uuid(), '<product_id>', '<location_id>',
--        CURRENT_DATE, 999, 'migration test', '<org_id>')
--    RETURNING expected_units, flag_kind;
--    -- expect expected_units = that product's product_stock.quantity,
--    --        flag_kind = 'unit_ceiling' (999 is way over) or 'value'
--
-- 3. re-save does NOT move the baseline:
--    UPDATE stock_counts SET closing_units = 1
--     WHERE counted_by = 'migration test'
--    RETURNING expected_units;
--    -- expect expected_units UNCHANGED from step 2
--
-- 4. clean up:  DELETE FROM stock_counts WHERE counted_by = 'migration test';
-- ============================================================
```

- [ ] **Step 2: Static check the SQL**

Run: `cat supabase/migrations/121_stock_count_expected.sql` and eyeball against the Global Constraints — `IF NOT EXISTS` on every `ADD COLUMN`, `DROP TRIGGER IF EXISTS` before `CREATE TRIGGER`, `CREATE OR REPLACE FUNCTION`, trailing `NOTIFY pgrst`.
Expected: all present. No temp tables. Single `BEGIN; ... COMMIT;` for the DDL, `NOTIFY` after.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/121_stock_count_expected.sql
git commit -m "Add migration 121: stock_counts expected_units + flag_kind trigger"
```

- [ ] **Step 4: OWNER MUST DO (not the implementer)**

Apply `121_stock_count_expected.sql` in the Supabase SQL Editor (project `pkufxpyrvcygobrgneep`) outside trading hours, run the four verification queries in the file's footer, then:
`node node_modules/supabase/dist/supabase.js migration repair --status applied 121`

The remaining tasks' frontend degrades cleanly if 121 is not yet applied (columns absent → `null` → no badges), so they can be built and PR'd in parallel; they must not be **merged** before 121 is applied.

---

### Task 2: `verify-stock-count-flags.mjs` — dry-run flag replay

**Files:**
- Create: `scripts/verify-stock-count-flags.mjs`

**Interfaces:**
- Consumes: `stock_counts.expected_units`, `stock_counts.flag_kind` (Task 1), `products.selling_price`, `products.is_prepared`.
- Produces: a CLI script — `node --env-file=.env.local scripts/verify-stock-count-flags.mjs --org "<name>" [--days 60]`. Read-only, no `--apply`. Prints, per recent session, each line's `expected` / `counted` / `variance` / recomputed `flag_kind` / rand exposure, and the session-level `session_spread` verdict.

- [ ] **Step 1: Write the script**

Create `scripts/verify-stock-count-flags.mjs`:

```js
// Read-only. Replays the migration-121 flag logic over recent stock-count
// sessions for one org so thresholds can be sanity-checked against real
// data. No writes, no --apply.
//
// Usage: node --env-file=.env.local scripts/verify-stock-count-flags.mjs --org "Destiny Independent" [--days 60]

import { createClient } from "@supabase/supabase-js";

const args = process.argv.slice(2);
const orgName = valueOf("--org");
const days = Number(valueOf("--days") || 60);

function valueOf(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

if (!orgName) {
  console.error('Missing --org "<organisation name>"');
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (--env-file=.env.local)");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

// --- thresholds: keep in sync with migration 121 ---
const NEAR_EMPTY_EXPECTED_MAX = 2;
const NEAR_EMPTY_VARIANCE_MIN = 3;
const VALUE_RAND_MIN = 100;
const UNIT_CEILING_MIN = 15;
const SPREAD_LINE_COUNT_MIN = 8;
const SPREAD_RAND_MIN = 150;

function lineFlag({ expected, counted, price, prepared }) {
  if (prepared) return null;
  const v = counted - expected;
  if (expected <= NEAR_EMPTY_EXPECTED_MAX && v >= NEAR_EMPTY_VARIANCE_MIN) return "near_empty";
  if (Math.abs(v) * (price || 0) >= VALUE_RAND_MIN) return "value";
  if (Math.abs(v) >= UNIT_CEILING_MIN) return "unit_ceiling";
  return null; // pattern needs cross-session history — reported separately below
}

const { data: org, error: orgErr } = await db
  .from("organizations").select("id, name").ilike("name", orgName).maybeSingle();
if (orgErr || !org) {
  console.error("Org not found:", orgName, orgErr?.message || "");
  process.exit(1);
}

const cutoff = new Date();
cutoff.setDate(cutoff.getDate() - days);

const { data: rows, error } = await db
  .from("stock_counts")
  .select("session_id, session_label, counted_by, counted_at, confirmed_at, location_id, product_id, closing_units, expected_units, flag_kind, products(name, selling_price, is_prepared)")
  .eq("org_id", org.id)
  .gte("count_date", cutoff.toISOString().slice(0, 10))
  .not("closing_units", "is", null)
  .order("counted_at", { ascending: false });

if (error) { console.error(error.message); process.exit(1); }

const bySession = new Map();
for (const r of rows || []) {
  if (!bySession.has(r.session_id)) bySession.set(r.session_id, []);
  bySession.get(r.session_id).push(r);
}

console.log(`\n${org.name} — last ${days} days — ${bySession.size} sessions\n`);

for (const [sid, lines] of bySession) {
  const head = lines[0];
  let sessionExposure = 0;
  let sameDirLines = 0;
  const flagged = [];

  for (const r of lines) {
    if (r.expected_units == null) continue; // no baseline (pre-migration)
    const price = Number(r.products?.selling_price) || 0;
    const prepared = !!r.products?.is_prepared;
    const v = r.closing_units - r.expected_units;
    const kind = lineFlag({ expected: r.expected_units, counted: r.closing_units, price, prepared });
    if (v > 0 && !prepared) sameDirLines += 1;
    if (kind) {
      const exposure = Math.abs(v) * price;
      sessionExposure += exposure;
      flagged.push({ name: r.products?.name, v, kind, exposure, stored: r.flag_kind });
    }
  }

  const positiveExposure = lines.reduce((s, r) => {
    if (r.expected_units == null || r.products?.is_prepared) return s;
    const v = r.closing_units - r.expected_units;
    return v > 0 ? s + v * (Number(r.products?.selling_price) || 0) : s;
  }, 0);
  const spread = sameDirLines >= SPREAD_LINE_COUNT_MIN || positiveExposure >= SPREAD_RAND_MIN;

  console.log(`— ${head.session_label || "Stock Count"} · ${head.counted_by} · ${head.counted_at?.slice(0, 16)} · ${head.confirmed_at ? "confirmed" : "PENDING"}`);
  if (flagged.length === 0 && !spread) { console.log("  (nothing flagged)\n"); continue; }
  for (const f of flagged) {
    const mismatch = f.stored && f.stored !== f.kind ? `  [stored: ${f.stored}]` : "";
    console.log(`  ${f.v > 0 ? "+" : ""}${f.v}  ${f.kind.padEnd(12)}  R${f.exposure.toFixed(2).padStart(8)}  ${f.name}${mismatch}`);
  }
  if (spread) console.log(`  session_spread: ${sameDirLines} same-direction lines, R${positiveExposure.toFixed(2)} positive exposure`);
  console.log("");
}
```

- [ ] **Step 2: Syntax-check**

Run: `node --check scripts/verify-stock-count-flags.mjs`
Expected: no output, exit 0.

- [ ] **Step 3: Run it against real data**

Run: `node --env-file=.env.local scripts/verify-stock-count-flags.mjs --org "Destiny Independent" --days 60`
Expected: prints sessions with per-line flags and `session_spread` verdicts. For sessions whose rows were stamped by the trigger (created after migration 121), the recomputed `flag_kind` should equal the `[stored: …]` value — if a mismatch prints, the script's constants and the migration's have drifted; reconcile. For pre-migration sessions, `expected_units` is NULL and lines are skipped (`(nothing flagged)` is expected).

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-stock-count-flags.mjs
git commit -m "Add scripts/verify-stock-count-flags.mjs (dry-run flag replay)"
```

---

### Task 3: `stock/page.tsx` — flag badges, pending banner, `session_spread` second pass, lock confirmed sessions

**Files:**
- Modify: `src/app/(dashboard)/stock/page.tsx`

**Interfaces:**
- Consumes: `stock_counts.expected_units`, `stock_counts.flag_kind` (Task 1).
- Produces: an extended `StockRow` (`expectedUnits: number | null`, `flagKind: FlagKind`), where `type FlagKind = "near_empty" | "value" | "unit_ceiling" | "session_spread" | "pattern" | null`. A `spreadUpdate()` call inside `saveAllCounts` that runs the `session_spread` second pass. Task 4 relies on the same `StockRow` shape and the `flaggedRows` / `overCount` / `underCount` derived values defined here.

- [ ] **Step 1: Extend the row type and the session-row load**

In `src/app/(dashboard)/stock/page.tsx`, change the `StockRow` interface (currently at `:22-27`):

```tsx
type FlagKind =
  | "near_empty"
  | "value"
  | "unit_ceiling"
  | "session_spread"
  | "pattern"
  | null;

interface StockRow {
  product: Product;
  expected: number; // product_stock.quantity at currentLocationId, at page load
  expectedUnits: number | null; // frozen snapshot from stock_counts, once saved
  flagKind: FlagKind;
  closingCount: string; // text input value
  saved: boolean;
}
```

Find the session-detail load (currently `db.from("stock_counts").select("product_id, closing_units").eq("session_id", activeSessionId)` around `:160-167`). Change the select to:

```tsx
      .select("product_id, closing_units, expected_units, flag_kind")
```

and where each `StockRow` is built from that data, populate the new fields (fall back to nulls when the columns are absent — migration not yet applied):

```tsx
      expectedUnits: countMap.get(p.id)?.expected_units ?? null,
      flagKind: (countMap.get(p.id)?.flag_kind ?? null) as FlagKind,
```

Adjust `countMap` so it stores the row object, not just `closing_units` — currently `countMap.set(c.product_id, c.closing_units)` at `:167`; make it `countMap.set(c.product_id, c)` and update the two existing reads (`countMap.has(p.id)` stays; `countMap.get(p.id)!` becomes `countMap.get(p.id)!.closing_units`).

- [ ] **Step 2: Type-check**

Run: `rm -f tsconfig.tsbuildinfo && node node_modules/typescript/bin/tsc --noEmit`
Expected: clean (no errors referencing `stock/page.tsx`).

- [ ] **Step 3: Add derived flag summaries**

Near the other `filtered` / `savedCount` derivations (around `:374-386`), add:

```tsx
  const flaggedRows = rows.filter((r) => r.flagKind !== null);
  const flaggedCount = flaggedRows.length;
  const overCount = rows.filter(
    (r) => r.closingCount !== "" && r.expectedUnits !== null && parseInt(r.closingCount) > r.expectedUnits,
  ).length;
  const underCount = rows.filter(
    (r) => r.closingCount !== "" && r.expectedUnits !== null && parseInt(r.closingCount) < r.expectedUnits,
  ).length;
```

- [ ] **Step 4: Render a badge per flagged row (owner only)**

In the row render (the block at `:601-654`), after the existing variance `<span>` (`:639-652`), add — still inside `!isCashierView`:

```tsx
                  {row.flagKind && !isCashierView && (
                    <span
                      className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                        row.flagKind === "near_empty"
                          ? "bg-red-100 text-red-700"
                          : row.flagKind === "value" || row.flagKind === "unit_ceiling"
                          ? "bg-amber-100 text-amber-700"
                          : "bg-gray-100 text-gray-600"
                      }`}
                      title={FLAG_LABEL[row.flagKind]}
                    >
                      {FLAG_SHORT[row.flagKind]}
                    </span>
                  )}
```

Add the label maps near the top of the file (module scope, after imports):

```tsx
const FLAG_SHORT: Record<Exclude<FlagKind, null>, string> = {
  near_empty: "near-empty",
  value: "R value",
  unit_ceiling: "big swing",
  session_spread: "spread",
  pattern: "repeat",
};
const FLAG_LABEL: Record<Exclude<FlagKind, null>, string> = {
  near_empty: "Counted well above stock the system thinks is nearly gone",
  value: "Variance worth R100+ at selling price",
  unit_ceiling: "Variance of 15+ units",
  session_spread: "Part of a session with many same-direction variances",
  pattern: "Same-direction variance 3 counts running",
};
```

Also change the `Expected: ${row.expected}` text (`:619`) to prefer the frozen snapshot:

```tsx
                    {row.product.category}{!isCashierView && ` · Expected: ${row.expectedUnits ?? row.expected}`} · {formatZAR(row.product.selling_price)}
```

- [ ] **Step 5: Rewrite the pending-session banner**

Replace the paragraph inside the `canConfirmSession` banner (`:428-434`, the `<p>` starting "Stock levels still show the old figures…") with:

```tsx
            <p className="text-sm text-amber-800 mt-1">
              {activeSession.countedBy} counted {activeSession.productCount} product
              {activeSession.productCount !== 1 ? "s" : ""} in &ldquo;{activeSession.label}&rdquo;.
              {flaggedCount > 0 && (
                <> <strong>{flaggedCount} flagged</strong> — {overCount} over expected, {underCount} under.</>
              )}
              {" "}Stock levels still show the old figures until you confirm.
            </p>
```

- [ ] **Step 6: Add the `session_spread` second pass to `saveAllCounts`**

In `saveAllCounts`, after the existing `stock_counts` upsert succeeds and after the `stock_count_audit` insert (around `:288`), add:

```tsx
    // session_spread: a session with many same-direction variances, or a large
    // summed positive exposure, is itself the anomaly. Needs session-level
    // aggregates a per-row trigger can't see, so it's a second pass here.
    await applySessionSpread(sessionId, currentLocationId);
```

Add the function (module scope or inside the component — inside is fine, it needs `db`):

```tsx
  async function applySessionSpread(sessionId: string, locationId: string) {
    const { data } = await db
      .from("stock_counts")
      .select("closing_units, expected_units, flag_kind, products(selling_price, is_prepared)")
      .eq("session_id", sessionId)
      .eq("location_id", locationId)
      .not("closing_units", "is", null);
    const lines = (data || []) as any[];
    let sameDir = 0;
    let posExposure = 0;
    for (const l of lines) {
      if (l.expected_units == null || l.products?.is_prepared) continue;
      const v = l.closing_units - l.expected_units;
      if (v > 0) {
        sameDir += 1;
        posExposure += v * (Number(l.products?.selling_price) || 0);
      }
    }
    const spread = sameDir >= 8 || posExposure >= 150;
    if (!spread) return;
    await db
      .from("stock_counts")
      .update({ flag_kind: "session_spread" })
      .eq("session_id", sessionId)
      .eq("location_id", locationId)
      .is("flag_kind", null)
      .not("closing_units", "is", null);
  }
```

- [ ] **Step 7: Disable Save on an already-confirmed session**

The Save button (`:411-418`) is `disabled={unsavedCount === 0}`. Change to also block when the active session is confirmed:

```tsx
          disabled={unsavedCount === 0 || activeSession?.confirmedAt != null}
```

- [ ] **Step 8: Type-check and lint**

Run: `rm -f tsconfig.tsbuildinfo && node node_modules/typescript/bin/tsc --noEmit`
Expected: clean.

Run: `git stash && node node_modules/eslint/bin/eslint.js "src/app/(dashboard)/stock/page.tsx" 2>&1 | grep -c error; git stash pop && node node_modules/eslint/bin/eslint.js "src/app/(dashboard)/stock/page.tsx" 2>&1 | grep -c error`
Expected: the second number equals the first (no new errors). If `git stash` risks colliding with other worktrees, instead lint `git show main:"src/app/(dashboard)/stock/page.tsx"` written to a temp path and compare counts.

- [ ] **Step 9: Commit**

```bash
git add "src/app/(dashboard)/stock/page.tsx"
git commit -m "Stock count: flag badges, pending-banner summary, session_spread pass"
```

---

### Task 4: `stock/page.tsx` — uncounted-with-stock list, review checkbox, review notes, stock-moved warning

**Files:**
- Modify: `src/app/(dashboard)/stock/page.tsx`

**Interfaces:**
- Consumes: `StockRow` (`expectedUnits`, `flagKind`), `flaggedRows`, `flaggedCount` (Task 3); `expectedMap` (`:105-108`, product_stock quantities at page load); `rows`.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Derive the uncounted-with-stock list**

Near the Task 3 derivations, add:

```tsx
  const uncountedWithStock = rows.filter(
    (r) => r.closingCount === "" && (expectedMap.get(r.product.id) ?? 0) > 0,
  );
  const stockMovedSince = rows.some(
    (r) =>
      r.closingCount !== "" &&
      r.expectedUnits !== null &&
      (expectedMap.get(r.product.id) ?? 0) !== r.expectedUnits,
  );
```

- [ ] **Step 2: Render the uncounted list + stock-moved warning (owner only)**

Directly after the `canConfirmSession` banner block (`:446`), add — gated on `canConfirmSession && !isCashierView`:

```tsx
      {canConfirmSession && !isCashierView && uncountedWithStock.length > 0 && (
        <details className="bg-white border border-amber-200 rounded-xl mb-6 px-4 py-3">
          <summary className="text-sm font-medium text-amber-900 cursor-pointer">
            {uncountedWithStock.length} product{uncountedWithStock.length !== 1 ? "s" : ""} with stock on hand were not counted
          </summary>
          <ul className="mt-2 text-sm text-gray-600 space-y-1">
            {uncountedWithStock.map((r) => (
              <li key={r.product.id} className="flex justify-between">
                <span className="truncate">{r.product.name}</span>
                <span className="tabular-nums text-gray-400">system: {expectedMap.get(r.product.id) ?? 0}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {canConfirmSession && !isCashierView && stockMovedSince && (
        <p className="text-xs text-amber-700 mb-4">
          Stock has moved at this branch since this count was taken — confirming will overwrite those changes with the counted figures.
        </p>
      )}
```

- [ ] **Step 3: Add the review checkbox gating Confirm**

Add component state near the other `useState` calls:

```tsx
  const [reviewAck, setReviewAck] = useState(false);
```

Reset it when the active session changes — extend the effect that loads session counts, or add:

```tsx
  useEffect(() => {
    setReviewAck(false);
  }, [sessionId]);
```

In the `canConfirmSession` banner, immediately before the `<Button onClick={confirmSession}>` (`:435`), add:

```tsx
            {(flaggedCount > 0 || uncountedWithStock.length > 0) && (
              <label className="flex items-start gap-2 mt-3 text-sm text-amber-900">
                <input
                  type="checkbox"
                  checked={reviewAck}
                  onChange={(e) => setReviewAck(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  I&apos;ve reviewed the {flaggedCount} flagged line{flaggedCount !== 1 ? "s" : ""}
                  {uncountedWithStock.length > 0 && ` and ${uncountedWithStock.length} uncounted item${uncountedWithStock.length !== 1 ? "s" : ""}`}.
                </span>
              </label>
            )}
```

Change the Confirm `<Button>` to require it:

```tsx
            <Button
              onClick={confirmSession}
              loading={confirming}
              className="mt-3"
              size="sm"
              disabled={
                (flaggedCount > 0 || uncountedWithStock.length > 0) && !reviewAck
              }
            >
```

- [ ] **Step 4: Optional per-flagged-row review note**

In the row render, inside `!isCashierView`, after the flag badge from Task 3, add — only for flagged rows:

```tsx
                  {row.flagKind && !isCashierView && (
                    <input
                      type="text"
                      placeholder="note (optional)"
                      value={noteDraft[row.product.id] ?? ""}
                      onChange={(e) =>
                        setNoteDraft((d) => ({ ...d, [row.product.id]: e.target.value }))
                      }
                      className="w-40 text-xs px-2 py-1 border border-gray-200 rounded"
                    />
                  )}
```

Add state:

```tsx
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({});
```

Reset it alongside `reviewAck` in the `[sessionId]` effect (`setNoteDraft({})`).

In `confirmSession`, before the `product_stock` upsert, persist any notes:

```tsx
    const noteEntries = Object.entries(noteDraft).filter(([, v]) => v.trim() !== "");
    if (noteEntries.length > 0) {
      await Promise.all(
        noteEntries.map(([productId, note]) =>
          db
            .from("stock_counts")
            .update({ review_note: note.trim() })
            .eq("session_id", sessionId)
            .eq("location_id", currentLocationId)
            .eq("product_id", productId),
        ),
      );
    }
```

- [ ] **Step 5: Type-check and lint**

Run: `rm -f tsconfig.tsbuildinfo && node node_modules/typescript/bin/tsc --noEmit`
Expected: clean.

Run the same before/after eslint-count comparison as Task 3 Step 8.
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(dashboard)/stock/page.tsx"
git commit -m "Stock count: uncounted-with-stock list, review ack, per-line notes"
```

- [ ] **Step 7: Manual browser check (Vercel preview on the PR)**

After opening the PR (all frontend tasks), and after migration 121 is applied to prod (Task 1 Step 4), hard-reload the preview's Stock Count page as the owner:
1. Count a product whose branch stock is 0 at, say, `5` → save → the row shows a red `near-empty` badge; the pending banner reads "1 flagged — 1 over expected, 0 under".
2. Leave a product that has stock uncounted → it appears in the "products with stock on hand were not counted" list.
3. The Confirm button is disabled until the review checkbox is ticked.
4. Enter `+2` on 8+ products in one session → save → all eight show a `spread` badge.
5. As a cashier PIN, the same page shows no expected figure, no variance, no badges.

---

### Task 5: Team settings — per-cashier variance card

**Files:**
- Modify: `src/components/settings/team-section.tsx`

**Interfaces:**
- Consumes: `stock_counts.expected_units`, `stock_counts.flag_kind`, `stock_counts.counted_by`, `stock_counts.closing_units` (Task 1); `products.selling_price`.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Read the file and locate the render point**

Run: `sed -n '1,60p' src/components/settings/team-section.tsx` and find where the members list renders and what `useOrg()` / role gating is already in scope (`role === "owner"`). The card renders only for `role === "owner"`.

- [ ] **Step 2: Add the query + state**

Inside the component, add:

```tsx
  const [varianceDays, setVarianceDays] = useState<30 | 60 | 90>(30);
  const [variance, setVariance] = useState<
    { countedBy: string; sessions: number; over: number; under: number; exposure: number }[]
  >([]);

  useEffect(() => {
    if (role !== "owner" || !orgId) return;
    (async () => {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - varianceDays);
      const { data } = await db
        .from("stock_counts")
        .select("session_id, counted_by, closing_units, expected_units, flag_kind, products(selling_price)")
        .eq("org_id", orgId)
        .gte("count_date", cutoff.toISOString().slice(0, 10))
        .not("closing_units", "is", null)
        .not("expected_units", "is", null);
      const byCashier = new Map<
        string,
        { countedBy: string; sessionIds: Set<string>; over: number; under: number; exposure: number }
      >();
      for (const r of (data || []) as any[]) {
        const name = r.counted_by || "Unknown";
        if (!byCashier.has(name))
          byCashier.set(name, { countedBy: name, sessionIds: new Set(), over: 0, under: 0, exposure: 0 });
        const e = byCashier.get(name)!;
        e.sessionIds.add(r.session_id);
        if (!r.flag_kind) continue;
        const v = r.closing_units - r.expected_units;
        if (v > 0) e.over += 1;
        else if (v < 0) e.under += 1;
        e.exposure += Math.abs(v) * (Number(r.products?.selling_price) || 0);
      }
      setVariance(
        [...byCashier.values()]
          .map((e) => ({
            countedBy: e.countedBy,
            sessions: e.sessionIds.size,
            over: e.over,
            under: e.under,
            exposure: e.exposure,
          }))
          .sort((a, b) => b.exposure - a.exposure),
      );
    })();
  }, [role, orgId, varianceDays]);
```

Ensure `db` is imported (`import { db } from "@/lib/supabase";`), and `useState`/`useEffect` are in the React import. `orgId` and `role` come from `useOrg()` — add them to the existing destructure if not already there.

- [ ] **Step 3: Render the card (owner only)**

Add, after the existing team members list:

```tsx
      {role === "owner" && (
        <div className="bg-white rounded-xl border border-gray-200 mt-6 p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-900">Stock-count variance by person</h3>
            <div className="flex gap-1">
              {([30, 60, 90] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => setVarianceDays(d)}
                  className={`text-xs px-2 py-1 rounded ${
                    varianceDays === d ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600"
                  }`}
                >
                  {d}d
                </button>
              ))}
            </div>
          </div>
          {variance.length === 0 ? (
            <p className="text-sm text-gray-400">No counts in this window.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500">
                  <th className="py-1">Person</th>
                  <th className="py-1 text-right">Counts</th>
                  <th className="py-1 text-right">Flagged over</th>
                  <th className="py-1 text-right">Flagged under</th>
                  <th className="py-1 text-right">Rand exposure</th>
                </tr>
              </thead>
              <tbody>
                {variance.map((v) => (
                  <tr key={v.countedBy} className="border-t border-gray-100">
                    <td className="py-1.5">{v.countedBy}</td>
                    <td className="py-1.5 text-right tabular-nums">{v.sessions}</td>
                    <td className={`py-1.5 text-right tabular-nums ${v.over > 0 ? "text-amber-700 font-medium" : "text-gray-400"}`}>{v.over}</td>
                    <td className={`py-1.5 text-right tabular-nums ${v.under > 0 ? "text-red-700 font-medium" : "text-gray-400"}`}>{v.under}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatZAR(v.exposure)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
```

Ensure `formatZAR` is imported (`import { formatZAR } from "@/lib/format";`).

- [ ] **Step 4: Type-check and lint**

Run: `rm -f tsconfig.tsbuildinfo && node node_modules/typescript/bin/tsc --noEmit`
Expected: clean.

Run the before/after eslint-count comparison for `src/components/settings/team-section.tsx`.
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/team-section.tsx
git commit -m "Team settings: per-person stock-count variance card"
```

- [ ] **Step 6: Open the PR**

```bash
git push -u origin feat/stock-take-variance-flags
gh pr create --base main --head feat/stock-take-variance-flags \
  --title "Stock-take variance flags (v1)" \
  --body "$(cat <<'EOF'
Implements docs/superpowers/specs/2026-09-10-stock-take-variance-flags-design.md

- Migration 121: stock_counts.expected_units + flag_kind, BEFORE INSERT trigger, backfill of open sessions. **Owner applies by hand + migration repair 121 before merge.**
- Stock Count page (owner view only; cashier stays blind): flag badges, pending-banner flag summary, uncounted-with-stock list, review-ack checkbox, optional per-line notes, session_spread second pass, Save disabled on confirmed sessions, stock-moved warning.
- Team settings: read-only per-person variance card (30/60/90d — counts, flagged over/under, rand exposure).
- scripts/verify-stock-count-flags.mjs: dry-run flag replay for threshold tuning.

No SECURITY DEFINER RPC, no RLS changes, no hard gate — detective control only (see spec §"Residual risk"). audit_logs write dropped from v1 (append-only, no client policy).

Manual test steps in the plan, Task 4 Step 7.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**1. Spec coverage**

| Spec section | Task |
|---|---|
| §1 data model — `expected_units`, `flag_kind`, `review_note`, audit columns | Task 1 Step 1 |
| §2 `BEFORE INSERT` trigger, `COALESCE(…,0)`, StockPilot blind spot (documented) | Task 1 Step 1 (Part 3–4); blind spot noted in migration comment |
| §3 flag rules `near_empty`/`value`/`unit_ceiling`/`pattern` (trigger) + `session_spread` (app second pass) + `is_prepared` exclusion + priority | Task 1 Step 1 (Part 3), Task 3 Step 6 |
| §4 owner UI — badges, `Expected` from snapshot, pending banner, uncounted list, review checkbox, `review_note`, session/location scoping | Tasks 3 (badges, banner, snapshot) + 4 (uncounted, checkbox, notes) |
| §4 `audit_logs` write | **Dropped from v1** — Global Constraints + plan header note |
| §5 per-cashier card on Team page | Task 5 |
| §6 edge cases — NULL baseline, re-save into confirmed session (disable Save), older/concurrent session warning, stock-moved warning, `stockMode` | Task 1 (COALESCE), Task 3 Step 7, Task 4 Steps 1–2 |
| §7 rollout — migration 121, idempotent, `NOTIFY pgrst`, backfill, `migration repair` | Task 1 Steps 1 + 4 |
| §8 testing — `verify-stock-count-flags.mjs`, SQL checks, manual script | Task 2, Task 1 footer, Task 4 Step 7 |
| §"out of scope" — RPC, RLS tightening, delta-apply, production_log, config UI | Not implemented, by design |

Concurrent-session **hard refusal** (spec §6) is intentionally a warning only in v1 (spec says "Hard refusal is v2 / RPC"). Covered as a warning via `stockMovedSince` — acceptable partial per the spec's own wording.

**2. Placeholder scan** — no TBD/TODO. Every code step has literal code. Manual-test step (Task 4 Step 7) lists concrete assertions.

**3. Type consistency** — `FlagKind` defined in Task 3 Step 1, reused in Tasks 3–4 (`FLAG_SHORT`/`FLAG_LABEL` keyed on `Exclude<FlagKind, null>`). `StockRow.expectedUnits: number | null` / `flagKind: FlagKind` consistent across Tasks 3–4. `applySessionSpread(sessionId, locationId)` — one call site (Task 3 Step 6), one definition. Team card's local `variance` row shape defined once in Task 5 Step 2, consumed in Step 3. Migration column names (`expected_units`, `flag_kind`, `review_note`) identical in Tasks 1, 2, 3, 4, 5.
