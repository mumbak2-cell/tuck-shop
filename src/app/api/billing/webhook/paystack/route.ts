// POST /api/billing/webhook/paystack
// Receives Paystack charge and subscription events.
//
// Verifies the HMAC SHA512 signature against PAYSTACK_SECRET_KEY before
// trusting any field, logs every delivery into invoice_events (idempotently),
// then reconciles the org's subscription state.
//
// Handles both the first checkout (a charge.success carrying our metadata) and
// automatic recurring renewals. Renewal events do NOT carry the metadata we set
// on the first transaction, so the org is resolved by the Paystack customer /
// subscription code we store on first charge, and the plan/cycle is derived
// from the Plan on the event (data.plan) rather than metadata.

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { PlanCode, BillingCycle } from "@/lib/plans";
import { resolveByPaystackCode, cycleFromInterval, addCycle } from "@/lib/paystack-plans";

export const runtime = "nodejs";

type Admin = ReturnType<typeof getSupabaseAdmin>;

interface PaystackEvent {
  event: string;
  data: {
    reference?: string;
    status?: string;
    amount?: number;
    currency?: string;
    customer?: { email?: string; customer_code?: string };
    plan?: { plan_code?: string; interval?: string };
    subscription_code?: string;
    subscription?: { subscription_code?: string };
    metadata?: {
      org_id?: string;
      plan_code?: string;
      cycle?: BillingCycle;
    };
  };
}

/**
 * Find the org an event belongs to. First checkout carries metadata.org_id;
 * recurring renewals don't, so fall back to the Paystack customer code (stored
 * on first charge) and then the subscription code.
 */
async function resolveOrgId(admin: Admin, d: PaystackEvent["data"]): Promise<string | null> {
  if (d.metadata?.org_id) return d.metadata.org_id;

  const customerCode = d.customer?.customer_code;
  if (customerCode) {
    const { data } = await admin
      .from("organizations")
      .select("id")
      .eq("billing_customer_id", customerCode)
      .maybeSingle();
    if (data) return data.id;
  }

  const subCode = d.subscription_code || d.subscription?.subscription_code;
  if (subCode) {
    const { data } = await admin
      .from("organizations")
      .select("id")
      .eq("billing_subscription_id", subCode)
      .maybeSingle();
    if (data) return data.id;
  }

  return null;
}

