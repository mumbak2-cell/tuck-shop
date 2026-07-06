// POST /api/billing/initiate
// Body: { planCode: "starter" | "growth" | "pro", cycle: "monthly" | "quarterly" | "annual" }
//
// All Tilify subscriptions are billed in ZAR via Paystack regardless of the
// operator's local POS currency. Their products, customers, and reports stay
// in their local currency - this only affects the Tilify monthly fee.
// Operators pay with any Visa or Mastercard; the card issuer handles FX.

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { PLANS, BILLING_CURRENCY, type PlanCode } from "@/lib/plans";

export const runtime = "nodejs";

interface InitiateBody {
  planCode: PlanCode;
  cycle: "monthly" | "quarterly" | "annual";
}

export async function POST(req: Request) {
  let body: InitiateBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { planCode, cycle } = body;

  try {
  if (!planCode || !["monthly", "quarterly", "annual"].includes(cycle)) {
    return NextResponse.json({ error: "planCode and cycle are required" }, { status: 400 });
  }

  // Identify the calling user from their Supabase access token.
  const authHeader = req.headers.get("authorization") || "";
  const accessToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!accessToken) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const supabaseUser = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${accessToken}` } } }
  );
  const { data: userData, error: userErr } = await supabaseUser.auth.getUser(accessToken);
  if (userErr || !userData.user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const userId = userData.user.id;
  const userEmail = userData.user.email!;

  // Look up the org the user belongs to.
  const { data: membership } = await getSupabaseAdmin()
    .from("org_members")
    .select("org_id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();

  if (!membership) {
    return NextResponse.json({ error: "No organization for this user" }, { status: 404 });
  }
  const orgId = membership.org_id;

  const plan = PLANS.find((p) => p.code === planCode);
  if (!plan) {
    return NextResponse.json({ error: "Unknown plan" }, { status: 400 });
  }
  const price = plan.prices[BILLING_CURRENCY];
  if (!price) {
    return NextResponse.json({ error: "Plan price unavailable" }, { status: 500 });
  }
  const amountMinor =
    cycle === "monthly"
      ? price.monthlyMinor
      : cycle === "quarterly"
      ? price.quarterlyMinor
      : price.annualMinor;

  const reference = `tilify_${orgId}_${planCode}_${Date.now()}`;
  const callbackBase = (process.env.NEXT_PUBLIC_SITE_URL || new URL(req.url).origin).replace(/\/+$/, "");
  const callbackUrl = `${callbackBase}/settings?billing=success&ref=${encodeURIComponent(reference)}`;

  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    return NextResponse.json({ error: "Paystack is not configured on the server" }, { status: 503 });
  }

  const psRes = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: userEmail,
      amount: amountMinor,
      currency: BILLING_CURRENCY,
      reference,
      callback_url: callbackUrl,
      metadata: {
        org_id: orgId,
        plan_code: planCode,
        cycle,
      },
    }),
  });
  const psJson = await psRes.json();
  if (!psRes.ok || !psJson.status) {
    return NextResponse.json(
      { error: psJson.message || "Paystack initialisation failed" },
      { status: 502 }
    );
  }
  return NextResponse.json({
    provider: "paystack",
    checkoutUrl: psJson.data.authorization_url,
    reference: psJson.data.reference,
  });
  } catch (err: unknown) {
    console.error("[billing/initiate]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
