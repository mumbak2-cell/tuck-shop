#!/usr/bin/env node
//
// One-off reconciliation for the `receipts` storage bucket.
//
// Receipt files upload the moment a file is picked, before the owning row is
// written, so an abandoned form used to strand an object nothing references.
// That leak is fixed in the app (see src/lib/receipt-storage.ts), but files
// orphaned before the fix are still sitting in the bucket, counted against
// storage and reachable by nothing.
//
// This lists every object, subtracts every path referenced by `expenses` or
// `stock_receipts`, and reports what is left over.
//
//   Dry run (default — reports, changes nothing):
//     node --env-file=.env.local scripts/cleanup-orphaned-receipts.mjs
//
//   Actually delete:
//     node --env-file=.env.local scripts/cleanup-orphaned-receipts.mjs --delete
//
// Needs SUPABASE_SERVICE_ROLE_KEY: listing the bucket and counting references
// must span every org, which RLS deliberately prevents the anon key from doing.

import { createClient } from "@supabase/supabase-js";

const BUCKET = "receipts";
const PAGE = 1000;

// An object younger than this is assumed to be an upload still in flight —
// picked but not yet saved against a row. Deleting those would break a receipt
// the operator is in the middle of attaching.
const MIN_AGE_MS = 60 * 60 * 1000;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n" +
      "Run with: node --env-file=.env.local scripts/cleanup-orphaned-receipts.mjs"
  );
  process.exit(1);
}

const doDelete = process.argv.includes("--delete");
const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Every object in the bucket, as { path, size, createdAt }. */
async function listObjects() {
  const out = [];

  // Paths are `{orgId}/{uuid}.{ext}`, so the root listing returns org folders
  // (entries with a null id) and the files live one level down.
  const folders = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .list("", { limit: PAGE, offset });
    if (error) throw new Error(`Listing bucket root: ${error.message}`);
    folders.push(...data.filter((e) => e.id === null).map((e) => e.name));
    if (data.length < PAGE) break;
  }

  for (const folder of folders) {
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await supabase.storage
        .from(BUCKET)
        .list(folder, { limit: PAGE, offset });
      if (error) throw new Error(`Listing ${folder}: ${error.message}`);
      for (const entry of data) {
        if (entry.id === null) continue; // nested folder; not a shape we create
        out.push({
          path: `${folder}/${entry.name}`,
          size: entry.metadata?.size ?? 0,
          createdAt: entry.created_at ? new Date(entry.created_at).getTime() : 0,
        });
      }
      if (data.length < PAGE) break;
    }
  }

  return out;
}

/** Every non-null receipt_path in a table. */
async function referencedPaths(table) {
  const found = new Set();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select("receipt_path")
      .not("receipt_path", "is", null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Reading ${table}: ${error.message}`);
    for (const row of data) found.add(row.receipt_path);
    if (data.length < PAGE) break;
  }
  return found;
}

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(2);

async function main() {
  const [objects, expenseRefs, receiptRefs] = await Promise.all([
    listObjects(),
    referencedPaths("expenses"),
    referencedPaths("stock_receipts"),
  ]);

  const referenced = new Set([...expenseRefs, ...receiptRefs]);
  const now = Date.now();

  const orphans = [];
  let recentSkipped = 0;
  for (const obj of objects) {
    if (referenced.has(obj.path)) continue;
    if (now - obj.createdAt < MIN_AGE_MS) {
      recentSkipped++;
      continue;
    }
    orphans.push(obj);
  }

  const totalBytes = objects.reduce((n, o) => n + o.size, 0);
  const orphanBytes = orphans.reduce((n, o) => n + o.size, 0);

  console.log(`Objects in bucket:     ${objects.length} (${mb(totalBytes)} MB)`);
  console.log(`Referenced by a row:   ${referenced.size}`);
  console.log(`Too recent to judge:   ${recentSkipped}`);
  console.log(`Orphaned:              ${orphans.length} (${mb(orphanBytes)} MB)`);

  if (orphans.length === 0) {
    console.log("\nNothing to clean up.");
    return;
  }

  console.log("");
  for (const o of orphans) {
    const age = Math.floor((now - o.createdAt) / 86400000);
    console.log(`  ${o.path}  ${mb(o.size)} MB  ${age}d old`);
  }

  if (!doDelete) {
    console.log(`\nDry run — nothing deleted. Re-run with --delete to remove these ${orphans.length}.`);
    return;
  }

  // storage.remove() takes a batch; keep each request a sane size.
  let removed = 0;
  for (let i = 0; i < orphans.length; i += 100) {
    const batch = orphans.slice(i, i + 100).map((o) => o.path);
    const { error } = await supabase.storage.from(BUCKET).remove(batch);
    if (error) {
      console.error(`\nFailed on batch starting ${i}: ${error.message}`);
      process.exit(1);
    }
    removed += batch.length;
  }

  console.log(`\nDeleted ${removed} objects, reclaiming ${mb(orphanBytes)} MB.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