export async function POST(req: Request) {
  const rawBody = await req.text();
  const signature = req.headers.get("x-paystack-signature") || "";
  const secret = process.env.PAYSTACK_SECRET_KEY || "";

  if (!secret) {
    return NextResponse.json({ error: "Paystack not configured" }, { status: 503 });
  }

  const expected = crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
  // Compare as fixed-length buffers. crypto.timingSafeEqual throws a RangeError
  // when the inputs differ in length, so a malformed (wrong-length) signature
  // must be rejected with the length check *before* the comparison — otherwise
  // it crashes the handler with a 500 instead of a clean 401.
  const signatureBuf = Buffer.from(signature, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (
    signatureBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(signatureBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let event: PaystackEvent;
  try {
    event = JSON.parse(rawBody) as PaystackEvent;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  const d = event.data;
  const reference = d?.reference || null;
  const orgId = await resolveOrgId(admin, d);

  // Append-only audit log first — any failures below still leave a trace.
  //
  // Idempotency is enforced by the partial UNIQUE index on
  // (provider, provider_reference) WHERE provider_reference IS NOT NULL. We use
  // a plain INSERT rather than upsert(onConflict): PostgREST's onConflict
  // cannot target a *partial* index — it can't emit the WHERE predicate — so an
  // upsert raised 42P10 and, with the error swallowed, silently no-op'd every
  // delivery. Catching the unique-violation (23505) is the idempotency guard
  // instead. Events without a reference are not covered by the partial index,
  // so they always insert (always logged).
  const { data: logged, error: logErr } = await admin
    .from("invoice_events")
    .insert({
      org_id: orgId,
      provider: "paystack",
      event_type: event.event,
      provider_reference: reference,
      amount_minor: d?.amount ?? null,
      currency: d?.currency ?? null,
      payload: event,
      processed: false,
    })
    .select("id")
    .single();

  if (logErr) {
    // Duplicate delivery of an event we already recorded — ack and stop.
    if (logErr.code === "23505") {
      return NextResponse.json({ received: true, duplicate: true });
    }
    // Any other failure means the event could not be recorded. Fail loudly with
    // a 500 so Paystack retries, rather than reconciling with no audit trail —
    // a silent swallow here is exactly what hid the original defect.
    console.error("[webhook/paystack] failed to log invoice_event", logErr);
    return NextResponse.json({ error: "Could not record event" }, { status: 500 });
  }

  const eventId = logged?.id as string | undefined;
  const fail = async (message: string) => {
    if (eventId) await admin.from("invoice_events").update({ processing_error: message }).eq("id", eventId);
    // Still 200 so Paystack does not retry forever on a transient DB issue.
    return NextResponse.json({ received: true, error: message });
  };

  let handled = false;

  if (event.event === "charge.success" && d.status === "success" && orgId) {
    // Determine tier + cycle. First checkout carries them in metadata; a renewal
    // doesn't, so derive them from the Plan on the event, then from its interval.
    let planCode: string | undefined = d.metadata?.plan_code;
    let cycle: BillingCycle | undefined = d.metadata?.cycle;
    if ((!planCode || !cycle) && d.plan?.plan_code) {
      const resolved = resolveByPaystackCode(d.plan.plan_code);
      if (resolved) {
        planCode = planCode ?? resolved.plan;
        cycle = cycle ?? resolved.cycle;
      }
    }
    if (!cycle) cycle = cycleFromInterval(d.plan?.interval) ?? "monthly";

    const update: Record<string, unknown> = {
      subscription_status: "active",
      billing_provider: "paystack",
      billing_currency: d.currency ?? null,
      last_charge_minor: d.amount ?? null,
      last_charge_at: new Date().toISOString(),
      current_period_end: addCycle(new Date(), cycle).toISOString(),
    };
    // Only set the plan when we know it — never overwrite a renewal's plan with null.
    if (planCode) update.subscription_plan = planCode as PlanCode;
    // Capture the customer code so future renewals (which lack metadata) resolve.
    if (d.customer?.customer_code) update.billing_customer_id = d.customer.customer_code;

    const { error } = await admin.from("organizations").update(update).eq("id", orgId);
    if (error) return fail(error.message);
    handled = true;
  } else if (event.event === "subscription.create" && orgId) {
    // Store the subscription + customer codes so recurring renewals can be tied
    // back to this org.
    const update: Record<string, unknown> = {};
    const subCode = d.subscription_code || d.subscription?.subscription_code;
    if (subCode) update.billing_subscription_id = subCode;
    if (d.customer?.customer_code) update.billing_customer_id = d.customer.customer_code;
    if (Object.keys(update).length > 0) {
      const { error } = await admin.from("organizations").update(update).eq("id", orgId);
      if (error) return fail(error.message);
    }
    handled = true;
  } else if ((event.event === "invoice.payment_failed" || event.event === "charge.failed") && orgId) {
    // A renewal charge (or one-time charge) failed — mark past_due so the UI can
    // warn the operator and prompt them to update their card.
    const { error } = await admin
      .from("organizations")
      .update({ subscription_status: "past_due" })
      .eq("id", orgId);
    if (error) return fail(error.message);
    handled = true;
  } else if (event.event === "subscription.disable" && orgId) {
    // Subscription cancelled or ended.
    const { error } = await admin
      .from("organizations")
      .update({ subscription_status: "cancelled" })
      .eq("id", orgId);
    if (error) return fail(error.message);
    handled = true;
  } else if (event.event === "subscription.not_renew") {
    // Auto-renew was turned off; the org keeps access until current_period_end,
    // so there is no state change here. Logged for the audit trail.
    handled = true;
  }

  if (handled && eventId) {
    await admin.from("invoice_events").update({ processed: true }).eq("id", eventId);
  }

  return NextResponse.json({ received: true });
}
