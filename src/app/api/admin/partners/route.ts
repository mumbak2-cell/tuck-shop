// GET  /api/admin/partners  — list every partner with quick stats.
// POST /api/admin/partners  — create a new partner.
//
// Platform admin only. The list view feeds /admin/partners. Each row
// includes the partner record plus aggregated stats for the table.

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

export async function GET(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const admin = getSupabaseAdmin();
  const { data: partners } = await admin
    .from("partners")
    .select("id, code, name, email, phone, commission_pct, status, created_at")
    .order("created_at", { ascending: false });

  const partnerRows = (partners as Array<{
    id: string; code: string; name: string; email: string;
    phone: string | null; commission_pct: string | number;
    status: string; created_at: string;
  }> | null) || [];

  // Per-partner stats: total referrals, active referrals, total MRR (active only),
  // pending commission (unpaid payouts).
  const partnerIds = partnerRows.map((p) => p.id);

  const refsByPartner = new Map<string, { total: number; active: number; mrr: number }>();
  if (partnerIds.length > 0) {
    const { data: refs } = await admin
      .from("referrals")
      .select(`partner_id, status, organizations:org_id ( subscription_plan )`)
      .in("partner_id", partnerIds);

    ((refs as unknown as Array<{
      partner_id: string;
      status: string;
      organizations: { subscription_plan: string | null } | null;
    }>) || []).forEach((r) => {
      const e = refsByPartner.get(r.partner_id) || { total: 0, active: 0, mrr: 0 };
      e.total += 1;
      if (r.status === "active") {
        e.active += 1;
        e.mrr += mrrForPlan(r.organizations?.subscription_plan);
      }
      refsByPartner.set(r.partner_id, e);
    });
  }

  const pendingByPartner = new Map<string, number>();
  if (partnerIds.length > 0) {
    const { data: payouts } = await admin
      .from("commission_payouts")
      .select("partner_id, commission_amount_zar, paid_at")
      .in("partner_id", partnerIds);

    ((payouts as Array<{
      partner_id: string;
      commission_amount_zar: string | number;
      paid_at: string | null;
    }>) || []).forEach((p) => {
      if (!p.paid_at) {
        const amt = Number(p.commission_amount_zar) || 0;
        pendingByPartner.set(p.partner_id, (pendingByPartner.get(p.partner_id) || 0) + amt);
      }
    });
  }

  return NextResponse.json({
    partners: partnerRows.map((p) => {
      const refs = refsByPartner.get(p.id) || { total: 0, active: 0, mrr: 0 };
      return {
        id: p.id,
        code: p.code,
        name: p.name,
        email: p.email,
        phone: p.phone,
        commission_pct: Number(p.commission_pct),
        status: p.status,
        created_at: p.created_at,
        stats: {
          totalReferrals: refs.total,
          activeReferrals: refs.active,
          totalMrrZar: refs.mrr,
          pendingCommissionZar: pendingByPartner.get(p.id) || 0,
        },
      };
    }),
  });
}

interface CreatePartnerBody {
  code: string;
  name: string;
  email: string;
  phone?: string;
  commission_pct?: number;
  notes?: string;
}

export async function POST(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let body: CreatePartnerBody;
  try {
    body = (await req.json()) as CreatePartnerBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const code = (body.code || "").trim().toUpperCase();
  const name = (body.name || "").trim();
  const email = (body.email || "").trim().toLowerCase();
  const phone = body.phone?.trim() || null;
  const commission_pct = Number(body.commission_pct) || 20;
  const notes = body.notes?.trim() || null;

  if (!code || code.length < 3 || code.length > 32) {
    return NextResponse.json({ error: "Code must be 3 to 32 characters" }, { status: 400 });
  }
  if (!/^[A-Z0-9_-]+$/.test(code)) {
    return NextResponse.json({ error: "Code can only contain A-Z, 0-9, hyphen and underscore" }, { status: 400 });
  }
  if (!name || !email) {
    return NextResponse.json({ error: "Name and email are required" }, { status: 400 });
  }
  if (commission_pct < 0 || commission_pct > 100) {
    return NextResponse.json({ error: "Commission percentage must be 0 to 100" }, { status: 400 });
  }

  const admin = getSupabaseAdmin();

  // Optional: link to an existing auth user with this email so the partner
  // can log in immediately and see the /partner dashboard.
  let user_id: string | null = null;
  {
    const { data: existingUsers } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
    const found = existingUsers?.users?.find(
      (u) => u.email?.toLowerCase() === email
    );
    if (found) user_id = found.id;
  }

  const { data: inserted, error } = await admin
    .from("partners")
    .insert({
      code,
      name,
      email,
      phone,
      commission_pct,
      notes,
      status: "active",
      user_id,
    })
    .select("id, code, name, email, phone, commission_pct, status, notes, user_id, created_at")
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: `A partner with code "${code}" already exists` }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ partner: inserted, linkedUser: !!user_id });
}
