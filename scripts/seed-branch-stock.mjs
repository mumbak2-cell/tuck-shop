#!/usr/bin/env node
//
// Set every SKU to a flat quantity at one branch.
//
// For opening a branch: a new location has no product_stock rows at all, and
// the POS only shows items with stock > 0 there, so its till starts empty.
// This writes one row per product at the given quantity.
//
//   Dry run (default -- reports, changes nothing):
//     node --env-file=.env.local scripts/seed-branch-stock.mjs --org "Chichi's" --branch "Town Shop" --qty 150
//
//   Actually write:
//     node --env-file=.env.local scripts/seed-branch-stock.mjs --org "Chichi's" --branch "Town Shop" --qty 150 --apply
//
// This is a stock-taking shortcut, NOT a delivery. It writes product_stock
// directly, so it creates no stock_receipts row and no expense: nothing reaches
// COGS and no supplier is recorded. Use Receive Stock for real deliveries --
// seeding a quantity the shop never bought overstates what is on the shelf, and
// Revenue Assurance reconciles against exactly that figure.
//
// Discontinued products are skipped by default (--include-discontinued to keep
// them); they are not meant to be sold, and stock > 0 puts them back on the
// POS grid.
//
// Needs SUPABASE_SERVICE_ROLE_KEY: product_stock writes are org+location
// scoped by RLS, which the anon key cannot cross for another user's org.

import { createClient } from "@supabase/supabase-js";

const PAGE = 1000; // PostgREST's default cap -- read in pages or rows go missing
const BATCH = 500; // upsert chunk

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
};
const orgName = flag("org");
const branchName = flag("branch");
// Keep the raw value: Number(null) is 0, so a MISSING --qty would otherwise
// pass every check below and quietly set the whole branch to zero.
const qtyRaw = flag("qty");
const qty = Number(qtyRaw);
const apply = args.includes("--apply");
const includeDiscontinued = args.includes("--include-discontinued");

if (!orgName || !branchName || qtyRaw === null || !Number.isInteger(qty) || qty < 0) {
  console.error('Usage: --org "<shop>" --branch "<branch>" --qty <n> [--apply] [--include-discontinued]');
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Read every row of a table in pages. A plain select silently stops at 1000. */
async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

const money = (n) => n.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  const { data: orgs, error: orgErr } = await supabase
    .from("organizations")
    .select("id, name")
    .ilike("name", `%${orgName}%`);
  if (orgErr) throw new Error(orgErr.message);
  if (!orgs?.length) throw new Error(`No shop matching "${orgName}"`);
  if (orgs.length > 1) throw new Error(`"${orgName}" matches: ${orgs.map((o) => o.name).join(", ")}`);
  const org = orgs[0];

  const { data: locs, error: locErr } = await supabase
    .from("locations")
    .select("id, name, active")
    .eq("org_id", org.id);
  if (locErr) throw new Error(locErr.message);
  const branch = (locs || []).find((l) => l.name.trim().toLowerCase() === branchName.trim().toLowerCase());
  if (!branch) {
    throw new Error(`No branch "${branchName}" at ${org.name}. Have: ${(locs || []).map((l) => l.name).join(", ")}`);
  }

  const products = await fetchAll(() =>
    supabase
      .from("products")
      .select("id, name, discontinued, cost_per_unit, selling_price")
      .eq("org_id", org.id)
  );
  const targets = includeDiscontinued ? products : products.filter((p) => !p.discontinued);
  const skipped = products.length - targets.length;

  const existing = await fetchAll(() =>
    supabase.from("product_stock").select("product_id, quantity").eq("location_id", branch.id)
  );
  const existingQty = new Map(existing.map((r) => [r.product_id, r.quantity]));
  const changing = targets.filter((p) => (existingQty.get(p.id) ?? 0) !== qty);
  const overwriting = targets.filter((p) => (existingQty.get(p.id) ?? 0) > 0);

  const costValue = targets.reduce((a, p) => a + Number(p.cost_per_unit || 0) * qty, 0);
  const retailValue = targets.reduce((a, p) => a + Number(p.selling_price || 0) * qty, 0);
  const noCost = targets.filter((p) => !Number(p.cost_per_unit)).length;

  console.log(`Shop:     ${org.name}`);
  console.log(`Branch:   ${branch.name}${branch.active ? "" : "  (INACTIVE)"}`);
  console.log(`Products: ${products.length} in catalogue, ${targets.length} to set${skipped ? `, ${skipped} discontinued skipped` : ""}`);
  console.log("");
  console.log(`Setting every SKU to ${qty} — ${(targets.length * qty).toLocaleString()} units on hand.`);
  console.log(`  rows to write:        ${changing.length} (${targets.length - changing.length} already at ${qty})`);
  console.log(`  already holding > 0:  ${overwriting.length}  <- these are OVERWRITTEN, not added to`);
  console.log(`  value at cost:        ${money(costValue)}${noCost ? `  (${noCost} SKUs have no cost, counted as 0)` : ""}`);
  console.log(`  value at retail:      ${money(retailValue)}`);
  console.log("");

  if (!apply) {
    console.log("Dry run. Re-run with --apply to write.");
    return;
  }

  const rows = targets.map((p) => ({
    org_id: org.id,
    product_id: p.id,
    location_id: branch.id,
    quantity: qty,
    last_updated: new Date().toISOString(),
  }));

  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { error } = await supabase
      .from("product_stock")
      .upsert(chunk, { onConflict: "product_id,location_id" });
    if (error) throw new Error(`Batch at ${i}: ${error.message}`);
    written += chunk.length;
    console.log(`  written ${written}/${rows.length}`);
  }

  const after = await fetchAll(() =>
    supabase.from("product_stock").select("product_id, quantity").eq("location_id", branch.id)
  );
  const atQty = after.filter((r) => r.quantity === qty).length;
  console.log("");
  console.log(`Done. ${branch.name} now has ${after.length} stock rows, ${atQty} at ${qty}.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
