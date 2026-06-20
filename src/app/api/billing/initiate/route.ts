// POST /api/billing/initiate
// Body: { planCode: "starter" | "growth" | "pro", cycle: "monthly" | "annual" }
//
// Looks up the calling user's org, picks the right plan price for the
// org's billing currency, creates a transaction with Paystack or
// Flutterwave, returns the checkout URL the client should redirect to.

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  PLANS,
  providerForCurrency,
  type PlanCode,
} from "@/lib/plans";

export const runtime = "nodejs";

interface InitiateBody {
  planCode: PlanCode;
  cycle: "monthly" | "annual";
}

export async function POST(req: Request) {
  let body: InitiateBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { planCode, cycle } = body;

  if (!planCode || (cycle !== "monthly" && cycle !== "annual")) {
    return NextResponse.json({ error: "planCode and cycle are required" }, { status: 400 });
  }

  // Identify the calling user from their Supabase access token (sent in
  // the Authorization header by the browser client automatically when
  // we call /api/* with credentials).
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

  // Look up the org the user belongs to + its billing currency.
  const { data: membership } = await getSupabaseAdmin()
    .from("org_members")
    .select("org_id, organizations(id, name)")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();

  if (!membership) {
    return NextResponse.json({ error: "No organization for this user" }, { status: 404 });
  }
  const orgId = membership.org_id;

  // The org's currency lives in app_settings.
  const { data: currencyRow } = await getSupabaseAdmin()
    .from("app_settings")
    .select("value")
    .eq("org_id", orgId)
    .eq("key", "currency")
    .maybeSingle();
  const currency = (currencyRow?.value || "ZAR").toUpperCase();

  const plan = PLANS.find((p) => p.code === planCode);
  if (!plan) {
    return NextResponse.json({ error: "Unknown plan" }, { status: 400 });
  }
  const price = plan.prices[currency];
  if (!price) {
    return NextResponse.json(
      { error: `${plan.name} is not yet available in ${currency}. Please email support@mkglobal.co.za for manual invoicing.` },
      { status: 400 }
    );
  }
  const amountMinor = cycle === "monthly" ? price.monthlyMinor : price.annualMinor;

  const provider = providerForCurrency(currency);
  const reference = `tilify_${orgId}_${planCode}_${Date.now()}`;
  const callbackBase = (process.env.NEXT_PUBLIC_SITE_URL || new URL(req.url).origin).replace(/\/+$/, "");
  const callbackUrl = `${callbackBase}/settings?billing=success&ref=${encodeURIComponent(reference)}`;

  if (provider === "paystack") {
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
        currency,
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
  }

  if (provider === "flutterwave") {
    const secret = process.env.FLUTTERWAVE_SECRET_KEY;
    if (!secret) {
      return NextResponse.json(
        { error: "Flutterwave is not yet configured. Email support@mkglobal.co.za and we will invoice you directly." },
        { status: 503 }
      );
    }

    const fwRes = await fetch("https://api.flutterwave.com/v3/payments", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        tx_ref: reference,
        amount: amountMinor / 100,
        currency,
        redirect_url: callbackUrl,
        payment_options: "card,mobilemoneymalawi,mobilemoneyzambia,mobilemoneytanzania,mobilemoneyrwanda,mobilemoneyuganda,mpesa,ussd,banktransfer",
        customer: {
          email: userEmail,
        },
        meta: {
          org_id: orgId,
          plan_code: planCode,
          cycle,
        },
        customizations: {
          title: "Tilify Subscription",
          description: `${plan.name} plan, ${cycle}`,
        },
      }),
    });
    const fwJson = await fwRes.json();
    if (!fwRes.ok || fwJson.status !== "success") {
      return NextResponse.json(
        { error: fwJson.message || "Flutterwave initialisation failed" },
        { status: 502 }
      );
    }
    return NextResponse.json({
      provider: "flutterwave",
      checkoutUrl: fwJson.data.link,
      reference,
    });
  }

  // Manual: provider unsupported in this currency
  return NextResponse.json(
    { error: `Self-service billing is not yet available in ${currency}. Please email support@mkglobal.co.za to subscribe.` },
    { status: 503 }
  );
}
