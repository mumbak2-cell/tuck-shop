// One-off reconciliation: for wms_dispatches whose wms_catalog items were
// unlinked at the time of dispatch, credit the destination shop's
// product_stock with the qty_sent that never landed. Reads the current
// wms_catalog.product_id (populated by migration 081's backfill), so this
// script MUST be run AFTER 081 is applied.
//
// Idempotency: this script cannot tell whether a given dispatch has already
// been reconciled — there is no marker column. It therefore refuses to run
// automatically. Pass --dispatch-ids "1,2,3" to name exactly which dispatch
// ids to credit. Dry-run by default; add --apply to write.
//
// Usage:
//   node --env-file=.env.local scripts/reconcile-past-dispatches.mjs \
//     --org 241581b1-534f-40f1-92c0-6df189fc47cc \
//     --dispatch-ids 1,2,3 [--apply]

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = arr[i + 1];
      if (next === undefined || next.startsWith("--")) acc.push([k, true]);
      else acc.push([k, next]);
    }
    return acc;
  }, [])
);

const orgId = args.org;
const idsArg = args["dispatch-ids"];
const apply = args.apply === true;
if (!orgId || !idsArg) {
  console.error("--org and --dispatch-ids required");
  process.exit(1);
}
const dispatchIds = String(idsArg).split(",").map((s) => parseInt(s.trim())).filter(Boolean);
if (dispatchIds.length === 0) {
  console.error("no dispatch ids parsed");
  process.exit(1);
}

const db = createClient(url, key);

const { data: disp, error: dErr } = await db
  .from("wms_dispatches")
  .select("id, destination_location_id, destination_type, destination_id, created_at, status")
  .eq("org_id", orgId)
  .in("id", dispatchIds);
if (dErr) {
  console.error("dispatch fetch failed:", dErr);
  process.exit(1);
}
if (disp.length !== dispatchIds.length) {
  console.error(`asked for ${dispatchIds.length} dispatches, got ${disp.length}`);
  process.exit(1);
}
for (const d of disp) {
  if (d.destination_type !== "Internal Shop" || !d.destination_location_id) {
    console.error(`dispatch #${d.id} is not an Internal Shop dispatch; refusing`);
    process.exit(1);
  }
}

const { data: items, error: iErr } = await db
  .from("wms_dispatch_items")
  .select("dispatch_id, wms_item_id, qty_sent")
  .in("dispatch_id", dispatchIds);
if (iErr) {
  console.error("items fetch failed:", iErr);
  process.exit(1);
}

const catIds = [...new Set(items.map((i) => i.wms_item_id))];
const { data: cat } = await db
  .from("wms_catalog")
  .select("id, sku, item_name, product_id")
  .in("id", catIds);
const catMap = new Map(cat.map((c) => [c.id, c]));

const missingLink = cat.filter((c) => !c.product_id);
if (missingLink.length > 0) {
  console.error(
    `these catalog rows still have no product_id — apply migration 081 first, or link manually:`
  );
  for (const c of missingLink) console.error(`  wms_catalog id=${c.id} sku=${c.sku} name=${c.item_name}`);
  process.exit(1);
}

const dispMap = new Map(disp.map((d) => [d.id, d]));

// Group by (product_id, location_id) so multi-line dispatches roll up
// cleanly. add_product_stock_at_location is additive, so per-item calls
// would also work; grouping just makes the log readable.
const plan = new Map(); // key = product_id|location_id -> {product_id, location_id, qty, lines[]}
for (const it of items) {
  const c = catMap.get(it.wms_item_id);
  const d = dispMap.get(it.dispatch_id);
  const key = `${c.product_id}|${d.destination_location_id}`;
  const cur = plan.get(key) || { product_id: c.product_id, location_id: d.destination_location_id, qty: 0, lines: [] };
  cur.qty += it.qty_sent;
  cur.lines.push({ dispatch_id: d.id, sku: c.sku, name: c.item_name, qty: it.qty_sent });
  plan.set(key, cur);
}

const { data: prods } = await db.from("products").select("id, name").in("id", [...new Set([...plan.values()].map((p) => p.product_id))]);
const prodName = new Map(prods.map((p) => [p.id, p.name]));

const locIds = [...new Set([...plan.values()].map((p) => p.location_id))];
const { data: locs } = await db.from("locations").select("id, name").in("id", locIds);
const locName = new Map(locs.map((l) => [l.id, l.name]));

console.log("Reconciliation plan:");
console.log("");
for (const p of plan.values()) {
  console.log(`  ${(prodName.get(p.product_id) || p.product_id).slice(0, 35).padEnd(35)} at ${(locName.get(p.location_id) || "").padEnd(20)} +${p.qty}`);
  for (const l of p.lines) console.log(`      dispatch #${l.dispatch_id} · ${l.sku} · ${l.name} qty ${l.qty}`);
}
console.log("");

if (!apply) {
  console.log("DRY RUN — add --apply to write.");
  process.exit(0);
}

// Apply. add_product_stock_at_location is SECURITY DEFINER but resolves the
// caller via auth.uid(), which is NULL under the service key — so it would
// refuse. Do the upsert directly instead: read current, add, write back with
// org_id explicit (default_user_org_id() returns NULL under service role).
const { data: orgRow } = await db.from("organizations").select("id").eq("id", orgId).single();
if (!orgRow) {
  console.error("org not found:", orgId);
  process.exit(1);
}

const now = new Date().toISOString();
let ok = 0;
for (const p of plan.values()) {
  const { data: cur } = await db
    .from("product_stock")
    .select("quantity")
    .eq("product_id", p.product_id)
    .eq("location_id", p.location_id)
    .maybeSingle();
  const currentQty = Number(cur?.quantity) || 0;
  const newQty = currentQty + p.qty;
  const { error } = await db.from("product_stock").upsert(
    {
      org_id: orgId,
      product_id: p.product_id,
      location_id: p.location_id,
      quantity: newQty,
      last_updated: now,
    },
    { onConflict: "product_id,location_id" }
  );
  if (error) {
    console.error(`  FAIL ${p.product_id} @ ${p.location_id}: ${error.message}`);
    continue;
  }
  console.log(`  OK   ${(prodName.get(p.product_id) || p.product_id).slice(0, 35).padEnd(35)} at ${(locName.get(p.location_id) || "").padEnd(20)} ${currentQty} -> ${newQty}`);
  ok++;
}
console.log("");
console.log(`Reconciled ${ok}/${plan.size} product+location rows.`);
