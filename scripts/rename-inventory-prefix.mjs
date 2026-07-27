#!/usr/bin/env node
//
// Re-prefix existing inventory IDs for one org.
//
// A bulk-imported catalogue carries whatever ids the import file had: an
// explicit inventory_id skips the BEFORE INSERT trigger, so generate_inventory_id()
// -- and with it app_settings.inventory_id_prefix -- never applies. That leaves
// a shop whose prefix setting says one thing and whose products say another.
// This rewrites the existing rows to match the setting.
//
//   Dry run (default -- reports, changes nothing):
//     node --env-file=.env.local scripts/rename-inventory-prefix.mjs --org "Chichi's" --from IN --to BK
//
//   Actually rename:
//     node --env-file=.env.local scripts/rename-inventory-prefix.mjs --org "Chichi's" --from IN --to BK --apply
//
// Only the leading prefix is replaced; the digits after it are kept verbatim,
// so IN00459 -> BK00459 and per-org zero padding (migration 049) is preserved.
// Nothing joins on inventory_id -- sales and every other table key on
// product_id -- so this is a display-level rename.
//
// It is NOT safe to run blind on a catalogue still fed by an importer that
// matches on inventory_id: the StockPilot import matches by id first and only
// falls back to name, so renaming makes every row miss and fall through to
// fuzzy name matching. Confirm the importer is out of the loop first.
//
// Re-runnable: rows already carrying the target prefix are left alone.

import { createServiceClient, PAGE, fetchAll, resolveOrg, flag as getFlag, runMain } from "./lib/common.mjs";

const CONCURRENCY = 20;

const args = process.argv.slice(2);
const flag = (n) => getFlag(args, n);
const orgName = flag("org");
const fromPrefix = (flag("from") || "").toUpperCase();
const toPrefix = (flag("to") || "").toUpperCase();
const apply = args.includes("--apply");

if (!orgName || !fromPrefix || !toPrefix) {
  console.error('Usage: --org "<shop>" --from IN --to BK [--apply]');
  process.exit(1);
}

const supabase = createServiceClient();

async function main() {
  const org = await resolveOrg(supabase, orgName);

  const products = await fetchAll(() =>
    supabase.from("products").select("id, inventory_id, name").eq("org_id", org.id)
  );

  const taken = new Set(products.map((p) => p.inventory_id));
  const targets = [];
  const collisions = [];
  const untouched = [];

  for (const p of products) {
    const id = p.inventory_id || "";
    if (!id.startsWith(fromPrefix)) {
      untouched.push(p);
      continue;
    }
    const next = toPrefix + id.slice(fromPrefix.length);
    // products_org_inventory_id_unique would reject a clash; catch it here so
    // the run stops before writing rather than halfway through.
    if (taken.has(next)) {
      collisions.push({ from: id, to: next });
      continue;
    }
    targets.push({ id: p.id, from: id, to: next, name: p.name });
  }

  console.log(`Shop:      ${org.name}`);
  console.log(`Products:  ${products.length}`);
  console.log(`Renaming:  ${fromPrefix}… -> ${toPrefix}…  on ${targets.length} rows`);
  if (untouched.length) console.log(`Untouched: ${untouched.length} (no "${fromPrefix}" prefix)`);
  console.log("");
  for (const t of targets.slice(0, 5)) console.log(`  ${t.from} -> ${t.to}   ${t.name?.slice(0, 40) ?? ""}`);
  if (targets.length > 5) console.log(`  … and ${targets.length - 5} more`);

  if (collisions.length) {
    console.log("");
    for (const c of collisions.slice(0, 10)) console.log(`  COLLISION  ${c.from} -> ${c.to} already exists`);
    console.error(`\n${collisions.length} collision(s). Nothing written.`);
    process.exit(1);
  }

  console.log("");
  if (!apply) {
    console.log("Dry run. Re-run with --apply to rename.");
    return;
  }

  let done = 0;
  const failures = [];
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const chunk = targets.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (t) => {
        const { error } = await supabase
          .from("products")
          .update({ inventory_id: t.to })
          .eq("id", t.id);
        if (error) failures.push(`${t.from}: ${error.message}`);
        else done++;
      })
    );
    if (i % 200 === 0) console.log(`  ${done}/${targets.length}`);
  }

  const after = await fetchAll(() =>
    supabase.from("products").select("inventory_id").eq("org_id", org.id)
  );
  const withNew = after.filter((p) => p.inventory_id?.startsWith(toPrefix)).length;
  const withOld = after.filter((p) => p.inventory_id?.startsWith(fromPrefix)).length;

  console.log("");
  console.log(`Renamed ${done} of ${targets.length}.`);
  if (failures.length) {
    console.log(`${failures.length} failed:`);
    for (const f of failures.slice(0, 10)) console.log(`  ${f}`);
  }
  console.log(`${org.name}: ${withNew} products on "${toPrefix}", ${withOld} still on "${fromPrefix}".`);
}

runMain(main);
