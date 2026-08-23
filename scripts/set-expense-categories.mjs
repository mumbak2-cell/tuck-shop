#!/usr/bin/env node
//
// Add and/or remove expense categories for one org (expense_categories,
// migration 097). "Remove" deactivates (active = false) rather than
// deleting — matches the Manage Expense Categories modal, and a category
// still referenced by existing expenses stays visible on those rows either
// way. Categories already present are skipped, not duplicated.
//
//   Dry run (default):
//     node --env-file=.env.local scripts/set-expense-categories.mjs \
//       --org "Royaltreat Pharmacy" \
//       --remove "Fuel,Rent,Consumables" \
//       --add "Security Guard,Cleaning Agents,Packaging,Bundles"
//
//   Apply:
//     ... same, plus --apply
//

import { createServiceClient, flag as getFlag, runMain } from "./lib/common.mjs";

const args = process.argv.slice(2);
const flag = (name) => getFlag(args, name);
const orgName = flag("org");
const removeRaw = flag("remove");
const addRaw = flag("add");
const apply = args.includes("--apply");

function splitList(raw) {
  return (raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const toRemove = splitList(removeRaw);
const toAdd = splitList(addRaw);

if (!orgName || (toRemove.length === 0 && toAdd.length === 0)) {
  console.error('Usage: --org "<shop>" [--remove "A,B"] [--add "C,D"] [--apply]');
  process.exit(1);
}

const supabase = createServiceClient();

runMain(async () => {
  const { data: orgs, error: orgErr } = await supabase
    .from("organizations")
    .select("id, name")
    .ilike("name", `%${orgName}%`);
  if (orgErr) throw new Error(orgErr.message);
  if (!orgs?.length) throw new Error(`No shop matching "${orgName}"`);
  if (orgs.length > 1) throw new Error(`"${orgName}" matches: ${orgs.map((o) => o.name).join(", ")}`);
  const org = orgs[0];
  console.log(`Shop: ${org.name} (${org.id})`);

  const { data: existing, error: catErr } = await supabase
    .from("expense_categories")
    .select("id, name, active, sort_order")
    .eq("org_id", org.id)
    .order("sort_order");
  if (catErr) throw new Error(catErr.message);

  console.log(`\nCurrent categories: ${existing.filter((c) => c.active).map((c) => c.name).join(", ") || "(none)"}`);

  const byName = new Map(existing.map((c) => [c.name.toLowerCase(), c]));
  let nextSort = existing.reduce((max, c) => Math.max(max, c.sort_order), -1) + 1;

  const removals = toRemove
    .map((name) => byName.get(name.toLowerCase()))
    .filter((c) => c && c.active);
  const missing = toRemove.filter((name) => !byName.get(name.toLowerCase())?.active);

  const additions = toAdd.filter((name) => !byName.get(name.toLowerCase()));
  const alreadyPresent = toAdd.filter((name) => byName.get(name.toLowerCase()));

  console.log(`\nWill remove (deactivate): ${removals.map((c) => c.name).join(", ") || "(none)"}`);
  if (missing.length) console.log(`Not found / already inactive, skipping: ${missing.join(", ")}`);
  console.log(`Will add: ${additions.join(", ") || "(none)"}`);
  if (alreadyPresent.length) console.log(`Already in list, skipping: ${alreadyPresent.join(", ")}`);

  if (!apply) {
    console.log("\n[DRY RUN] Add --apply to execute.");
    return;
  }

  for (const c of removals) {
    const { error } = await supabase.from("expense_categories").update({ active: false }).eq("id", c.id);
    if (error) throw new Error(error.message);
  }

  for (const name of additions) {
    const { error } = await supabase
      .from("expense_categories")
      .insert({ org_id: org.id, name, sort_order: nextSort++, active: true });
    if (error) throw new Error(error.message);
  }

  console.log(`\nDone. Removed ${removals.length}, added ${additions.length}.`);
});
