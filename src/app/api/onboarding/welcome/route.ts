// POST /api/onboarding/welcome
//
// Sends the one-time welcome email right after a shop finishes signup.
// Called by the signup page immediately after create_organization_for_user
// succeeds. Auth is verified server-side via the Supabase access token in
// the Authorization header; the org and owner email are looked up from
// that, not trusted from the request body, so this can't be used to spam
// an arbitrary address.
//
// Idempotent: stamps organizations.welcome_email_sent_at (migration 116) so
// a retried call (e.g. the signup page's fetch failing and the user
// reloading) doesn't resend.

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

const BCC = "mumba@mkglobal.co.za";

// ZRA (Zambia Revenue Authority) e-invoicing only applies to Zambian shops.
// Currency is a reasonable proxy for country here: ZMW is Zambia-only among
// the SADC_CURRENCIES choices offered at signup (src/lib/currency.ts).
const ZRA_PARAGRAPH = `

ZRA compliance is available whenever you need it. If your business needs to report sales to Zambia Revenue Authority, Tilify can submit every sale straight to ZRA through your shop's VSDC and hand you back an official receipt number, with no separate fiscal device and no manual filing. It's off by default; turn it on in Settings when you're ready for it.`;

function emailBody(shopName: string, currency: string | null): string {
  const zraSection = currency === "ZMW" ? ZRA_PARAGRAPH : "";
  return `Hi ${shopName} team,

Welcome to Tilify. Your 14-day trial just started.

Tilify is a point-of-sale and inventory system built for shops like yours: ring up sales, track stock, manage staff and locations, and see your real profit, not just revenue, without needing a card machine or a bookkeeper on payroll. Everything's designed to work the way a shop actually runs, not how a generic retail app assumes it should.

A couple of things worth knowing as you get started:

You're not just getting a till. You're getting a warehouse. Purchase orders, stock transfers between locations, lot/expiry tracking, landed cost: the same tools bigger retailers pay a lot more for. If you're running more than one location, this is where Tilify starts saving real hours.${zraSection}

A few quick wins to try this week:
- Ring up your first sale
- Add your suppliers and raise your first purchase order
- If customers buy on credit, set them up in the Credit Ledger. Statements can go out over WhatsApp.

Questions, or something feels off? Just reply, we read every one.

The Tilify Team
support@mkglobal.co.za`;
}

async function sendViaResend(
  toEmail: string,
  shopName: string,
  currency: string | null
): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "RESEND_API_KEY not configured" };
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Tilify Team <support@mkglobal.co.za>",
      to: toEmail,
      bcc: BCC,
      subject: "Welcome to Tilify",
      text: emailBody(shopName, currency),
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    return { ok: false, error: `Resend ${res.status}: ${err.slice(0, 200)}` };
  }
  return { ok: true };
}

export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization") || "";
  const accessToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!accessToken) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const userClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${accessToken}` } } }
  );
  const { data: userData, error: userErr } = await userClient.auth.getUser(accessToken);
  if (userErr || !userData.user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const admin = getSupabaseAdmin();

  // A user has exactly one org at signup time — find it via org_members.
  const { data: membership, error: memErr } = await admin
    .from("org_members")
    .select("org_id, organizations(id, name, welcome_email_sent_at)")
    .eq("user_id", userData.user.id)
    .limit(1)
    .maybeSingle();

  if (memErr || !membership) {
    return NextResponse.json({ error: "No organization found for this user" }, { status: 404 });
  }

  const org = membership.organizations as unknown as
    | { id: string; name: string; welcome_email_sent_at: string | null }
    | null;
  if (!org) {
    return NextResponse.json({ error: "No organization found for this user" }, { status: 404 });
  }

  if (org.welcome_email_sent_at) {
    return NextResponse.json({ ok: true, status: "already_sent" });
  }

  const ownerEmail = userData.user.email;
  if (!ownerEmail) {
    return NextResponse.json({ error: "User has no email on record" }, { status: 400 });
  }

  // Currency is set at signup (see create_organization_for_user) and lives in
  // app_settings, not on the organizations row itself.
  const { data: currencySetting } = await admin
    .from("app_settings")
    .select("value")
    .eq("org_id", org.id)
    .eq("key", "currency")
    .maybeSingle();
  const currency = (currencySetting?.value as string | undefined) ?? null;

  const sendResult = await sendViaResend(ownerEmail, org.name, currency);
  if (!sendResult.ok) {
    return NextResponse.json({ error: sendResult.error }, { status: 502 });
  }

  await admin
    .from("organizations")
    .update({ welcome_email_sent_at: new Date().toISOString() })
    .eq("id", org.id);

  return NextResponse.json({ ok: true, status: "sent" });
}
