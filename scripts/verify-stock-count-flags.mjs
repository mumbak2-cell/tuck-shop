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
