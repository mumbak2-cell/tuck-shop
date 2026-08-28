"use client";
// One-line interfaces used by callers (PaymentModal, ExpensesPage, etc.) to
// safely submit a write that may be queued if offline. Each function:
//
//   1. Generates an idempotency key (UUID) if the caller didn't supply one.
//   2. Tries the live Supabase call.
//   3. On network failure, enqueues the operation and returns ok=true to the
//      caller (the cashier sees success — sale is "saved", will sync).
//   4. On a logical failure (e.g. RLS violation, validation), returns ok=false
//      and the caller surfaces the error to the user.

import { db } from "@/lib/supabase";
import { enqueueOp, upsertIntoCache, type QueuedOp } from "@/lib/offline-store";

function isNetworkError(err: { message?: string } | null | undefined): boolean {
  if (!err) return false;
  const m = (err.message || "").toLowerCase();
  return (
    m.includes("failed to fetch") ||
    m.includes("network") ||
    m.includes("typeerror") ||
    m.includes("load failed") ||
    m.includes("aborted") ||
    !navigator.onLine
  );
}

function newId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  // Fallback for ancient browsers
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// -------------------------------------------------------------------------
// POS Sale batch
// -------------------------------------------------------------------------

export interface SaleLineItem {
  product_id: string;
  quantity: number;
  unit_price: number;
  total_amount: number;
  /** Cost per unit at time of sale, for P&L accuracy. */
  cost_price: number;
  /** Whether this line item is at wholesale pricing. */
  is_wholesale?: boolean;
}

export interface SaleBatchInput {
  org_id: string;
  location_id: string;
  payment_method: string;
  payment_reference: string | null;
  customer_id: string | null;
  lines: SaleLineItem[];
  /** When the sale happened — client-side timestamp, kept on replay. */
  created_at: string;
  /** YYYY-MM-DD */
  sale_date: string;
  /**
   * Physical cash handed to the customer on top of the goods, funded by
   * charging it to their card. Transaction-level, not per line.
   */
  cash_back?: number;
}

export interface SaleBatchResult {
  ok: boolean;
  queued: boolean;
  sale_ids: string[];
  error?: string;
}

/**
 * Submit a sale batch using the idempotent RPC. If the network call fails,
 * the operation is enqueued for replay on reconnect and the cashier still
 * gets `ok: true` so the receipt prints and the till advances.
 */
export async function submitSaleBatch(input: SaleBatchInput): Promise<SaleBatchResult> {
  const sale_ids = input.lines.map(() => newId());

  const args = {
    p_sale_ids: sale_ids,
    p_org_id: input.org_id,
    p_location_id: input.location_id,
    p_product_ids: input.lines.map((l) => l.product_id),
    p_quantities: input.lines.map((l) => l.quantity),
    p_unit_prices: input.lines.map((l) => l.unit_price),
    p_total_amounts: input.lines.map((l) => l.total_amount),
    p_payment_method: input.payment_method,
    p_payment_reference: input.payment_reference,
    p_customer_id: input.customer_id,
    p_sale_date: input.sale_date,
    p_created_at: input.created_at,
    p_cost_prices: input.lines.map((l) => l.cost_price),
    p_is_wholesale: input.lines.map((l) => l.is_wholesale ?? false),
    p_cash_back: input.cash_back ?? 0,
  };

  if (navigator.onLine) {
    const { error } = await db.rpc("submit_sale_batch", args);
    if (!error) {
      return { ok: true, queued: false, sale_ids };
    }
    // If logical failure (RLS, validation), do NOT queue — return error to caller.
    if (!isNetworkError(error)) {
      return { ok: false, queued: false, sale_ids, error: error.message };
    }
    // fall through to enqueue (network blip while we thought we were online)
  }

  // Offline path: enqueue — throws if storage is full (H2 fix)
  try {
    enqueueOp(input.org_id, {
      id: sale_ids[0], // batch keyed off the first line's id
      kind: "submit_sale_batch",
      payload: args,
    });
  } catch {
    return { ok: false, queued: false, sale_ids, error: "Device storage is full. This sale was NOT saved. Free up space or go online to continue." };
  }
  return { ok: true, queued: true, sale_ids };
}

