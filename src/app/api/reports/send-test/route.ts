// POST /api/reports/send-test
// Body: { subscription_id: string }
//
// Builds yesterday's daily summary for the calling user's org and sends
// it to the recipient on the given subscription. Auth via the Supabase
// access token. Useful from the Settings UI to confirm the email
// pipeline works before relying on the morning cron.

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { buildDailySummary, renderDailyEmail, buildDailyItemsCsv } from "@/lib/daily-report";
import { z } from "zod";

export const runtime = "nodejs";

const SendTestSchema = z.object({
  subscription_id: z.string().uuid(),
});

interface Attachment {
  filename: string;
  content: string; // base64 encoded
}

async function sendViaResend(toEmail: string, subject: string, html: string, text: string, attachments?: Attachment[]): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  const fromAddress = process.env.RESEND_FROM_ADDRESS || "Tilify <reports@mkglobal.co.za>";
  if (!apiKey) return { ok: false, error: "RESEND_API_KEY not configured on the server" };

  const payload: Record<string, unknown> = {
    from: fromAddress,
    to: [toEmail],
    subject,
    html,
    text,
  };
  if (attachments && attachments.length > 0) {
    payload.attachments = attachments;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.text();
    return { ok: false, error: `Resend ${res.status}: ${err.slice(0, 240)}` };
  }
  return { ok: true };
}

export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = SendTestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const body = parsed.data;

  try {
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

  const admin = getSupabaseAdmin();

  // Look up the subscription and confirm the user belongs to that org.
  const { data: sub } = await admin
    .from("report_subscriptions")
    .select("id, org_id, email")
    .eq("id", body.subscription_id)
    .maybeSingle();
  if (!sub) {
    return NextResponse.json({ error: "Subscription not found" }, { status: 404 });
  }
  const { data: member } = await admin
    .from("org_members")
    .select("role")
    .eq("user_id", userData.user.id)
    .eq("org_id", sub.org_id)
    .maybeSingle();
  if (!member) {
    return NextResponse.json({ error: "Not a member of that organisation" }, { status: 403 });
  }

  const summary = await buildDailySummary(sub.org_id);
  if (!summary) {
    return NextResponse.json({
      error: "No data to report for yesterday. Make at least one sale, expense, or adjustment first, then send the test."
    }, { status: 400 });
  }

  const { subject, html, text } = renderDailyEmail(summary);

  // Build CSV attachment of every line item sold yesterday.
  const itemsCsv = await buildDailyItemsCsv(sub.org_id);
  const attachments: Attachment[] = itemsCsv
    ? [{
        filename: `sales-${itemsCsv.date}.csv`,
        content: Buffer.from(itemsCsv.csv, "utf-8").toString("base64"),
      }]
    : [];

  const send = await sendViaResend(sub.email, `[TEST] ${subject}`, html, text, attachments);

  if (!send.ok) {
    await admin
      .from("report_subscriptions")
      .update({ last_error: send.error })
      .eq("id", sub.id);
    return NextResponse.json({ error: send.error }, { status: 502 });
  }

  await admin
    .from("report_subscriptions")
    .update({ last_sent_at: new Date().toISOString(), last_error: null })
    .eq("id", sub.id);

  return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    console.error("[reports/send-test]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
