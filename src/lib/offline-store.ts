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

const KIND_KEYS = ["products", "payment_methods", "customers", "locations", "app_settings", "product_stock"] as const;
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
    return JSON.parse(raw) as T[];
  } catch {
    return null;
  }
}

export function readCacheMeta(orgId: string, kind: CacheKind): CacheMeta | null {
  try {
    const raw = localStorage.getItem(meta(orgId, kind));
    if (!raw) return null;
    return JSON.parse(raw) as CacheMeta;
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
    return JSON.parse(raw) as QueuedOp[];
  } catch {
    return [];
  }
}

function writeQueue(orgId: string, ops: QueuedOp[]): void {
  try {
    localStorage.setItem(queueKey(orgId), JSON.stringify(ops));
    // Notify any same-tab subscribers so the badge updates immediately.
    window.dispatchEvent(new CustomEvent("tilify:queue-changed", { detail: { orgId, count: ops.length } }));
  } catch {
    // Storage quota exceeded — caller should handle (probably show a hard error,
    // since we'd be losing data otherwise).
  }
}

export function enqueueOp(orgId: string, op: Omit<QueuedOp, "enqueued_at" | "attempts">): QueuedOp {
  const queued: QueuedOp = {
    ...op,
    enqueued_at: new Date().toISOString(),
    attempts: 0,
  };
  const current = readQueue(orgId);
  current.push(queued);
  writeQueue(orgId, current);
  return queued;
}

export function markOpDone(orgId: string, opId: string): void {
  writeQueue(orgId, readQueue(orgId).filter((o) => o.id !== opId));
}

export function recordOpFailure(orgId: string, opId: string, errorMsg: string): void {
  const current = readQueue(orgId);
  const next = current.map((o) =>
    o.id === opId ? { ...o, attempts: o.attempts + 1, last_error: errorMsg } : o
  );
  writeQueue(orgId, next);
}

export function pendingCount(orgId: string): number {
  return readQueue(orgId).length;
}

// -------------------------------------------------------------------------
// Hygiene
// -------------------------------------------------------------------------

/**
 * Clear cache and queue for an org. Called on sign-out so the next signed-in
 * user does not see the previous user's queued operations.
 */
export function clearOfflineStore(orgId: string): void {
  try {
    for (const k of KIND_KEYS) {
      localStorage.removeItem(cacheKey(orgId, k));
      localStorage.removeItem(meta(orgId, k));
    }
    localStorage.removeItem(queueKey(orgId));
  } catch {
    // ignore
  }
}
