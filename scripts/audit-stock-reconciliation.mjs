#!/usr/bin/env node
//
// Audits whether product_stock.quantity is actually accounted for, per
// product+branch, since the last CONFIRMED stock count.
//
// Why "since the last confirmed count" and not all-time: a confirmed count
// resets stock to whatever was physically found on the shelf, wiping out any
// prior drift (including old bugs) at that moment. Auditing all-time history
// re-surfaces debt that's already been corrected and makes a healthy shop
// look broken. This checks the only thing that matters for "is this an
// active bug right now": does everything that moved stock SINCE the last
// trusted physical count add up to what's on record today?
//
// Read-only. Never writes anything.
//
//   node --env-file=.env.local scripts/audit-stock-reconciliation.mjs --org "Destiny"
//   node --env-file=.env.local scripts/audit-stock-reconciliation.mjs --org "Destiny" --branch "Destiny Independent"
//   node --env-file=.env.local scripts/audit-stock-reconciliation.mjs --org "Destiny" --threshold 5
//
// A row means: baseline (last confirmed count, or 0 if the product has never
// been counted) + received - sold + adjustments != actual current stock.
// Anything reported has a real, unexplained cause — investigate before
// dismissing it as "probably fine."

import { createServiceClient, fetchAll, resolveOrg, resolveBranch, flag as getFlag, runMain } from "./lib/common.mjs";

const args = process.argv.slice(2);
const flag = (name) => getFlag(args, name);
const orgName = flag("org");
const branchName = flag("branch");
const threshold = Number(flag("threshold") ?? "2");

if (!orgName) {
  console.error('Usage: --org "<shop>" [--branch "<name>"] [--threshold <n>, default 2]');
  process.exit(1);
}

const supabase = createServiceClient();

runMain(async () => {
  const org = await resolveOrg(supabase, orgName);
  console.log(`Shop: ${org.name} (${org.id})`);

  const branch = branchName ? await resolveBranch(supabase, org.id, branchName) : null;
  if (branch) console.log(`Branch: ${branch.name}`);

  const locations = branch
    ? [branch]
    : await fetchAll(() => supabase.from("locations").select("id, name").eq("org_id", org.id).eq("active", true));
  const locationIds = new Set(locations.map((l) => l.id));
  const locationName = new Map(locations.map((l) => [l.id, l.name]));

  const products = await fetchAll(() =>
    supabase.from("products").select("id, name, is_prepared").eq("org_id", org.id).eq("discontinued", false)
  );
  const productIsPrepared = new Map(products.map((p) => [p.id, p.is_prepared]));

  const [receiptItems, receipts, sales, adjustments, counts, stockRows] = await Promise.all([
    fetchAll(() => supabase.from("stock_receipt_items").select("product_id, receipt_id, quantity").not("product_id", "is", null)),
    fetchAll(() => supabase.from("stock_receipts").select("id, location_id, created_at").eq("org_id", org.id)),
    fetchAll(() => supabase.from("sales").select("product_id, location_id, quantity, created_at, voided_at").eq("org_id", org.id)),
    fetchAll(() => supabase.from("stock_adjustments").select("product_id, location_id, quantity, direction, created_at").eq("org_id", org.id)),
    fetchAll(() => supabase.from("stock_counts").select("product_id, location_id, closing_units, confirmed_at").eq("org_id", org.id).not("confirmed_at", "is", null)),
    fetchAll(() => supabase.from("product_stock").select("product_id, location_id, quantity").eq("org_id", org.id)),
  ]);

  const receiptLocation = new Map(receipts.map((r) => [r.id, { location_id: r.location_id, created_at: r.created_at }]));
  const actualMap = new Map(stockRows.map((s) => [`${s.product_id}|${s.location_id}`, Number(s.quantity)]));

  // Latest confirmed count per product+location.
  const baseline = new Map(); // key -> { qty, at }
  for (const c of counts) {
    if (!locationIds.has(c.location_id)) continue;
    const key = `${c.product_id}|${c.location_id}`;
    const existing = baseline.get(key);
    if (!existing || c.confirmed_at > existing.at) {
      baseline.set(key, { qty: Number(c.closing_units), at: c.confirmed_at });
    }
  }

  const findings = [];

  for (const p of products) {
    for (const loc of locations) {
      const key = `${p.id}|${loc.id}`;
      const base = baseline.get(key) ?? { qty: 0, at: null };
      const since = base.at ?? "1970-01-01T00:00:00Z";

      let received = 0;
      for (const it of receiptItems) {
        if (it.product_id !== p.id) continue;
        const r = receiptLocation.get(it.receipt_id);
        if (!r || r.location_id !== loc.id) continue;
        if (r.created_at <= since) continue;
        received += Number(it.quantity);
      }

      let sold = 0;
      for (const s of sales) {
        if (s.product_id !== p.id || s.location_id !== loc.id) continue;
        if (s.voided_at) continue;
        if (s.created_at <= since) continue;
        sold += Number(s.quantity);
      }

      let adjusted = 0;
      for (const a of adjustments) {
        if (a.product_id !== p.id || a.location_id !== loc.id) continue;
        if (a.created_at <= since) continue;
        adjusted += a.direction === "increase" ? Number(a.quantity) : -Number(a.quantity);
      }

      const expected = base.qty + received - sold + adjusted;
      const actual = actualMap.get(key) ?? 0;
      const gap = expected - actual;

      if (Math.abs(gap) >= threshold) {
        findings.push({
          product: p.name,
          prepared: p.is_prepared,
          location: locationName.get(loc.id),
          baseline: base.at ? `${base.qty} @ ${base.at.slice(0, 16).replace("T", " ")}` : "never counted (assumed 0)",
          received,
          sold,
          adjusted,
          expected,
          actual,
          gap,
        });
      }
    }
  }

  findings.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));

  if (findings.length === 0) {
    console.log(`\nNo discrepancies >= ${threshold} units since each item's last confirmed count. Stock is accounted for.`);
    return;
  }

  console.log(`\n${findings.length} discrepancy(ies) >= ${threshold} units since last confirmed count:\n`);
  for (const f of findings) {
    console.log(
      `${f.gap > 0 ? "MISSING" : "SURPLUS"} ${Math.abs(f.gap)}  ${f.product}${f.prepared ? " (prepared)" : ""} @ ${f.location}`
    );
    console.log(
      `  baseline: ${f.baseline}  received: +${f.received}  sold: -${f.sold}  adjusted: ${f.adjusted >= 0 ? "+" : ""}${f.adjusted}  => expected ${f.expected}, actual ${f.actual}`
    );
  }

  console.log(
    `\nA "MISSING" gap means stock disappeared without a receipt, sale, void, or adjustment to explain it —` +
    `\nthat's the signature of an active bug, not normal sell-through (normal sell-through clamps at 0, it doesn't go missing while receipts/sales still balance).` +
    `\nA "SURPLUS" gap (actual higher than expected) usually means an event type this script doesn't track yet` +
    `\n(a stock transfer, a WMS dispatch credit) rather than a bug — check those before assuming it's wrong.`
  );
});
