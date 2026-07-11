"use client";
// Sync orchestrator: refreshes the cache from Supabase and drains the queue.
// OrgContext mounts this once on startup. It self-schedules: runs immediately,
// runs again when the browser tells us we're back online, and runs every 5
// minutes while online to keep the cache fresh.

import { db } from "@/lib/supabase";
import {
  readQueue,
  markOpDone,
  recordOpFailure,
  saveCache,
  type QueuedOp,
} from "@/lib/offline-store";
import { replayOp } from "@/lib/offline-ops";
import { fetchAllPaged } from "@/lib/fetch-all";

const CACHE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const MAX_RETRIES_BEFORE_PARK = 8;

let intervalId: number | null = null;
let inFlight = false;

/**
 * Refresh the local cache for the given org. Pulls products, payment_methods,
 * customers, locations and app_settings. RLS handles scoping; we don't need
 * to filter by org_id client-side.
 */
export async function refreshCache(orgId: string): Promise<void> {
  if (!navigator.onLine) return;

  // Products, customers, and product_stock can all exceed Supabase's
  // server-side max_rows ceiling (default 1000), so they're paginated via
  // .range(). Without this, offline POS at large operators would silently
  // miss every SKU past the first 1000.
  const [products, productStock, locationPrices, customers, { data: paymentMethods }, { data: locations }, { data: settings }] = await Promise.all([
    fetchAllPaged<Record<string, unknown>>(() =>
      db.from("products").select("*").eq("discontinued", false).order("name")
    ),
    fetchAllPaged<Record<string, unknown>>(() =>
      db.from("product_stock").select("*")
    ),
    // Per-branch price overrides — small (only the exceptions), but paginated
    // for safety. A failed read (e.g. migration 042 not yet applied) yields []
    // so branch pricing degrades to base prices rather than breaking sync.
    fetchAllPaged<Record<string, unknown>>(() =>
      db.from("product_location_prices").select("*")
    ).catch(() => []),
    fetchAllPaged<Record<string, unknown>>(() =>
      db.from("customers").select("*")
    ),
    db.from("payment_methods").select("*").eq("active", true).order("sort_order"),
    db.from("locations").select("*").eq("active", true).order("sort_order"),
    db.from("app_settings").select("*"),
  ]);

  saveCache(orgId, "products", products);
  saveCache(orgId, "product_stock", productStock);
  saveCache(orgId, "product_location_prices", locationPrices);
  saveCache(orgId, "customers", customers);
  if (paymentMethods) saveCache(orgId, "payment_methods", paymentMethods);
  if (locations) saveCache(orgId, "locations", locations);
  if (settings) saveCache(orgId, "app_settings", settings);
}

/**
 * Drain the queue for the given org. Each op is replayed; success removes it
 * from the queue, failure increments the attempt count. After
 * MAX_RETRIES_BEFORE_PARK attempts an op is left in place for manual review —
 * we don't loop forever on a permanently broken row.
 */
/** Internal: drain the queue without managing the inFlight lock. */
async function drainQueue(orgId: string): Promise<{ sent: number; failed: number }> {
  const queue = readQueue(orgId);
  let sent = 0;
  let failed = 0;

  for (const op of queue) {
    if (op.attempts >= MAX_RETRIES_BEFORE_PARK) continue;
    const r = await replayOp(op as QueuedOp);
    if (r.ok) {
      markOpDone(orgId, op.id);
      sent += 1;
    } else {
      recordOpFailure(orgId, op.id, r.error ?? "Unknown");
      failed += 1;
    }
  }

  return { sent, failed };
}

/**
 * Drain the queue for the given org. Each op is replayed; success removes it
 * from the queue, failure increments the attempt count. After
 * MAX_RETRIES_BEFORE_PARK attempts an op is left in place for manual review —
 * we don't loop forever on a permanently broken row.
 *
 * H3 fix: gated behind the inFlight lock so concurrent calls (e.g. queue-changed
 * event firing while syncOnce is running) don't double-replay non-idempotent ops.
 */
export async function flushQueue(orgId: string): Promise<{ sent: number; failed: number }> {
  if (!navigator.onLine || inFlight) return { sent: 0, failed: 0 };
  inFlight = true;
  try {
    return await drainQueue(orgId);
  } finally {
    inFlight = false;
  }
}

/**
 * Run one full sync cycle: refresh the cache, then drain the queue.
 */
export async function syncOnce(orgId: string): Promise<void> {
  if (!navigator.onLine || inFlight) return;
  inFlight = true;
  try {
    await refreshCache(orgId);
    await drainQueue(orgId);
  } catch {
    // Don't blow up the loop - we'll try again next tick.
  } finally {
    inFlight = false;
  }
}

/**
 * Begin background syncing for an org. Idempotent — safe to call repeatedly.
 * Stops the previous loop before starting a new one (e.g. on org switch).
 */
export function startSyncLoop(orgId: string): () => void {
  stopSyncLoop();

  // Initial sync
  void syncOnce(orgId);

  // Periodic refresh
  intervalId = window.setInterval(() => {
    void syncOnce(orgId);
  }, CACHE_REFRESH_INTERVAL_MS);

  // Sync immediately when we come back online
  function onOnline() { void syncOnce(orgId); }
  window.addEventListener("online", onOnline);

  // Flush queue (without full refresh) when a new op is enqueued and we're online
  function onQueueChanged(e: Event) {
    const detail = (e as CustomEvent).detail as { orgId: string };
    if (detail.orgId === orgId && navigator.onLine) {
      void flushQueue(orgId);
    }
  }
  window.addEventListener("tilify:queue-changed", onQueueChanged as EventListener);

  return () => {
    stopSyncLoop();
    window.removeEventListener("online", onOnline);
    window.removeEventListener("tilify:queue-changed", onQueueChanged as EventListener);
  };
}

export function stopSyncLoop(): void {
  if (intervalId !== null) {
    window.clearInterval(intervalId);
    intervalId = null;
  }
}
