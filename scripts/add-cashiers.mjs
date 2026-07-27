#!/usr/bin/env node
//
// Bulk-create branch-locked cashiers for one org.
//
// Does exactly what Settings -> Team does per person (POST /api/team), for a
// list of people at once: create the login, attach an org_members row with
// role 'member' and assigned_location_id set to their branch. A cashier is
// pinned to that one branch by current_user_location_ids(), so getting the
// branch right here is the whole point of the script.
//
//   Dry run (default -- resolves everything, writes nothing):
//     node --env-file=.env.local scripts/add-cashiers.mjs --org "Chilufya" cashiers.json
//
//   Actually create:
//     node --env-file=.env.local scripts/add-cashiers.mjs --org "Chilufya" cashiers.json --apply
//
// cashiers.json is a list of { email, name?, branch, password?, cashierPin? },
// where `branch` is the location's name as it appears under Locations:
//
//   [
//     { "email": "mary@example.com", "name": "Mary Banda", "branch": "Kabulonga" },
//     { "email": "town@example.com", "branch": "Town Shop", "cashierPin": "2040" }
//   ]
//
// `password` sets a chosen password instead of a generated one. `cashierPin`
// sets that BRANCH's till PIN (location_settings.cashier_pin) -- the PIN is a
// property of the location, not of the person, so two accounts at one branch
// share it. Passwords are printed once, at the end, and stored nowhere.
//
// By default accounts are NOT flagged must_change_password. These are usually
// shop-named shared logins, and forcing a change means whichever cashier signs
// in first sets a password the owner does not know, locking out the rest of
// that branch's staff. Pass --force-password-change for personal accounts,
// where that first-login prompt is the right behaviour.
//
// Needs SUPABASE_SERVICE_ROLE_KEY: creating an auth.users row is an admin-API
// operation, and the member/location reads must cross RLS.

import { readFileSync } from "node:fs";
import { createServiceClient, resolveOrg, runMain } from "./lib/common.mjs";

// Mirrors PLANS in src/lib/plans.ts. Kept as a literal because that file is
// TypeScript and this script runs under plain node. An org on trial/past_due/
// cancelled falls back to the Starter allowance, same as the API does.
const MAX_USERS = { starter: 2, growth: 5, pro: 15 };
const FALLBACK_MAX_USERS = MAX_USERS.starter;

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const forceChange = args.includes("--force-password-change");
const orgName = args[args.indexOf("--org") + 1];
const listPath = args.find((a) => !a.startsWith("--") && a !== orgName);

if (!orgName || args.indexOf("--org") === -1 || !listPath) {
  console.error('Usage: node --env-file=.env.local scripts/add-cashiers.mjs --org "<shop name>" <cashiers.json> [--apply]');
  process.exit(1);
}

const supabase = createServiceClient();

/** Readable, transcribable temp password: Tilify-xxxx-xxxx (no ambiguous chars).
 *  Same shape as src/app/api/team/route.ts so handover instructions match. */
