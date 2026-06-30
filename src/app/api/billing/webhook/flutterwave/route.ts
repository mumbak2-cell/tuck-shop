// POST /api/billing/webhook/flutterwave
// Receives Flutterwave charge.completed events.
//
// Flutterwave uses a simple shared-hash header (`verif-hash`) — we check
// it against FLUTTERWAVE_WEBHOOK_HASH. Any mismatch is rejected before
// we trust any payload field.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

interface FlutterwaveEvent {
  event: string;
  data: {
    tx_ref?: string;
    status?: string;
    amount?: number;
    currency?: string;
    customer?: { email?: string };
    meta?: {
      org_id?: string;
      plan_code?: string;
      cycle?: "monthly" | "annual";
    };
  };
}

export async function POST(req: Request) {
  const expectedHash = process.env.FLUTTERWAVE_WEBHOOK_HASH || "";
  const signature = req.headers.get("verif-hash") || "";

  if (!expectedHash) {
    return NextResponse.json({ error: "Flutterwave webhook hash not configured" }, { status: 503 });
  }
  if (signature !== expectedHash) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let event: FlutterwaveEvent;
  try {
    event = (await req.json()) as FlutterwaveEvent;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const orgId = event.data?.meta?.org_id || null;
  const planCode = event.data?.meta?.plan_code || null;
  const cycle = event.data?.meta?.cycle || "monthly";
  const reference = event.data?.tx_ref || null;
  const amount = event.data?.amount != null ? Math.round(event.data.amount * 100) : null;
  const currency = event.data?.currency ?? null;

  const { data: logged } = await getSupabaseAdmin()
    .from("invoice_events")
    .insert({
      org_id: orgId,
      provider: "flutterwave",
      event_type: event.event,
      provider_reference: reference,
      amount_minor: amount,
      currency,
      payload: event,
      processed: false,
    })
    .select("id")
    .single();

  if (event.event === "charge.completed" && event.data.status === "successful" && orgId && planCode) {
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
        billing_provider: "flutterwave",
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
      return NextResponse.json({ received: true, error: updateErr.message });
    }

    if (logged?.id) {
      await getSupabaseAdmin()
        .from("invoice_events")
        .update({ processed: true })
        .eq("id", logged.id);
    }
  }

  return NextResponse.json({ received: true });
}
