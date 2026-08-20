// POST /api/billing/initiate
// Body: { planCode: "starter" | "growth" | "pro", cycle: "monthly" | "quarterly" | "annual" }
//
// All Tilify subscriptions are billed in ZAR via Paystack regardless of the
// operator's local POS currency. Their products, customers, and reports stay
// in their local currency - this only affects the Tilify monthly fee.
// Operators pay with any Visa or Mastercard; the card issuer handles FX.

import { NextResponse } from "next/server";
import { requireOrgOwner } from "@/lib/org-owner";
import { PLANS, BILLING_CURRENCY } from "@/lib/plans";
import { paystackPlanCode } from "@/lib/paystack-plans";
import { rateLimit } from "@/lib/rate-limit";
import { z } from "zod";

export const runtime = "nodejs";

const InitiateSchema = z.object({
  planCode: z.enum(["starter", "growth", "pro"]),
  cycle: z.enum(["monthly", "quarterly", "annual"]),
});

export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = InitiateSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const { planCode, cycle } = parsed.data;

  try {

  const auth = await requireOrgOwner(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const userId = auth.userId!;
  const userEmail = auth.email!;
  const orgId = auth.orgId!;

  const rl = rateLimit(`billing:${userId}`, { max: 5 });
  if (!rl.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

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

  // If a recurring Paystack Plan is configured for this (tier, cycle), pass its
  // code so Paystack sets up an auto-renewing Subscription. If not configured
  // yet, this stays a single one-time charge — so the endpoint keeps working
  // before the Plans exist in the Paystack dashboard.
  //
  // `amount` is ALWAYS sent: transaction/initialize requires it even when a
  // `plan` is supplied — omitting it returns "Invalid amount". Our per-cycle
  // amount equals the Plan's amount, so Paystack accepts the pair and bills the
  // Plan's amount on the recurring schedule.
  const recurringPlan = paystackPlanCode(planCode, cycle);

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
      ...(recurringPlan ? { plan: recurringPlan } : {}),
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