// -------------------------------------------------------------------------
// Generic "insert into table or queue" helper
// -------------------------------------------------------------------------

export interface SimpleInsertInput<T extends { id?: string }> {
  org_id: string;
  table: string;
  /** Provide to optimistically update the local read cache. Omit for tables
   *  we don't cache (expenses, customer_payments, shifts, etc.). */
  cacheKind?: "customers" | "products" | "locations" | "app_settings" | "payment_methods" | "product_stock";
  row: T;
  /** Map QueuedOp.kind to the right replay handler. */
  queueKind: QueuedOp["kind"];
}

/**
 * For tables where we can insert one row directly. Adds the row to the local
 * cache optimistically (if cacheKind is set) so the next page render
 * includes it, even when queued.
 */
export async function insertOrQueue<T extends { id?: string }>(
  input: SimpleInsertInput<T>
): Promise<{ ok: boolean; queued: boolean; row: T & { id: string }; error?: string }> {
  const row = { ...input.row, id: input.row.id ?? newId() } as T & { id: string };

  if (navigator.onLine) {
    const { error } = await db.from(input.table).insert(row);
    if (!error) {
      if (input.cacheKind) upsertIntoCache(input.org_id, input.cacheKind, row);
      return { ok: true, queued: false, row };
    }
    if (!isNetworkError(error)) {
      return { ok: false, queued: false, row, error: error.message };
    }
  }

  // Offline path — enqueueOp throws if localStorage is full (H2 fix)
  try {
    enqueueOp(input.org_id, {
      id: row.id,
      kind: input.queueKind,
      payload: { table: input.table, row },
    });
  } catch {
    return { ok: false, queued: false, row, error: "Device storage is full. This operation was NOT saved. Free up space or go online to continue." };
  }
  if (input.cacheKind) upsertIntoCache(input.org_id, input.cacheKind, row);
  return { ok: true, queued: true, row };
}

// -------------------------------------------------------------------------
// Replay (used by the sync loop)
// -------------------------------------------------------------------------

export async function replayOp(op: QueuedOp): Promise<{ ok: boolean; error?: string }> {
  try {
    switch (op.kind) {
      case "submit_sale_batch": {
        const payload = op.payload as Record<string, unknown>;
        const { error } = await db.rpc("submit_sale_batch", payload);
        if (error) return { ok: false, error: error.message };
        return { ok: true };
      }
      case "insert_expense":
      case "insert_customer":
      case "upsert_stock_count": {
        const p = op.payload as { table: string; row: Record<string, unknown> };
        const { error } = await db.from(p.table).upsert(p.row, { onConflict: "id", ignoreDuplicates: false });
        if (error) return { ok: false, error: error.message };
        return { ok: true };
      }
      case "insert_customer_payment": {
        // Two-step replay: insert the payment if it's not already there
        // (idempotent by client-generated id), then decrement the customer's
        // balance by the same amount. Skip the balance step if the payment
        // was already in the DB so we don't double-decrement.
        const p = op.payload as {
          table: string;
          row: { id: string; customer_id: string; amount: number | string } & Record<string, unknown>;
        };
        const existing = await db.from("customer_payments").select("id").eq("id", p.row.id).maybeSingle();
        if (existing.data) return { ok: true };
        const insertRes = await db.from(p.table).insert(p.row);
        if (insertRes.error) return { ok: false, error: insertRes.error.message };
        // Atomic balance decrement — no read-then-write race (H1 fix)
        const amt = Number(p.row.amount) || 0;
        if (amt > 0) {
          await db.rpc("adjust_customer_balance", {
            p_customer_id: p.row.customer_id,
            p_delta: -amt,
          });
        }
        return { ok: true };
      }
      case "open_shift":
      case "close_shift": {
        const p = op.payload as { table: string; row: Record<string, unknown> };
        const { error } = await db.from(p.table).upsert(p.row, { onConflict: "id" });
        if (error) return { ok: false, error: error.message };
        return { ok: true };
      }
      default:
        return { ok: false, error: `Unknown op kind: ${op.kind}` };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
