// GET /api/reports/cashier-expenses?from=YYYY-MM-DD&to=YYYY-MM-DD&locationId=<uuid>
//
// Owner-only. Aggregates the org's expenses by the person who recorded them
// (expenses.recorded_by_user_id, added in migration 046) and resolves each id
// to an email/name via the admin API — auth.users isn't readable client-side,
// so this must run server-side with the service-role client. The owner check
// is the authorisation gate.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireOrgOwner } from "@/lib/org-owner";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

interface ExpenseRow {
  recorded_by_user_id: string | null;
  amount: number | string;
}

/** Resolve user ids to {email, name} via the paginated admin API. */
async function identitiesFor(
  admin: SupabaseClient,
  ids: string[]
): Promise<Map<string, { email: string | null; name: string | null }>> {
  const want = new Set(ids);
  const out = new Map<string, { email: string | null; name: string | null }>();
  if (want.size === 0) return out;
  const perPage = 1000;
  for (let page = 1; page <= 20 && out.size < want.size; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(error.message);
    const users = data?.users || [];
    for (const u of users) {
      if (want.has(u.id)) {
        const name = (u.user_metadata as { name?: string } | null)?.name ?? null;
        out.set(u.id, { email: u.email ?? null, name });
      }
    }
    if (users.length < perPage) break;
  }
  return out;
}

/** Fetch every matching expense row, paging past PostgREST's 1000-row cap. */
async function fetchExpenses(
  admin: SupabaseClient,
  orgId: string,
  from: string,
  to: string,
  locationId: string | null
): Promise<ExpenseRow[]> {
  const rows: ExpenseRow[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    let query = admin
      .from("expenses")
      .select("recorded_by_user_id, amount")
      .eq("org_id", orgId)
      .gte("expense_date", from)
      .lte("expense_date", to)
      .range(offset, offset + pageSize - 1);
    if (locationId) query = query.eq("location_id", locationId);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const batch = (data as ExpenseRow[] | null) || [];
    rows.push(...batch);
    if (batch.length < pageSize) break;
  }
  return rows;
}

export async function GET(req: Request) {
  const auth = await requireOrgOwner(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const url = new URL(req.url);
  const from = url.searchParams.get("from") || "";
  const to = url.searchParams.get("to") || "";
  const locationId = url.searchParams.get("locationId") || null;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(from) || !dateRe.test(to)) {
    return NextResponse.json({ error: "from and to must be YYYY-MM-DD dates" }, { status: 400 });
  }

  const admin = getSupabaseAdmin();

  let rows: ExpenseRow[];
  try {
    rows = await fetchExpenses(admin, auth.orgId!, from, to, locationId);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not load expenses" },
      { status: 500 }
    );
  }

  // Aggregate by recorder. Null id = recorded before per-cashier tracking (046).
  const NULL_KEY = "__unattributed__";
  const agg = new Map<string, { total: number; count: number }>();
  let grandTotal = 0;
  for (const r of rows) {
    const amt = Number(r.amount) || 0;
    grandTotal += amt;
    const key = r.recorded_by_user_id ?? NULL_KEY;
    const cur = agg.get(key) ?? { total: 0, count: 0 };
    cur.total += amt;
    cur.count += 1;
    agg.set(key, cur);
  }

  const realIds = [...agg.keys()].filter((k) => k !== NULL_KEY);
  let identities: Map<string, { email: string | null; name: string | null }>;
  try {
    identities = await identitiesFor(admin, realIds);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not resolve staff" },
      { status: 500 }
    );
  }

  const cashiers = [...agg.entries()]
    .map(([key, v]) => {
      if (key === NULL_KEY) {
        return { userId: null, name: "Unattributed (before per-cashier tracking)", email: null, ...v };
      }
      const id = identities.get(key);
      return {
        userId: key,
        name: id?.name || id?.email || "(removed user)",
        email: id?.email ?? null,
        ...v,
      };
    })
    .sort((a, b) => b.total - a.total);

  return NextResponse.json({ from, to, locationId, total: grandTotal, cashiers });
}
