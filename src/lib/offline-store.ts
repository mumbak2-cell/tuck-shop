"use client";
// Offline store: a thin localStorage-backed cache + write queue keyed by org_id.
//
// Two responsibilities:
//
//   1. Cache reads — when a page loads data from Supabase, mirror it into the
//      cache. When the user is offline, screens render from the cache instead
//      of a sad empty state.
//
//   2. Queue writes — when a write attempt fails because the device is offline,
//      the operation is dropped into a per-org queue. A sync loop in
//      `offline-sync.ts` drains the queue when navigator.onLine comes back.
//
// localStorage is intentional for v1: 5MB is enough for a few hundred SKUs and
// a busy day's queued sales, the API is synchronous so no race conditions, and
// no extra dependency. IndexedDB / `idb` is a Slice 9 follow-up once Mary's
// catalogue grows past the size where localStorage stops fitting.

const KIND_KEYS = ["products", "payment_methods", "customers", "locations", "app_settings", "product_stock", "product_location_prices"] as const;
export type CacheKind = (typeof KIND_KEYS)[number];

const cacheKey = (orgId: string, kind: CacheKind) => `tilify_cache_${orgId}_${kind}`;
const queueKey = (orgId: string) => `tilify_queue_${orgId}`;
const meta = (orgId: string, kind: CacheKind) => `tilify_cache_${orgId}_${kind}_meta`;

// -------------------------------------------------------------------------
// Cache helpers (read-side)
// -------------------------------------------------------------------------

export interface CacheMeta {
  updated_at: string;
  count: number;
}

export function saveCache<T>(orgId: string, kind: CacheKind, rows: T[]): void {
  try {
    localStorage.setItem(cacheKey(orgId, kind), JSON.stringify(rows));
    localStorage.setItem(meta(orgId, kind), JSON.stringify({
      updated_at: new Date().toISOString(),
      count: rows.length,
    } as CacheMeta));
  } catch {
    // Quota exceeded or storage disabled — fail silently. Online reads still work.
  }
}

export function readCache<T>(orgId: string, kind: CacheKind): T[] | null {
  try {
    const raw = localStorage.getItem(cacheKey(orgId, kind));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed as T[];
  } catch {
    return null;
  }
}

export function readCacheMeta(orgId: string, kind: CacheKind): CacheMeta | null {
  try {
    const raw = localStorage.getItem(meta(orgId, kind));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as CacheMeta;
  } catch {
    return null;
  }
}

export function cacheAgeMs(orgId: string, kind: CacheKind): number {
  const m = readCacheMeta(orgId, kind);
  if (!m) return Infinity;
  return Date.now() - new Date(m.updated_at).getTime();
}

/**
 * Optimistic upsert into the cache so a successful write — online or queued —
 * shows up immediately on the next render. Matches by `id`.
 */
export function upsertIntoCache<T extends { id: string }>(orgId: string, kind: CacheKind, row: T): void {
  const current = readCache<T>(orgId, kind) ?? [];
  const idx = current.findIndex((r) => r.id === row.id);
  if (idx >= 0) current[idx] = { ...current[idx], ...row };
  else current.unshift(row);
  saveCache(orgId, kind, current);
}

export function removeFromCache(orgId: string, kind: CacheKind, id: string): void {
  const current = readCache<{ id: string }>(orgId, kind) ?? [];
  saveCache(orgId, kind, current.filter((r) => r.id !== id));
}

// -------------------------------------------------------------------------
// Queue helpers (write-side)
// -------------------------------------------------------------------------

export type QueuedOpKind =
  | "submit_sale_batch"        // POS sale - calls the idempotent RPC
  | "insert_expense"
  | "insert_customer"
  | "insert_customer_payment"
  | "upsert_stock_count"
  | "open_shift"
  | "close_shift";

export interface QueuedOp {
  /** Idempotency key — client-generated UUID. Used for retry-safe replay. */
  id: string;
  kind: QueuedOpKind;
  payload: unknown;
  enqueued_at: string;
  attempts: number;
  last_error?: string;
}

export function readQueue(orgId: string): QueuedOp[] {
  try {
    const raw = localStorage.getItem(queueKey(orgId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as QueuedOp[];
  } catch {
    return [];
  }
}

function writeQueue(orgId: string, ops: QueuedOp[]): void {
  // H2 fix: throw on storage failure instead of swallowing it.
  // Callers (enqueueOp) propagate this to the UI so the cashier
  // knows the operation was NOT saved.
  localStorage.setItem(queueKey(orgId), JSON.stringify(ops));
  // Notify any same-tab subscribers so the badge updates immediately.
  window.dispatchEvent(new CustomEvent("tilify:queue-changed", { detail: { orgId, count: ops.length } }));
}

/**
 * Enqueue an operation for offline replay.
 * Throws if localStorage is full — callers MUST catch and show an error toast
 * so the cashier knows the operation was NOT saved (H2 fix).
 */
export function enqueueOp(orgId: string, op: Omit<QueuedOp, "enqueued_at" | "attempts">): QueuedOp {
  const queued: QueuedOp = {
    ...op,
    enqueued_at: new Date().toISOString(),
    attempts: 0,
  };
  const current = readQueue(orgId);
  current.push(queued);
  writeQueue(orgId, current); // throws on quota exceeded
  return queued;
}

export function markOpDone(orgId: string, opId: string): void {
  try {
    writeQueue(orgId, readQueue(orgId).filter((o) => o.id !== opId));
  } catch {
    // Non-critical: op already succeeded server-side. Worst case it replays
    // idempotently on next sync.
  }
}

export function recordOpFailure(orgId: string, opId: string, errorMsg: string): void {
  try {
    const current = readQueue(orgId);
    const next = current.map((o) =>
      o.id === opId ? { ...o, attempts: o.attempts + 1, last_error: errorMsg } : o
    );
    writeQueue(orgId, next);
  } catch {
    // Non-critical: retry count won't increment but data isn't lost.
  }
}

export function pendingCount(orgId: string): number {
  return readQueue(orgId).length;
}

// -------------------------------------------------------------------------
// Hygiene
// -------------------------------------------------------------------------

/**
 * Clear the cached read data for an org. Never touches the write queue —
 * the cache is a copy of what's on the server, the queue is the only copy
 * of what isn't.
 */
export function clearOfflineCache(orgId: string): void {
  try {
    for (const k of KIND_KEYS) {
      localStorage.removeItem(cacheKey(orgId, k));
      localStorage.removeItem(meta(orgId, k));
    }
  } catch {
    // ignore
  }
}

/**
 * Clear cache and queue for an org. Called on sign-out so the next signed-in
 * user does not see the previous user's queued operations.
 *
 * Refuses to drop a non-empty queue unless `discardQueue` is passed, and
 * returns the number of ops it left behind. Queued ops are sales, expenses
 * and payments that exist nowhere else — deleting them destroys a cashier's
 * takings. Callers must decide, with the user, before discarding.
 */
export function clearOfflineStore(
  orgId: string,
  opts: { discardQueue?: boolean } = {}
): { queueRetained: number } {
  clearOfflineCache(orgId);

  const pending = pendingCount(orgId);
  if (pending > 0 && !opts.discardQueue) {
    return { queueRetained: pending };
  }

  try {
    localStorage.removeItem(queueKey(orgId));
  } catch {
    // ignore
  }
  return { queueRetained: 0 };
}
