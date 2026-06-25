// POST /api/admin/payouts
//
// Compute and record a commission payout snapshot for one partner across a
// date range. Sums MRR over every active referral of theirs during the
// period, applies their commission_pct, and stores a row in
// commission_payouts (paid_at=null so it shows up as "Pending").
//
// Mumba then clicks Mark Paid in the UI once he's actually wired the money;
// that hits PATCH /api/admin/payouts/[id].
//
// Body: { partner_id, period_start, period_end, notes? }

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireAdmin } from "@/lib/platform-admin";
import { getPlan, type PlanCode } from "@/lib/plans";

export const runtime = "nodejs";

function mrrForPlan(planCode: string | null | undefined): number {
  if (!planCode) return 0;
  const plan = getPlan(planCode as PlanCode);
  if (!plan) return 0;
  const zar = plan.prices.ZAR;
  return zar ? zar.monthlyMinor / 100 : 0;
}

interface GenBody {
  partner_id: string;
  period_start: string; // YYYY-MM-DD
  period_end: string;   // YYYY-MM-DD
  notes?: string;
}

export async function POST(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let body: GenBody;
  try {
    body = (await req.json()) as GenBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.partner_id || !body.period_start || !body.period_end) {
    return NextResponse.json({ error: "partner_id, period_start, period_end required" }, { status: 400 });
  }
  if (new Date(body.period_end) < new Date(body.period_start)) {
    return NextResponse.json({ error: "period_end must be >= period_start" }, { status: 400 });
  }

  const admin = getSupabaseAdmin();

  const { data: partner } = await admin
    .from("partners")
    .select("id, commission_pct, status")
    .eq("id", body.partner_id)
    .maybeSingle();
  if (!partner) {
    return NextResponse.json({ error: "Partner not found" }, { status: 404 });
  }

  // Active referrals during the period: referred at or before period_end,
  // and either still active OR converted within the period. Simple v1: include
  // any referral whose status is currently 'active' that was converted before
  // period_end. More precise time-weighted accrual lands later.
  const { data: referrals } = await admin
    .from("referrals")
    .select(`
      org_id, status, converted_at,
      organizations:org_id ( subscription_plan, subscription_status )
    `)
    .eq("partner_id", body.partner_id);

  // Supabase foreign-key embeds may come back as either an object or an array
  // depending on relationship inference, so normalise to a single record.
  type OrgRel = { subscription_plan: string | null; subscription_status: string | null };
  type RefRaw = {
    org_id: string;
    status: string;
    converted_at: string | null;
    organizations: OrgRel | OrgRel[] | null;
  };
  type Ref = {
    org_id: string;
    status: string;
    converted_at: string | null;
    organizations: OrgRel | null;
  };
  const refRows: Ref[] = ((referrals as unknown as RefRaw[]) || []).map((r) => ({
    org_id: r.org_id,
    status: r.status,
    converted_at: r.converted_at,
    organizations: Array.isArray(r.organizations) ? r.organizations[0] ?? null : r.organizations,
  }));

  // Treat period_end as inclusive of the whole day. Compare date strings
  // (YYYY-MM-DD) directly so we don't get bitten by timezone-vs-midnight edge
  // cases when a referral converts on the same calendar day as period_end.
  const periodEndDate = body.period_end; // YYYY-MM-DD

  let activeCount = 0;
  let totalMrr = 0;
  for (const r of refRows) {
    if (r.status !== "active") continue;
    if (r.converted_at) {
      const convertedDate = r.converted_at.split("T")[0]; // YYYY-MM-DD
      if (convertedDate > periodEndDate) continue;
    }
    activeCount += 1;
    totalMrr += mrrForPlan(r.organizations?.subscription_plan);
  }

  const commissionPct = Number(partner.commission_pct);
  const commissionAmount = +(totalMrr * (commissionPct / 100)).toFixed(2);

  const { data: payout, error } = await admin
    .from("commission_payouts")
    .insert({
      partner_id: body.partner_id,
      period_start: body.period_start,
      period_end: body.period_end,
      total_referrals_active: activeCount,
      total_mrr_zar: totalMrr,
      commission_pct: commissionPct,
      commission_amount_zar: commissionAmount,
      notes: body.notes?.trim() || null,
    })
    .select("id, period_start, period_end, total_referrals_active, total_mrr_zar, commission_pct, commission_amount_zar, paid_at, notes, created_at")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ payout });
}
