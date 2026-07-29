#!/usr/bin/env node
//
// Flag the products stocked at given branches as wholesale-eligible.
//
// Note: wholesale_enabled and wholesale_min_qty live on `products`, which is
// org-wide — there is no per-branch product flag. Branches are used here only
// to decide WHICH products to flag (those holding stock there). Whether a
// wholesale price is actually offered is still gated per branch by the
// `wholesale_enabled` key in location_settings, set in Settings.
//
//   Dry run (default):
//     node --env-file=.env.local scripts/set-wholesale-skus.mjs --org "Chichi" --branch "Garden" --branch "Town Shop" --min 25
//
//   Apply:
//     node --env-file=.env.local scripts/set-wholesale-skus.mjs --org "Chichi" --branch "Garden" --branch "Town Shop" --min 25 --apply
//

import {
  createServiceClient,
  fetchAll,
  resolveOrg,
  resolveBranch,
  flag as getFlag,
  runMain,
} from "./lib/common.mjs";

const args = process.argv.slice(2);
const orgName = getFlag(args, "org");
const minRaw = getFlag(args, "min");
const min = Number(minRaw);
const apply = args.includes("--apply");
const includeIngredients = args.includes("--include-ingredients");

// --branch is repeatable, so collect every occurrence rather than the first.
const branchNames = args.reduce((acc, a, i) => {
  if (a === "--branch" && args[i + 1]) acc.push(args[i + 1]);
  return acc;
}, []);

if (!orgName || branchNames.length === 0 || minRaw === null || !Number.isInteger(min) || min < 1) {
  console.error(
    'Usage: --org "<shop>" --branch "<branch>" [--branch "<branch>"...] --min <n> [--include-ingredients] [--apply]'
  );
  process.exit(1);
}

const INGREDIENT_CATEGORIES = ["ingredients", "ingredient"];

const supabase = createServiceClient();

runMain(async () => {
  const org = await resolveOrg(supabase, orgName);
  console.log(`Shop: ${org.name} (${org.id})`);

  const branches = [];
  for (const name of branchNames) {
    branches.push(await resolveBranch(supabase, org.id, name));
  }
  console.log(`Branches: ${branches.map((b) => b.name).join(", ")}`);

  // Products holding stock at any of the named branches.
  const branchIds = branches.map((b) => b.id);
  const stockRows = await fetchAll(() =>
    supabase
      .from("product_stock")
      .select("product_id, location_id")
      .in("location_id", branchIds)
      .gt("quantity", 0)
  );
  const stockedIds = new Set(stockRows.map((r) => r.product_id));
  console.log(`\nProducts with stock at those branches: ${stockedIds.size}`);

  if (stockedIds.size === 0) {
    console.log("Nothing to do.");
    return;
  }

  const products = await fetchAll(() =>
    supabase
      .from("products")
      .select("id, name, category, wholesale_enabled, wholesale_min_qty, discontinued")
      .eq("org_id", org.id)
      .eq("discontinued", false)
  );

  const stocked = products.filter((p) => stockedIds.has(p.id));

  const isIngredient = (p) => INGREDIENT_CATEGORIES.includes((p.category || "").toLowerCase());
  const skippedIngredients = includeIngredients ? [] : stocked.filter(isIngredient);
  const candidates = includeIngredients ? stocked : stocked.filter((p) => !isIngredient(p));

  // Anything already at the target values is left alone, so a re-run is a no-op.
  const toUpdate = candidates.filter(
    (p) => p.wholesale_enabled !== true || p.wholesale_min_qty !== min
  );
  const alreadySet = candidates.length - toUpdate.length;

  console.log(`\nWill update:        ${toUpdate.length}`);
  console.log(`Already correct:    ${alreadySet}`);
  if (!includeIngredients) {
    console.log(`Skipped ingredients: ${skippedIngredients.length}`);
  }

  if (skippedIngredients.length > 0) {
    console.log("\nSkipped (ingredients):");
    for (const p of skippedIngredients.slice(0, 10)) {
      console.log(`  - ${p.name}`);
    }
    if (skippedIngredients.length > 10) {
      console.log(`  ... and ${skippedIngredients.length - 10} more`);
    }
  }

  if (toUpdate.length > 0) {
    console.log("\nSample of products to update:");
    for (const p of toUpdate.slice(0, 15)) {
      console.log(`  - ${p.name} (${p.category})`);
    }
    if (toUpdate.length > 15) {
      console.log(`  ... and ${toUpdate.length - 15} more`);
    }
  }

  if (!apply) {
    console.log("\n[DRY RUN] Add --apply to execute the update.");
    return;
  }

  if (toUpdate.length === 0) {
    console.log("\nNothing to change.");
    return;
  }

  const BATCH = 100;
  let updated = 0;
  for (let i = 0; i < toUpdate.length; i += BATCH) {
    const ids = toUpdate.slice(i, i + BATCH).map((p) => p.id);
    const { error } = await supabase
      .from("products")
      .update({ wholesale_enabled: true, wholesale_min_qty: min })
      .in("id", ids);
    if (error) throw new Error(error.message);
    updated += ids.length;
    console.log(`Updated ${updated}/${toUpdate.length}...`);
  }

  console.log(`\nDone. wholesale_enabled = true, wholesale_min_qty = ${min} for ${updated} products.`);
});
