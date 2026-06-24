// GET   /api/admin/partners/[id] — full detail for one partner: their record,
//                                  every referred org with subscription state,
//                                  and full payout history.
// PATCH /api/admin/partners/[id] — update partner fields (status, commission_pct, etc.)

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

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { id } = await params;
  const admin = getSupabaseAdmin();

  const { data: partner } = await admin
    .from("partners")
    .select("id, code, name, email, phone, commission_pct, status, notes, user_id, created_at")
    .eq("id", id)
    .maybeSingle();

  if (!partner) {
    return NextResponse.json({ error: "Partner not found" }, { status: 404 });
  }

  const { data: referrals } = await admin
    .from("referrals")
    .select(`
      id, org_id, status, referred_at, converted_at,
      organizations:org_id (
        name, subscription_plan, subscription_status, current_period_end, trial_ends_at
      )
    `)
    .eq("partner_id", id)
    .order("referred_at", { ascending: false });

  type Ref = {
    id: string;
    org_id: string;
    status: string;
    referred_at: string;
    converted_at: string | null;
    organizations: {
      name: string;
      subscription_plan: string | null;
      subscription_status: string | null;
      current_period_end: string | null;
      trial_ends_at: string | null;
    } | null;
  };

  const refRows = (referrals as unknown as Ref[]) || [];

  const { data: payouts } = await admin
    .from("commission_payouts")
    .select("id, period_start, period_end, total_referrals_active, total_mrr_zar, commission_pct, commission_amount_zar, paid_at, paid_reference, notes, created_at")
    .eq("partner_id", id)
    .order("period_start", { ascending: false });

  const payoutRows = (payouts as Array<{
    id: string; period_start: string; period_end: string;
    total_referrals_active: number; total_mrr_zar: string | number;
    commission_pct: string | number; commission_amount_zar: string | number;
    paid_at: string | null; paid_reference: string | null;
    notes: string | null; created_at: string;
  }>) || [];

  // Aggregate stats
  let activeRefs = 0;
  let totalMrr = 0;
  for (const r of refRows) {
    if (r.status === "active") {
      activeRefs += 1;
      totalMrr += mrrForPlan(r.organizations?.subscription_plan);
    }
  }
  let totalPaid = 0;
  let totalPending = 0;
  for (const p of payoutRows) {
    const amt = Number(p.commission_amount_zar) || 0;
    if (p.paid_at) totalPaid += amt;
    else totalPending += amt;
  }

  return NextResponse.json({
    partner: {
      ...partner,
      commission_pct: Number(partner.commission_pct),
    },
    stats: {
      totalReferrals: refRows.length,
      activeReferrals: activeRefs,
      trialingReferrals: refRows.filter((r) => r.status === "trialing").length,
      churnedReferrals: refRows.filter((r) => r.status === "churned").length,
      totalMrrZar: totalMrr,
      estimatedMonthlyCommissionZar: totalMrr * (Number(partner.commission_pct) / 100),
      totalCommissionPaidZar: totalPaid,
      totalCommissionPendingZar: totalPending,
    },
    referrals: refRows.map((r) => ({
      id: r.id,
      orgName: r.organizations?.name || "(deleted org)",
      plan: r.organizations?.subscription_plan,
      subscriptionStatus: r.organizations?.subscription_status,
      status: r.status,
      referredAt: r.referred_at,
      convertedAt: r.converted_at,
      mrrZar: r.status === "active" ? mrrForPlan(r.organizations?.subscription_plan) : 0,
    })),
    payouts: payoutRows,
  });
}

interface PatchBody {
  status?: "active" | "paused" | "terminated";
  commission_pct?: number;
  name?: string;
  email?: string;
  phone?: string | null;
  notes?: string | null;
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { id } = await params;

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.status) {
    if (!["active", "paused", "terminated"].includes(body.status)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
    patch.status = body.status;
  }
  if (typeof body.commission_pct === "number") {
    if (body.commission_pct < 0 || body.commission_pct > 100) {
      return NextResponse.json({ error: "Commission must be 0 to 100" }, { status: 400 });
    }
    patch.commission_pct = body.commission_pct;
  }
  if (typeof body.name === "string") patch.name = body.name.trim();
  if (typeof body.email === "string") patch.email = body.email.trim().toLowerCase();
  if (body.phone !== undefined) patch.phone = body.phone ? body.phone.trim() : null;
  if (body.notes !== undefined) patch.notes = body.notes ? body.notes.trim() : null;

  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("partners")
    .update(patch)
    .eq("id", id)
    .select("id, code, name, email, phone, commission_pct, status, notes, user_id")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ partner: data });
}
