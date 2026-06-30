// POST /api/billing/webhook/paystack
// Receives Paystack subscription and charge events.
//
// Verifies HMAC SHA512 signature against PAYSTACK_SECRET_KEY before
// trusting any field. Logs every delivery into invoice_events, then
// reconciles the org's subscription state on charge.success.

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

interface PaystackEvent {
  event: string;
  data: {
    reference?: string;
    status?: string;
    amount?: number;
    currency?: string;
    customer?: { email?: string };
    metadata?: {
      org_id?: string;
      plan_code?: string;
      cycle?: "monthly" | "annual";
    };
  };
}

export async function POST(req: Request) {
  const rawBody = await req.text();
  const signature = req.headers.get("x-paystack-signature") || "";
  const secret = process.env.PAYSTACK_SECRET_KEY || "";

  if (!secret) {
    return NextResponse.json({ error: "Paystack not configured" }, { status: 503 });
  }

  const expected = crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
  if (
    !signature ||
    !crypto.timingSafeEqual(
      Buffer.from(signature, "utf8"),
      Buffer.from(expected, "utf8")
    )
  ) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let event: PaystackEvent;
  try {
    event = JSON.parse(rawBody) as PaystackEvent;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const orgId = event.data?.metadata?.org_id || null;
  const planCode = event.data?.metadata?.plan_code || null;
  const cycle = event.data?.metadata?.cycle || "monthly";
  const reference = event.data?.reference || null;
  const amount = event.data?.amount ?? null;
  const currency = event.data?.currency ?? null;

  // Append-only audit log first - any failures below still leave a trace.
  const { data: logged } = await getSupabaseAdmin()
    .from("invoice_events")
    .insert({
      org_id: orgId,
      provider: "paystack",
      event_type: event.event,
      provider_reference: reference,
      amount_minor: amount,
      currency,
      payload: event,
      processed: false,
    })
    .select("id")
    .single();

  // Only act on successful charges that we recognise as a Tilify subscription.
  if (event.event === "charge.success" && event.data.status === "success" && orgId && planCode) {
    const periodEnd = new Date();
    if (cycle === "annual") {
      periodEnd.setFullYear(periodEnd.getFullYear() + 1);
    } else {
      periodEnd.setMonth(periodEnd.getMonth() + 1);
    }

    const { error: updateErr } = await getSupabaseAdmin()
      .from("organizations")
      .update({
        subscription_plan: planCode,
        subscription_status: "active",
        billing_provider: "paystack",
        billing_currency: currency,
        last_charge_minor: amount,
        last_charge_at: new Date().toISOString(),
        current_period_end: periodEnd.toISOString(),
      })
      .eq("id", orgId);

    if (updateErr) {
      if (logged?.id) {
        await getSupabaseAdmin()
          .from("invoice_events")
          .update({ processing_error: updateErr.message })
          .eq("id", logged.id);
      }
      // Still 200 so Paystack does not retry forever on a transient DB issue.
      return NextResponse.json({ received: true, error: updateErr.message });
    }

    if (logged?.id) {
      await getSupabaseAdmin()
        .from("invoice_events")
        .update({ processed: true })
        .eq("id", logged.id);
    }
  }

  // Subscription cancellation / disable
  if (event.event === "subscription.disable" && orgId) {
    await getSupabaseAdmin()
      .from("organizations")
      .update({ subscription_status: "cancelled" })
      .eq("id", orgId);
  }

  return NextResponse.json({ received: true });
}
