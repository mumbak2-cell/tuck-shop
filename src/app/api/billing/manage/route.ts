// POST /api/billing/manage
//
// Returns a Paystack manage-subscription link where the customer can update
// their card or cancel. The link is single-use and short-lived.

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization") || "";
  const accessToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!accessToken) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const supabaseUser = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${accessToken}` } } },
  );
  const { data: userData, error: userErr } = await supabaseUser.auth.getUser(accessToken);
  if (userErr || !userData.user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const admin = getSupabaseAdmin();
  const { data: membership } = await admin
    .from("org_members")
    .select("org_id")
    .eq("user_id", userData.user.id)
    .limit(1)
    .maybeSingle();

  if (!membership) {
    return NextResponse.json({ error: "No organization" }, { status: 404 });
  }

  const { data: org } = await admin
    .from("organizations")
    .select("billing_subscription_id")
    .eq("id", membership.org_id)
    .single();

  if (!org?.billing_subscription_id) {
    return NextResponse.json(
      { error: "No active subscription to manage" },
      { status: 404 },
    );
  }

  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    return NextResponse.json({ error: "Paystack not configured" }, { status: 503 });
  }

  const res = await fetch(
    `https://api.paystack.co/subscription/${org.billing_subscription_id}/manage/link`,
    { headers: { Authorization: `Bearer ${secret}` } },
  );

  if (!res.ok) {
    const body = await res.text();
    console.error("Paystack manage/link failed:", res.status, body);
    return NextResponse.json({ error: "Could not generate manage link" }, { status: 502 });
  }

  const { data } = await res.json();
  return NextResponse.json({ url: data.link });
}
