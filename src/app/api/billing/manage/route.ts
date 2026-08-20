// POST /api/billing/manage
//
// Returns a Paystack manage-subscription link where the customer can update
// their card or cancel. The link is single-use and short-lived.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireOrgOwner } from "@/lib/org-owner";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const auth = await requireOrgOwner(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const admin = getSupabaseAdmin();

  const { data: org } = await admin
    .from("organizations")
    .select("billing_subscription_id")
    .eq("id", auth.orgId!)
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
