#!/usr/bin/env node
//
// Set a location_settings key across an org's branches — the same write the
// Settings page performs, for when a toggle needs applying to many branches
// at once. Keys in use: receipts_enabled, wholesale_enabled,
// denomination_count_enabled, blind_cash_up_enabled.
//
//   Dry run (default), all branches:
//     node --env-file=.env.local scripts/set-location-setting.mjs --org "Chichi" --key blind_cash_up_enabled --value true
//
//   Named branches only:
//     node --env-file=.env.local scripts/set-location-setting.mjs --org "Chichi" --key wholesale_enabled --value true --branch "Garden Shop" --branch "Town Shop"
//
//   Apply:
//     ... --apply
//

import { createServiceClient, resolveOrg, flag as getFlag, runMain } from "./lib/common.mjs";

const args = process.argv.slice(2);
const orgName = getFlag(args, "org");
const key = getFlag(args, "key");
const value = getFlag(args, "value");
const apply = args.includes("--apply");

// --branch is repeatable, so collect every occurrence rather than the first.
// No --branch at all means every branch in the org.
const only = args.reduce((acc, a, i) => {
  if (a === "--branch" && args[i + 1]) acc.push(args[i + 1]);
  return acc;
}, []);

if (!orgName || !key || (value !== "true" && value !== "false")) {
  console.error(
    'Usage: --org "<shop>" --key <key> --value <true|false> [--branch "<name>"]... [--apply]'
  );
  process.exit(1);
}

const supabase = createServiceClient();

runMain(async () => {
  const org = await resolveOrg(supabase, orgName);
  console.log(`Shop: ${org.name}`);
  console.log(`Key:  ${key} = ${value}`);

  const { data: locations, error: locErr } = await supabase
    .from("locations")
    .select("id, name")
    .eq("org_id", org.id);
  if (locErr) throw new Error(locErr.message);

  const missing = only.filter((n) => !locations.some((l) => l.name === n));
  if (missing.length) {
    throw new Error(
      `Branch not found: ${missing.join(", ")}. Have: ${locations.map((l) => l.name).join(", ")}`
    );
  }
  const targets = only.length ? locations.filter((l) => only.includes(l.name)) : locations;

  // Always print every branch, not just the targets, so the untouched ones are
  // visible too — this is the screen the setting is being changed from.
  const report = async (label) => {
    const { data, error } = await supabase
      .from("location_settings")
      .select("location_id, value")
      .eq("key", key)
      .in("location_id", locations.map((l) => l.id));
    if (error) throw new Error(error.message);
    const current = new Map((data || []).map((r) => [r.location_id, r.value]));
    console.log(`\n${label}`);
    for (const l of locations) {
      const on = current.get(l.id) === "true";
      const isTarget = targets.some((t) => t.id === l.id);
      console.log(`  ${on ? "[x]" : "[ ]"} ${l.name}${isTarget ? "   <- target" : ""}`);
    }
  };

  await report("Current:");

  if (!apply) {
    console.log("\n[DRY RUN] Add --apply to write.");
    return;
  }

  const { error } = await supabase.from("location_settings").upsert(
    targets.map((l) => ({
      org_id: org.id,
      location_id: l.id,
      key,
      value,
      updated_at: new Date().toISOString(),
    })),
    { onConflict: "location_id,key" }
  );
  if (error) throw new Error(error.message);

  await report("After write:");
});
