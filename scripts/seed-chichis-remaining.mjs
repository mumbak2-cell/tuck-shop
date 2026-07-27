#!/usr/bin/env node
//
// Seed 100 units of every SKU to all Chichi's Bakes branches EXCEPT
// Garden Shop and Town Shop (which were already seeded earlier).
//
//   Dry run (default):
//     node --env-file=.env.local scripts/seed-chichis-remaining.mjs
//
//   Actually write:
//     node --env-file=.env.local scripts/seed-chichis-remaining.mjs --apply

import { createServiceClient, PAGE, fetchAll, resolveOrg, runMain } from "./lib/common.mjs";

const QTY = 100;
const BATCH = 500;
const EXCLUDE = ["garden shop", "town shop"];

const apply = process.argv.includes("--apply");
const supabase = createServiceClient();

async function main() {
  const org = await resolveOrg(supabase, "Chichi");

  const { data: locs, error: locErr } = await supabase
    .from("locations")
    .select("id, name, active")
    .eq("org_id", org.id);
  if (locErr) throw new Error(locErr.message);

  const targets = (locs || []).filter(
    (l) => !EXCLUDE.includes(l.name.trim().toLowerCase())
  );

  if (!targets.length) throw new Error("No branches left after excluding Garden Shop and Town Shop.");

  const products = await fetchAll(() =>
    supabase
      .from("products")
      .select("id, name, discontinued")
      .eq("org_id", org.id)
  );
  const active = products.filter((p) => !p.discontinued);

  console.log(`Shop:       ${org.name}`);
  console.log(`Excluded:   ${EXCLUDE.join(", ")}`);
  console.log(`Branches:   ${targets.map((l) => l.name).join(", ")}`);
  console.log(`Products:   ${active.length} active SKUs × ${QTY} units each`);
  console.log("");

  for (const branch of targets) {
    const existing = await fetchAll(() =>
      supabase.from("product_stock").select("product_id, quantity").eq("location_id", branch.id)
    );
    const existingQty = new Map(existing.map((r) => [r.product_id, r.quantity]));
    const changing = active.filter((p) => (existingQty.get(p.id) ?? 0) !== QTY);

    console.log(`  ${branch.name}${branch.active ? "" : " (INACTIVE)"}:`);
    console.log(`    ${changing.length} rows to write (${active.length - changing.length} already at ${QTY})`);

    if (!apply) continue;

    const rows = active.map((p) => ({
      org_id: org.id,
      product_id: p.id,
      location_id: branch.id,
      quantity: QTY,
      last_updated: new Date().toISOString(),
    }));

    let written = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const { error } = await supabase
        .from("product_stock")
        .upsert(chunk, { onConflict: "product_id,location_id" });
      if (error) throw new Error(`${branch.name} batch at ${i}: ${error.message}`);
      written += chunk.length;
    }
    console.log(`    wrote ${written} rows`);
  }

  console.log("");
  if (!apply) {
    console.log("Dry run. Re-run with --apply to write.");
  } else {
    console.log("Done.");
  }
}

runMain(main);
