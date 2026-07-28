#!/usr/bin/env node
//
// Set reorder level to 5 for all products except ingredients.
//
//   Dry run (default):
//     node --env-file=.env.local scripts/set-reorder-levels.mjs --org "Destiny" --level 5
//
//   Apply:
//     node --env-file=.env.local scripts/set-reorder-levels.mjs --org "Destiny" --level 5 --apply
//

import { createServiceClient, fetchAll, resolveOrg, flag as getFlag, runMain } from "./lib/common.mjs";

const args = process.argv.slice(2);
const flag = (name) => getFlag(args, name);
const orgName = flag("org");
const levelRaw = flag("level");
const level = Number(levelRaw);
const apply = args.includes("--apply");

if (!orgName || levelRaw === null || !Number.isInteger(level) || level < 0) {
  console.error('Usage: --org "<shop>" --level <n> [--apply]');
  process.exit(1);
}

const supabase = createServiceClient();

runMain(async () => {
  const org = await resolveOrg(supabase, orgName);
  console.log(`Shop: ${org.name} (${org.id})`);

  // Fetch all products for this org
  const products = await fetchAll(() =>
    supabase
      .from("products")
      .select("id, name, category, reorder_level, discontinued")
      .eq("org_id", org.id)
      .eq("discontinued", false)
  );

  console.log(`\nTotal active products: ${products.length}`);

  // Show category breakdown
  const categories = {};
  for (const p of products) {
    categories[p.category] = (categories[p.category] || 0) + 1;
  }
  console.log("\nCategories:");
  for (const [cat, count] of Object.entries(categories).sort()) {
    console.log(`  ${cat}: ${count}`);
  }

  // Filter out ingredients (case-insensitive match)
  const ingredientCategories = ["ingredients", "ingredient"];
  const toUpdate = products.filter(
    (p) => !ingredientCategories.includes(p.category.toLowerCase())
  );
  const skipped = products.filter(
    (p) => ingredientCategories.includes(p.category.toLowerCase())
  );

  console.log(`\nWill update: ${toUpdate.length} products`);
  console.log(`Skipping (ingredients): ${skipped.length}`);

  if (skipped.length > 0) {
    console.log("\nSkipped products (ingredients):");
    for (const p of skipped.slice(0, 10)) {
      console.log(`  - ${p.name} (category: ${p.category})`);
    }
    if (skipped.length > 10) {
      console.log(`  ... and ${skipped.length - 10} more`);
    }
  }

  if (!apply) {
    console.log("\n[DRY RUN] Add --apply to execute the update.");
    return;
  }

  // Update in batches
  const BATCH = 100;
  let updated = 0;
  for (let i = 0; i < toUpdate.length; i += BATCH) {
    const batch = toUpdate.slice(i, i + BATCH);
    const ids = batch.map((p) => p.id);

    const { error } = await supabase
      .from("products")
      .update({ reorder_level: level })
      .in("id", ids);

    if (error) throw new Error(error.message);
    updated += batch.length;
    console.log(`Updated ${updated}/${toUpdate.length}...`);
  }

  console.log(`\nDone. Set reorder_level = ${level} for ${updated} products.`);
});
