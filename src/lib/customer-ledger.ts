import { db } from "@/lib/supabase";
import { fetchAllPaged } from "@/lib/fetch-all";

// How much of a customer's balance originated before the current calendar
// month and is still unpaid — i.e. what's overdue. Filters server-side by
// date so this stays cheap even for customers with long histories.
export async function computeOverdueForCustomers(
  customerIds: string[],
  asOf: Date = new Date()
): Promise<Record<string, number>> {
  const totals: Record<string, number> = {};
  for (const id of customerIds) totals[id] = 0;
  if (customerIds.length === 0) return totals;

  const monthStart = new Date(asOf.getFullYear(), asOf.getMonth(), 1);
  // Built from local Y/M/D directly — going through toISOString() first
  // would convert to UTC and could shift the calendar day backward for any
  // timezone ahead of UTC (e.g. SAST, UTC+2), excluding same-day rows.
  const monthStartDate = `${asOf.getFullYear()}-${String(asOf.getMonth() + 1).padStart(2, "0")}-01`;
  const monthStartTs = monthStart.toISOString();

  const [payments, sales, adjustments, paymentsThisMonth, adjustmentsThisMonth] = await Promise.all([
    fetchAllPaged<{ customer_id: string; amount: number }>(() =>
      db
        .from("customer_payments")
        .select("customer_id, amount")
        .in("customer_id", customerIds)
        .lt("payment_date", monthStartDate)
    ),
    fetchAllPaged<{ customer_id: string; total_amount: number }>(() =>
      db
        .from("sales")
        .select("customer_id, total_amount")
        .in("customer_id", customerIds)
        .eq("voided", false)
        .lt("sale_date", monthStartDate)
    ),
    fetchAllPaged<{ customer_id: string; amount: number }>(() =>
      db
        .from("balance_adjustments")
        .select("customer_id, amount")
        .in("customer_id", customerIds)
        .lt("created_at", monthStartTs)
    ),
    // Payments made THIS month count against last month's debt first — a
    // customer who owed R1394 going into September and paid R1323 on the
    // 2nd is down to R71 overdue, not still R1394. Without this, "overdue"
    // stays frozen at the month-start snapshot even after they've paid.
    fetchAllPaged<{ customer_id: string; amount: number }>(() =>
      db
        .from("customer_payments")
        .select("customer_id, amount")
        .in("customer_id", customerIds)
        .gte("payment_date", monthStartDate)
    ),
    fetchAllPaged<{ customer_id: string; amount: number }>(() =>
      db
        .from("balance_adjustments")
        .select("customer_id, amount")
        .in("customer_id", customerIds)
        .gte("created_at", monthStartTs)
        .lt("amount", 0)
    ),
  ]);

  for (const p of payments) totals[p.customer_id] -= p.amount;
  for (const s of sales) totals[s.customer_id] += s.total_amount;
  for (const a of adjustments) totals[a.customer_id] += a.amount;

  for (const id of customerIds) totals[id] = Math.max(totals[id], 0);

  for (const p of paymentsThisMonth) {
    if (totals[p.customer_id] > 0) totals[p.customer_id] = Math.max(0, totals[p.customer_id] - p.amount);
  }
  for (const a of adjustmentsThisMonth) {
    if (totals[a.customer_id] > 0) totals[a.customer_id] = Math.max(0, totals[a.customer_id] + a.amount);
  }

  return totals;
}

export async function computeOverdue(customerId: string, asOf: Date = new Date()): Promise<number> {
  const result = await computeOverdueForCustomers([customerId], asOf);
  return result[customerId] ?? 0;
}

// How much of a customer's current balance comes from a purchase that's
// been unpaid for 60+ days — used to gate credit sales at POS. Age-based
// rather than calendar-month based, so a regular payer with a small,
// recent residual (e.g. paid most of last month's balance a day or two
// into this one) never gets blocked; only genuinely stale debt does.
//
// FIFO: each payment/credit pays off the oldest still-open purchase first,
// same logic collections aging normally uses.
export async function computeAgedOverdue(
  customerId: string,
  thresholdDays: number = 60,
  asOf: Date = new Date()
): Promise<number> {
  const [payments, sales, adjustments] = await Promise.all([
    fetchAllPaged<{ payment_date: string; amount: number }>(() =>
      db.from("customer_payments").select("payment_date, amount").eq("customer_id", customerId)
    ),
    fetchAllPaged<{ sale_date: string; created_at: string; total_amount: number }>(() =>
      db
        .from("sales")
        .select("sale_date, created_at, total_amount")
        .eq("customer_id", customerId)
        .eq("voided", false)
    ),
    fetchAllPaged<{ created_at: string; amount: number }>(() =>
      db.from("balance_adjustments").select("created_at, amount").eq("customer_id", customerId)
    ),
  ]);

  // Positive = debit (adds to what's owed), negative = credit (pays it down).
  const lines = [
    ...sales.map((s) => ({ date: s.sale_date || s.created_at, amount: s.total_amount })),
    ...payments.map((p) => ({ date: p.payment_date, amount: -p.amount })),
    ...adjustments.map((a) => ({ date: a.created_at, amount: a.amount })),
  ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  const openDebits: { date: string; remaining: number }[] = [];
  for (const line of lines) {
    if (line.amount >= 0) {
      openDebits.push({ date: line.date, remaining: line.amount });
      continue;
    }
    let credit = -line.amount;
    for (const debit of openDebits) {
      if (credit <= 0) break;
      const applied = Math.min(debit.remaining, credit);
      debit.remaining -= applied;
      credit -= applied;
    }
    // Leftover credit (customer overpaid) isn't tracked here — it doesn't
    // affect which debits are still open, only computeOverdue's totals do.
  }

  const cutoff = new Date(asOf);
  cutoff.setDate(cutoff.getDate() - thresholdDays);

  return openDebits
    .filter((d) => d.remaining > 0.01 && new Date(d.date) < cutoff)
    .reduce((sum, d) => sum + d.remaining, 0);
}
