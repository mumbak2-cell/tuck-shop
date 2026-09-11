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
// Customers, locations, payment methods and settings change rarely (daily at
// most) compared to products/stock, which move on every sale. Refreshing
// them on the same 5-min cycle as hot data wastes bandwidth on large
// catalogues, so they're refreshed on a longer interval instead.
const COLD_REFRESH_MS = 30 * 60 * 1000;
const MAX_RETRIES_BEFORE_PARK = 8;

let intervalId: number | null = null;
let inFlight = false;
let lastColdRefresh = 0;

// Columns the POS actually reads from the cached `products` rows
// (pos/page.tsx, product-grid.tsx, payment-modal.tsx's RewardProduct). The
// margin/purchasing fields a cashier never sees — package_price,
// qty_in_pack, units_per_batch, recipe_cost_per_unit, default_supplier,
// reorder_level, created_at — are left out. cost_per_unit stays: it feeds
// costPrice on the cart line for the sale record.
const PRODUCT_COLUMNS =
  "id, inventory_id, name, category, cost_per_unit, selling_price, is_prepared, opening_stock, discontinued, wholesale_enabled, wholesale_min_qty, wholesale_price";

/**
 * Refresh the local cache for the given org. Pulls products, payment_methods,
 * customers, locations and app_settings. RLS handles scoping; we don't need
 * to filter by org_id client-side.
 *
 * `locationId` scopes product_stock and product_location_prices to the
 * current branch, matching what the online POS path already does
 * (pos/page.tsx:139) — a multi-location org was otherwise downloading every
 * other branch's stock/price rows on every cache refresh, just to discard
 * them client-side. Pass null to keep the old unfiltered behaviour (used
 * when no location is selected yet).
 */
export async function refreshCache(orgId: string, locationId: string | null): Promise<void> {
  if (!navigator.onLine) return;

  const now = Date.now();
  const refreshCold = now - lastColdRefresh > COLD_REFRESH_MS;

  // Products and product_stock can both exceed Supabase's server-side
  // max_rows ceiling (default 1000), so they're paginated via .range().
  // Without this, offline POS at large operators would silently miss every
  // SKU past the first 1000.
  const [products, productStock, locationPrices] = await Promise.all([
    fetchAllPaged<Record<string, unknown>>(() =>
      db.from("products").select(PRODUCT_COLUMNS).eq("discontinued", false).order("name")
    ),
    fetchAllPaged<Record<string, unknown>>(() => {
      const q = db.from("product_stock").select("product_id, quantity, location_id");
      return locationId ? q.eq("location_id", locationId) : q;
    }),
    // Per-branch price overrides — small (only the exceptions), but paginated
    // for safety. A failed read (e.g. migration 042 not yet applied) yields []
    // so branch pricing degrades to base prices rather than breaking sync.
    fetchAllPaged<Record<string, unknown>>(() => {
      const q = db.from("product_location_prices").select("product_id, selling_price, location_id");
      return locationId ? q.eq("location_id", locationId) : q;
    }).catch(() => []),
  ]);

  saveCache(orgId, "products", products);
  saveCache(orgId, "product_stock", productStock);
  saveCache(orgId, "product_location_prices", locationPrices);

  if (refreshCold) {
    const [customers, { data: paymentMethods }, { data: locations }, { data: settings }] = await Promise.all([
      fetchAllPaged<Record<string, unknown>>(() =>
        db.from("customers").select("*")
      ),
      db.from("payment_methods").select("*").eq("active", true).order("sort_order"),
      db.from("locations").select("*").eq("active", true).order("sort_order"),
      db.from("app_settings").select("*"),
    ]);

    saveCache(orgId, "customers", customers);
    if (paymentMethods) saveCache(orgId, "payment_methods", paymentMethods);
    if (locations) saveCache(orgId, "locations", locations);
    if (settings) saveCache(orgId, "app_settings", settings);
    lastColdRefresh = now;
  }
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
export async function syncOnce(orgId: string, locationId: string | null): Promise<void> {
  if (!navigator.onLine || inFlight) return;
  inFlight = true;
  try {
    await refreshCache(orgId, locationId);
    await drainQueue(orgId);
  } catch {
    // Don't blow up the loop - we'll try again next tick.
  } finally {
    inFlight = false;
  }
}

/**
 * The periodic interval tick. Skips the cache refresh while the tab is
 * hidden — a backgrounded till isn't shown to anyone, so there is nothing to
 * keep fresh — but the write queue still drains every tick regardless,
 * hidden or not, so a queued offline sale never waits on the tab being
 * foregrounded to reach Supabase.
 */
async function intervalTick(orgId: string, locationId: string | null): Promise<void> {
  if (!navigator.onLine || inFlight) return;
  inFlight = true;
  try {
    if (!document.hidden) {
      await refreshCache(orgId, locationId);
    }
    await drainQueue(orgId);
  } catch {
    // Don't blow up the loop - we'll try again next tick.
  } finally {
    inFlight = false;
  }
}

/**
 * Begin background syncing for an org, scoped to the given location.
 * Idempotent — safe to call repeatedly. Stops the previous loop before
 * starting a new one (e.g. on org or location switch).
 */
export function startSyncLoop(orgId: string, locationId: string | null): () => void {
  stopSyncLoop();

  // Initial sync
  void syncOnce(orgId, locationId);

  // Periodic refresh — skips the cache pull while the tab is hidden (see
  // intervalTick), still drains the queue every tick.
  intervalId = window.setInterval(() => {
    void intervalTick(orgId, locationId);
  }, CACHE_REFRESH_INTERVAL_MS);

  // Sync immediately when we come back online
  function onOnline() { void syncOnce(orgId, locationId); }
  window.addEventListener("online", onOnline);

  // A tab returning to the foreground shouldn't be showing up to
  // CACHE_REFRESH_INTERVAL_MS-stale stock — refresh right away rather than
  // waiting for the next tick.
  function onVisible() {
    if (!document.hidden) void syncOnce(orgId, locationId);
  }
  document.addEventListener("visibilitychange", onVisible);

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
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("tilify:queue-changed", onQueueChanged as EventListener);
  };
}

export function stopSyncLoop(): void {
  if (intervalId !== null) {
    window.clearInterval(intervalId);
    intervalId = null;
  }
}
