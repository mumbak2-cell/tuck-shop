// PATCH /api/admin/partner-applications/[id] — approve or reject one application.
//
// Body: { decision: "approve" | "reject", review_notes?, code?, commission_pct? }
//
// approve:
//   - resolves the referral code (body.code || requested_code), validates it
//     and checks it is free in partners
//   - creates the partner (status active; commission_pct from body or 20%),
//     the same shape as POST /api/admin/partners
//   - links an existing auth user with the same email, if one exists
//   - stamps the application approved + partner_id
//
// reject:
//   - stamps the application rejected + review_notes
//
// Platform admin only.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireAdmin } from "@/lib/platform-admin";

export const runtime = "nodejs";

interface Body {
  decision: "approve" | "reject";
  review_notes?: string;
  code?: string;
  commission_pct?: number;
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { id } = await params;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (body.decision !== "approve" && body.decision !== "reject") {
    return NextResponse.json({ error: "decision must be 'approve' or 'reject'" }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  const { data: app } = await admin
    .from("partner_applications")
    .select("id, name, email, phone, requested_code, status")
    .eq("id", id)
    .maybeSingle();

  if (!app) {
    return NextResponse.json({ error: "Application not found" }, { status: 404 });
  }
  if (app.status !== "pending") {
    return NextResponse.json({ error: `Application already ${app.status}` }, { status: 409 });
  }

  const reviewStamp = {
    reviewed_by_user_id: auth.userId,
    reviewed_at: new Date().toISOString(),
    review_notes: body.review_notes?.trim() || null,
  };

  // ---- Reject -------------------------------------------------------------
  if (body.decision === "reject") {
    const { error } = await admin
      .from("partner_applications")
      .update({ ...reviewStamp, status: "rejected" })
      .eq("id", id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, status: "rejected" });
  }

  // ---- Approve ----------------------------------------------------------
  const code = (body.code || app.requested_code || "").trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) {
    return NextResponse.json(
      { error: "A referral code (3–32 chars: A–Z, 0–9, hyphen, underscore) is required to approve." },
      { status: 400 }
    );
  }

  const commissionPct = Number(body.commission_pct) || 20;
  if (commissionPct < 0 || commissionPct > 100) {
    return NextResponse.json({ error: "Commission percentage must be 0 to 100" }, { status: 400 });
  }

  const { data: clash } = await admin
    .from("partners")
    .select("id")
    .ilike("code", code)
    .maybeSingle();
  if (clash) {
    return NextResponse.json({ error: `A partner with code "${code}" already exists.` }, { status: 409 });
  }

  // Link an existing auth user with this email so the partner can sign in
  // and see /partner straight away.
  let userId: string | null = null;
  {
    const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
    const found = users?.users?.find((u) => u.email?.toLowerCase() === app.email.toLowerCase());
    if (found) userId = found.id;
  }

  const { data: partner, error: insErr } = await admin
    .from("partners")
    .insert({
      code,
      name: app.name,
      email: app.email,
      phone: app.phone,
      commission_pct: commissionPct,
      status: "active",
      user_id: userId,
      notes: "Created from self-serve application",
    })
    .select("id, code, name, email, phone, commission_pct, status, notes, user_id")
    .single();

  if (insErr) {
    if (insErr.code === "23505") {
      return NextResponse.json({ error: `Code "${code}" is already taken.` }, { status: 409 });
    }
    return NextResponse.json({ error: insErr.message }, { status: 500 });
  }

  const { error: updErr } = await admin
    .from("partner_applications")
    .update({ ...reviewStamp, status: "approved", partner_id: partner.id })
    .eq("id", id);
  if (updErr) {
    // Partner exists but the application row didn't flip — report it so the
    // admin doesn't approve twice.
    return NextResponse.json(
      { error: `Partner created but marking the application failed: ${updErr.message}`, partner },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, status: "approved", partner, linkedUser: !!userId });
}