function tempPassword() {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789"; // no l/o/0/1
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
  return `Tilify-${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
}

/** Every auth user, keyed by lowercased email. One pass, reused for each row. */
async function loadAuthUsers() {
  const byEmail = new Map();
  const byId = new Map();
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`Listing auth users: ${error.message}`);
    const users = data?.users || [];
    for (const u of users) {
      if (u.email) byEmail.set(u.email.toLowerCase(), u.id);
      byId.set(u.id, u.email || "(no email)");
    }
    if (users.length < 1000) break;
  }
  return { byEmail, byId };
}

async function main() {
  const entries = JSON.parse(readFileSync(listPath, "utf8"));
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`${listPath} must be a non-empty JSON array of { email, name?, branch }`);
  }

  const org = await resolveOrg(supabase, orgName, "id, name, subscription_plan");

  const { data: locRows, error: locErr } = await supabase
    .from("locations")
    .select("id, name, active")
    .eq("org_id", org.id);
  if (locErr) throw new Error(`Loading locations: ${locErr.message}`);
  const locations = locRows || [];
  const locByName = new Map(locations.map((l) => [l.name.trim().toLowerCase(), l]));

  const { data: memberRows, error: memErr } = await supabase
    .from("org_members")
    .select("user_id, role")
    .eq("org_id", org.id);
  if (memErr) throw new Error(`Loading members: ${memErr.message}`);
  const members = memberRows || [];

  const { byEmail, byId } = await loadAuthUsers();

  // The admin API intermittently returns an empty or short page with no error.
  // Every check below reads from these maps, so a partial list would let the
  // "already on this team" and one-org-per-user guards pass silently and turn
  // the promised validate-then-write into per-row failures at write time.
  // Existing members are the one set we know must be present.
  const unresolved = members.filter((m) => !byId.has(m.user_id));
  if (unresolved.length) {
    throw new Error(
      `Auth user list came back incomplete: ${byId.size} users returned, but ${unresolved.length} of ` +
        `${members.length} existing members are missing from it. Re-run — this is transient.`
    );
  }

  const existingEmails = new Set(members.map((m) => (byId.get(m.user_id) || "").toLowerCase()));

  // Current per-branch PINs. login() in auth-context checks the admin PIN
  // first, so a cashier PIN equal to it would never be reached -- the till
  // would silently hand out the admin view instead.
  const { data: pinRows, error: pinErr } = await supabase
    .from("location_settings")
    .select("location_id, key, value")
    .eq("org_id", org.id)
    .in("key", ["admin_pin", "cashier_pin"]);
  if (pinErr) throw new Error(`Loading PINs: ${pinErr.message}`);
  const adminPinFor = new Map(
    (pinRows || []).filter((r) => r.key === "admin_pin").map((r) => [r.location_id, r.value])
  );

  const maxUsers = MAX_USERS[org.subscription_plan] ?? FALLBACK_MAX_USERS;

  console.log(`Shop:      ${org.name} (${org.id})`);
  console.log(`Plan:      ${org.subscription_plan} — ${maxUsers === null ? "unlimited" : maxUsers} seats`);
  console.log(`Branches:  ${locations.length ? locations.map((l) => l.name).join(", ") : "(none)"}`);
  console.log(`Team now:  ${members.length} member${members.length === 1 ? "" : "s"}`);
  console.log("");

  // --- Validate every row before writing anything. A half-applied batch is
  // worse than a rejected one: the operator has to work out who got created.
  const planned = [];
  const problems = [];

  for (const [i, raw] of entries.entries()) {
    const where = `row ${i + 1}`;
    const email = String(raw.email || "").trim().toLowerCase();
    const name = String(raw.name || "").trim();
    const branch = String(raw.branch || "").trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      problems.push(`${where}: "${raw.email}" is not a valid email address`);
      continue;
    }
    if (existingEmails.has(email)) {
      problems.push(`${where}: ${email} is already on this team`);
      continue;
    }
    if (planned.some((p) => p.email === email)) {
      problems.push(`${where}: ${email} appears twice in the list`);
      continue;
    }

    // A cashier MUST get a branch when the shop has any: current_user_location_ids()
    // matches on assigned_location_id, so a null one leaves them unable to see
    // any stock at all -- a POS that silently shows nothing.
    let locationId = null;
    if (locations.length > 0) {
      const loc = locByName.get(branch.toLowerCase());
      if (!branch) {
        problems.push(`${where}: ${email} has no branch — a cashier must be tied to one`);
        continue;
      }
      if (!loc) {
        problems.push(`${where}: no branch named "${branch}" at ${org.name}`);
        continue;
      }
      if (!loc.active) {
        problems.push(`${where}: branch "${loc.name}" is inactive`);
        continue;
      }
      locationId = loc.id;
    }

    // One org per user is load-bearing: create_organization_for_user rejects a
    // second membership and default_user_org_id() resolves with LIMIT 1 and no
    // ORDER BY, so a user in two orgs gets a nondeterministic active org. An
    // email already tied to another shop cannot be reused here.
    const existingId = byEmail.get(email) || null;
    if (existingId) {
      const { data: theirOrgs, error } = await supabase
        .from("org_members")
        .select("org_id")
        .eq("user_id", existingId);
      if (error) throw new Error(`Checking memberships for ${email}: ${error.message}`);
      if (theirOrgs && theirOrgs.length > 0) {
        problems.push(
          `${where}: ${email} already has a Tilify login tied to another shop — use a different address`
        );
        continue;
      }
    }

    // Supabase rejects anything under 6 characters, so a 4-digit PIN cannot
    // double as the password -- they are separate credentials here.
    const password = String(raw.password || "").trim() || null;
    if (password && password.length < 6) {
      problems.push(`${where}: password for ${email} is under 6 characters — Supabase will reject it`);
      continue;
    }

    // The PIN belongs to the branch, not the person. PinPad accepts 4-6 digits
    // and auto-submits at 4.
    const cashierPin = String(raw.cashierPin || "").trim() || null;
    if (cashierPin) {
      if (!/^\d{4,6}$/.test(cashierPin)) {
        problems.push(`${where}: PIN "${cashierPin}" must be 4 to 6 digits`);
        continue;
      }
      if (!locationId) {
        problems.push(`${where}: a PIN needs a branch to attach to`);
        continue;
      }
      const adminPin = adminPinFor.get(locationId) ?? "1234";
      if (cashierPin === adminPin) {
        problems.push(`${where}: PIN ${cashierPin} is already the admin PIN at ${branch} — it would open the admin view`);
        continue;
      }
      const clash = planned.find((p) => p.locationId === locationId && p.cashierPin && p.cashierPin !== cashierPin);
      if (clash) {
        problems.push(`${where}: ${branch} was already given PIN ${clash.cashierPin} — a branch has one cashier PIN, not one per person`);
        continue;
      }
    }

    planned.push({ email, name, branch, locationId, existingId, password, cashierPin });
  }

  const seatsAfter = members.length + planned.length;
  if (maxUsers !== null && seatsAfter > maxUsers) {
    problems.push(
      `Seats: ${members.length} used + ${planned.length} new = ${seatsAfter}, but the ${org.subscription_plan} plan allows ${maxUsers}. Upgrade or shorten the list.`
    );
  }

  for (const p of planned) {
    console.log(
      `  ${p.existingId ? "link  " : "create"}  ${p.email.padEnd(32)} ${p.branch || "(no branches)"}` +
        `${p.cashierPin ? `  PIN ${p.cashierPin}` : ""}${p.name ? `  — ${p.name}` : ""}`
    );
  }
  if (problems.length) {
    console.log("");
    for (const p of problems) console.log(`  SKIP/STOP  ${p}`);
  }
  console.log("");

  if (problems.length) {
    console.error(`${problems.length} problem(s) above. Nothing was written — fix the list and re-run.`);
    process.exit(1);
  }
  if (!apply) {
    console.log(`Dry run. Re-run with --apply to create these ${planned.length} cashier(s).`);
    return;
  }

  // --- Write.
  const credentials = [];
  for (const p of planned) {
    let userId = p.existingId;
    let password = null;

    if (!userId) {
      password = p.password || tempPassword();
      const { data: created, error } = await supabase.auth.admin.createUser({
        email: p.email,
        password,
        email_confirm: true, // sign in immediately, no email round-trip
        user_metadata: {
          ...(forceChange ? { must_change_password: true } : {}),
          ...(p.name ? { name: p.name } : {}),
        },
      });
      if (error || !created?.user) {
        console.error(`  FAILED  ${p.email}: ${error?.message || "could not create login"}`);
        continue;
      }
      userId = created.user.id;
    }

    const { error: linkErr } = await supabase
      .from("org_members")
      .insert({ org_id: org.id, user_id: userId, role: "member", assigned_location_id: p.locationId });

    if (linkErr) {
      // Roll back a login we just created but could not attach, so a re-run
      // isn't blocked by "email already exists" on an account nobody can use.
      if (!p.existingId) await supabase.auth.admin.deleteUser(userId);
      console.error(`  FAILED  ${p.email}: ${linkErr.message}`);
      continue;
    }

    credentials.push({
      email: p.email,
      name: p.name,
      branch: p.branch,
      locationId: p.locationId,
      pin: p.cashierPin,
      password,
    });
    console.log(`  OK      ${p.email} -> ${p.branch}`);
  }

  // --- Branch PINs. Separate from the accounts above: the PIN gates the till
  // at that location for everyone who signs in there, so it is set once per
  // branch regardless of how many logins were created for it.
  //
  // Built from the accounts that actually succeeded, not from `planned`: a
  // branch whose every login failed must keep its current PIN. Changing it
  // anyway would lock that branch's existing staff out of a till in exchange
  // for an account that does not exist.
  const pinByLocation = new Map();
  for (const c of credentials) if (c.pin) pinByLocation.set(c.locationId, c.pin);

  for (const [locationId, pin] of pinByLocation) {
    const { error } = await supabase.from("location_settings").upsert(
      { org_id: org.id, location_id: locationId, key: "cashier_pin", value: pin, updated_at: new Date().toISOString() },
      { onConflict: "location_id,key" }
    );
    const branch = locations.find((l) => l.id === locationId)?.name ?? locationId;
    console.log(error ? `  FAILED  PIN for ${branch}: ${error.message}` : `  OK      PIN ${pin} -> ${branch}`);
  }

  console.log("");
  console.log(`Created ${credentials.length} of ${planned.length}.`);
  console.log("Hand these out now — the passwords are stored nowhere and cannot be shown again.");
  if (forceChange) console.log("Each person is asked to change theirs on first sign-in.");
  console.log("");
  for (const c of credentials) {
    console.log(`  ${c.branch}${c.name ? ` — ${c.name}` : ""}`);
    console.log(`    email:    ${c.email}`);
    console.log(`    password: ${c.password ?? "(existing login — they keep their current password)"}`);
    if (c.pin) console.log(`    till PIN: ${c.pin}`);
  }
}

runMain(main);
