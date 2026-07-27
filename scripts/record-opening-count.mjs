#!/usr/bin/env node
//
// Record an opening stock count for one branch.
//
// Companion to seed-branch-stock.mjs: that sets the quantities, this writes the
// count session that says where they came from. Without it the stock exists
// with no record of having been counted in.
//
//   Dry run (default):
//     node --env-file=.env.local scripts/record-opening-count.mjs --org "Chichi's" --branch "Town Shop"
//
//   Actually write:
//     node --env-file=.env.local scripts/record-opening-count.mjs --org "Chichi's" --branch "Town Shop" --apply
//
// Counts the CURRENT product_stock quantity at that branch: opening_units and
// closing_units are both set to what is on the shelf, so the session books zero
// variance. units_sold_calc is generated as
// opening + replenished - closing, so a count that agreed with the system must
// imply zero sales -- anything else would invent a day's trade.
//
// product_stock is NOT touched. The quantities are already what is being
// counted; re-applying them is what the app's "confirm" step does, and there is
// nothing here to apply.
//
// Deliberately a stock count and not a stock receipt. stock_receipts has no
// location_id and Revenue Assurance's replenishment query does not filter by
// branch, so a receipt would be credited as replenishment in EVERY branch's RA
// view -- showing phantom shrinkage at branches that received nothing. Stock
// counts are location-scoped throughout.
//
// Rows are confirmed on write (confirmed_by/confirmed_at), matching a manager's
// save: an unconfirmed session reads as awaiting review, and this one has
// nothing to review.

import { randomUUID } from "node:crypto";
import { createServiceClient, PAGE, fetchAll, resolveOrg, resolveBranch, flag as getFlag, runMain } from "./lib/common.mjs";

const BATCH = 500;

const args = process.argv.slice(2);
const flag = (n) => getFlag(args, n);
const orgName = flag("org");
const branchName = flag("branch");
const label = flag("label") || "Opening count";
const countedBy = flag("counted-by") || "Opening count";
const apply = args.includes("--apply");

if (!orgName || !branchName) {
  console.error('Usage: --org "<shop>" --branch "<branch>" [--label "..."] [--counted-by "..."] [--apply]');
  process.exit(1);
}

const supabase = createServiceClient();

async function main() {
  const org = await resolveOrg(supabase, orgName);
  const branch = await resolveBranch(supabase, org.id, branchName);

  const stock = await fetchAll(() =>
    supabase.from("product_stock").select("product_id, quantity").eq("location_id", branch.id)
  );
  if (!stock.length) throw new Error(`${branch.name} has no stock rows to count.`);

  const today = new Date().toISOString().slice(0, 10);
  const existing = await fetchAll(() =>
    supabase.from("stock_counts").select("session_id").eq("location_id", branch.id).eq("count_date", today)
  );
  const priorSessions = new Set(existing.map((r) => r.session_id));

  const units = stock.reduce((a, r) => a + Number(r.quantity || 0), 0);
  console.log(`Shop:    ${org.name}`);
  console.log(`Branch:  ${branch.name}`);
  console.log(`Date:    ${today}`);
  console.log(`Session: "${label}" counted by "${countedBy}"`);
  console.log("");
  console.log(`Counting ${stock.length} products, ${units.toLocaleString()} units.`);
  console.log(`  opening = closing = on-hand, so variance and implied sales are 0`);
  console.log(`  product_stock is not modified`);
  if (priorSessions.size) console.log(`  note: ${priorSessions.size} count session(s) already exist at this branch today`);
  console.log("");

  if (!apply) {
    console.log("Dry run. Re-run with --apply to write.");
    return;
  }

  const sessionId = randomUUID();
  const now = new Date().toISOString();
  const rows = stock.map((r) => ({
    // Set explicitly: the column defaults to default_user_org_id(), which
    // resolves through auth.uid() and so comes back NULL for the service role.
    org_id: org.id,
    session_id: sessionId,
    session_label: label,
    count_date: today,
    product_id: r.product_id,
    location_id: branch.id,
    opening_units: Number(r.quantity) || 0,
    closing_units: Number(r.quantity) || 0,
    replenished_units: 0,
    counted_by: countedBy,
    counted_at: now,
    updated_at: now,
    update_count: 1,
    confirmed_by: countedBy,
    confirmed_at: now,
  }));

  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { error } = await supabase
      .from("stock_counts")
      .upsert(chunk, { onConflict: "session_id,product_id,location_id" });
    if (error) throw new Error(`Batch at ${i}: ${error.message}`);
    written += chunk.length;
    console.log(`  written ${written}/${rows.length}`);
  }

  const after = await fetchAll(() =>
    supabase.from("stock_counts").select("closing_units").eq("session_id", sessionId)
  );
  console.log("");
  console.log(`Done. Session ${sessionId}`);
  console.log(`${after.length} rows, ${after.reduce((a, r) => a + Number(r.closing_units || 0), 0).toLocaleString()} units counted at ${branch.name}.`);
}

runMain(main);
