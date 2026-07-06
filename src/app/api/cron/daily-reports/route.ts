// GET /api/cron/daily-reports
//
// Triggered by Vercel Cron once a day (see vercel.json). Reads every
// enabled report_subscription, builds yesterday's summary for each
// org, renders the email, and sends via Resend.
//
// Vercel Cron sends an Authorization header containing CRON_SECRET so
// the route refuses requests that did not come from the cron worker.
// For local testing, pass the header manually:
//   curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/daily-reports

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { buildDailySummary, renderDailyEmail, buildDailyItemsCsv } from "@/lib/daily-report";

interface Attachment {
  filename: string;
  content: string; // base64 encoded
}

export const runtime = "nodejs";
// 60s headroom for sending many emails.
export const maxDuration = 60;

interface SubscriptionRow {
  id: string;
  org_id: string;
  email: string;
  send_hour_local: number;
}

async function sendViaResend(toEmail: string, subject: string, html: string, text: string, attachments?: Attachment[]): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  const fromAddress = process.env.RESEND_FROM_ADDRESS || "Tilify <reports@mkglobal.co.za>";
  if (!apiKey) {
    return { ok: false, error: "RESEND_API_KEY not configured" };
  }

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
    return { ok: false, error: `Resend ${res.status}: ${err.slice(0, 200)}` };
  }
  return { ok: true };
}

export async function GET(req: Request) {
  // Auth check: Vercel Cron sets Authorization: Bearer <CRON_SECRET>.
  // Query-string fallback removed (L5) — secrets in URLs leak in server logs.
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization") || "";

  if (cronSecret) {
    const headerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (headerToken !== cronSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const supabase = getSupabaseAdmin();

  // Fetch every enabled subscription. v1 ignores send_hour_local and emails
  // all of them whenever cron runs - v2 filters by local hour.
  const { data: subs, error: subsErr } = await supabase
    .from("report_subscriptions")
    .select("id, org_id, email, send_hour_local")
    .eq("enabled", true);

  if (subsErr) {
    return NextResponse.json({ error: subsErr.message }, { status: 500 });
  }

  const subscriptions = (subs as SubscriptionRow[]) || [];

  // Process each subscription. Use a concurrency limiter (5 at a time) to
  // avoid hammering Supabase/Resend while still finishing faster than serial.
  const CONCURRENCY = 5;
  const results: Array<{ org_id: string; email: string; status: string; error?: string }> = [];

  async function processSub(sub: SubscriptionRow) {
    try {
      const summary = await buildDailySummary(sub.org_id);
      if (!summary) {
        return { org_id: sub.org_id, email: sub.email, status: "skipped_no_data" };
      }

      const { subject, html, text } = renderDailyEmail(summary);

      // Build CSV attachment of every line item for the day.
      const itemsCsv = await buildDailyItemsCsv(sub.org_id);
      const attachments: Attachment[] = itemsCsv
        ? [{
            filename: `sales-${itemsCsv.date}.csv`,
            content: Buffer.from(itemsCsv.csv, "utf-8").toString("base64"),
          }]
        : [];

      const sendResult = await sendViaResend(sub.email, subject, html, text, attachments);

      if (!sendResult.ok) {
        await supabase
          .from("report_subscriptions")
          .update({ last_error: sendResult.error })
          .eq("id", sub.id);
        return { org_id: sub.org_id, email: sub.email, status: "failed", error: sendResult.error };
      }

      await supabase
        .from("report_subscriptions")
        .update({ last_sent_at: new Date().toISOString(), last_error: null })
        .eq("id", sub.id);
      return { org_id: sub.org_id, email: sub.email, status: "sent" };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await supabase
        .from("report_subscriptions")
        .update({ last_error: message })
        .eq("id", sub.id);
      return { org_id: sub.org_id, email: sub.email, status: "error", error: message };
    }
  }

  // Process in batches of CONCURRENCY
  for (let i = 0; i < subscriptions.length; i += CONCURRENCY) {
    const batch = subscriptions.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(batch.map(processSub));
    for (const r of batchResults) {
      results.push(
        r.status === "fulfilled"
          ? r.value
          : { org_id: "unknown", email: "unknown", status: "error", error: String(r.reason) }
      );
    }
  }

  return NextResponse.json({
    ran_at: new Date().toISOString(),
    total_subscriptions: subscriptions.length,
    results,
  });
}
