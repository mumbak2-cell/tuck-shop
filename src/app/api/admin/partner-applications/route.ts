// GET /api/admin/partner-applications — list applications for the review queue.
//
// Platform admin only. Query param ?status=pending|approved|rejected|all
// (default: pending).

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireAdmin } from "@/lib/platform-admin";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const url = new URL(req.url);
  const status = url.searchParams.get("status") || "pending";

  const admin = getSupabaseAdmin();
  let query = admin
    .from("partner_applications")
    .select(
      "id, name, email, phone, requested_code, pitch, status, review_notes, reviewed_at, partner_id, created_at"
    )
    .order("created_at", { ascending: false });

  if (status !== "all") {
    query = query.eq("status", status);
  }

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { count: pendingCount } = await admin
    .from("partner_applications")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");

  return NextResponse.json({ applications: data || [], pendingCount: pendingCount || 0 });
}
