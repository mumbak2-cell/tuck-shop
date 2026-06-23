// GET /api/partners/me
//
// Returns the partner summary for the calling user — their own partner
// row, the list of orgs they've referred (with names, plans, statuses),
// aggregate MRR + commission stats, and their payout history.
//
// Uses the admin client to join across organizations (which the partner
// is otherwise blocked from reading by RLS). Auth is verified server-side
// via the Supabase access token in the Authorization header.

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getPlan, type PlanCode } from "@/lib/plans";

export const runtime = "nodejs";

interface ReferralRow {
  id: string;
  org_id: string;
  status: "trialing" | "active" | "churned";
  referred_at: string;
  converted_at: string | null;
  organizations: {
    name: string;
    subscription_plan: string | null;
    subscription_status: string | null;
    current_period_end: string | null;
    trial_ends_at: string | null;
  } | null;
}

function mrrForPlan(planCode: string | null | undefined): number {
  if (!planCode) return 0;
  const plan = getPlan(planCode as PlanCode);
  if (!plan) return 0;
  const zar = plan.prices.ZAR;
  return zar ? zar.monthlyMinor / 100 : 0;
}

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization") || "";
  const accessToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!accessToken) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const userClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${accessToken}` } } }
  );
  const { data: userData, error: userErr } = await userClient.auth.getUser(accessToken);
  if (userErr || !userData.user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const admin = getSupabaseAdmin();

  // Find the partner row for this user.
  const { data: partner } = await admin
    .from("partners")
    .select("id, code, name, email, phone, commission_pct, status, created_at")
    .eq("user_id", userData.user.id)
    .maybeSingle();

  if (!partner) {
    return NextResponse.json({ partner: null }, { status: 200 });
  }

  // Referrals + minimal org details (admin client bypasses RLS).
  const { data: referrals } = await admin
    .from("referrals")
    .select(`
      id, org_id, status, referred_at, converted_at,
      organizations:org_id (
        name, subscription_plan, subscription_status, current_period_end, trial_ends_at
      )
    `)
    .eq("partner_id", partner.id)
    .order("referred_at", { ascending: false });

  const referralRows = (referrals as unknown as ReferralRow[]) || [];

  // Aggregate MRR from active referrals only.
  let activeCount = 0;
  let totalMrr = 0;
  for (const r of referralRows) {
    if (r.status === "active") {
      activeCount += 1;
      totalMrr += mrrForPlan(r.organizations?.subscription_plan);
    }
  }
  const estimatedMonthlyCommission = totalMrr * (Number(partner.commission_pct) / 100);

  // Payouts
  const { data: payouts } = await admin
    .from("commission_payouts")
    .select("id, period_start, period_end, total_referrals_active, total_mrr_zar, commission_pct, commission_amount_zar, paid_at, paid_reference, notes, created_at")
    .eq("partner_id", partner.id)
    .order("period_start", { ascending: false });

  const payoutRows = (payouts as unknown as Array<{
    commission_amount_zar: string | number;
    paid_at: string | null;
  }>) || [];

  let totalPaid = 0;
  let totalPending = 0;
  for (const p of payoutRows) {
    const amt = Number(p.commission_amount_zar) || 0;
    if (p.paid_at) totalPaid += amt;
    else totalPending += amt;
  }

  return NextResponse.json({
    partner: {
      id: partner.id,
      code: partner.code,
      name: partner.name,
      email: partner.email,
      phone: partner.phone,
      commission_pct: Number(partner.commission_pct),
      status: partner.status,
      created_at: partner.created_at,
    },
    stats: {
      totalReferrals: referralRows.length,
      activeReferrals: activeCount,
      trialingReferrals: referralRows.filter((r) => r.status === "trialing").length,
      churnedReferrals: referralRows.filter((r) => r.status === "churned").length,
      totalMrrZar: totalMrr,
      estimatedMonthlyCommissionZar: estimatedMonthlyCommission,
      totalCommissionPaidZar: totalPaid,
      totalCommissionPendingZar: totalPending,
    },
    referrals: referralRows.map((r) => ({
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
