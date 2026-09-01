// GET /api/cron/trial-outreach
//
// Triggered by Vercel Cron once a day (see vercel.json). Finds every
// trialing org whose trial_ends_at falls within the next 24h and hasn't
// been emailed yet, sends the feedback/Facebook-rating/partner-program
// email to the org's owner, and stamps trial_outreach_sent_at so the
// next run doesn't resend.
//
// Vercel Cron sends an Authorization header containing CRON_SECRET so
// the route refuses requests that did not come from the cron worker.
// For local testing, pass the header manually:
//   curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/trial-outreach

import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";
export const maxDuration = 60;

const BCC = "mumba@mkglobal.co.za";
const FACEBOOK_URL = "https://www.facebook.com/TilifyPOS/";
const PARTNER_URL = "https://tilify.mkglobal.co.za/partner/apply";

interface OrgRow {
  id: string;
  name: string;
  trial_ends_at: string;
}

function emailBody(name: string): string {
  return `Hi ${name} team,

Your Tilify trial wraps up in the next day or so — hope it's been useful for the shop.

We'd love to hear how it's gone: what's worked well, what's been annoying, and any features you wish the app had. Just reply to this email — we read every one.

If you've enjoyed using Tilify, a quick rating on our Facebook page would mean a lot to us:
${FACEBOOK_URL}

We also run a Partner Program for people who want to earn by referring other shops to Tilify. If that sounds interesting:
${PARTNER_URL}

Thanks for trying Tilify.

— The Tilify Team
support@mkglobal.co.za`;
}

async function sendViaResend(toEmail: string, name: string): Promise<{ ok: boolean; error?: string }> {
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
      subject: "How's Tilify working for you so far?",
      text: emailBody(name),
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    return { ok: false, error: `Resend ${res.status}: ${err.slice(0, 200)}` };
  }
  return { ok: true };
}

export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization") || "";

  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }
  const headerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const a = Buffer.from(headerToken);
  const b = Buffer.from(cronSecret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabaseAdmin();

  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const { data: orgs, error: orgsErr } = await supabase
    .from("organizations")
    .select("id, name, trial_ends_at")
    .eq("subscription_status", "trialing")
    .is("trial_outreach_sent_at", null)
    .gt("trial_ends_at", now.toISOString())
    .lte("trial_ends_at", in24h.toISOString());

  if (orgsErr) {
    return NextResponse.json({ error: orgsErr.message }, { status: 500 });
  }

  const targets = (orgs as OrgRow[]) || [];
  const results: Array<{ org_id: string; name: string; status: string; error?: string }> = [];

  // Owner emails come from auth.users, not a mirrored table, so fetch the
  // full user list once (small tenant base) rather than one lookup per org.
  const { data: userList, error: userErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (userErr) {
    return NextResponse.json({ error: userErr.message }, { status: 500 });
  }
  const usersById = new Map(userList.users.map((u) => [u.id, u.email]));

  for (const org of targets) {
    try {
      const { data: members, error: memErr } = await supabase
        .from("org_members")
        .select("user_id")
        .eq("org_id", org.id)
        .eq("role", "owner")
        .limit(1);
      if (memErr) throw new Error(memErr.message);

      const ownerEmail = members?.[0]?.user_id ? usersById.get(members[0].user_id) : undefined;
      if (!ownerEmail) {
        results.push({ org_id: org.id, name: org.name, status: "skipped_no_owner_email" });
        continue;
      }

      const sendResult = await sendViaResend(ownerEmail, org.name);
      if (!sendResult.ok) {
        results.push({ org_id: org.id, name: org.name, status: "failed", error: sendResult.error });
        continue;
      }

      await supabase
        .from("organizations")
        .update({ trial_outreach_sent_at: new Date().toISOString() })
        .eq("id", org.id);
      results.push({ org_id: org.id, name: org.name, status: "sent" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ org_id: org.id, name: org.name, status: "error", error: message });
    }
  }

  return NextResponse.json({
    ran_at: now.toISOString(),
    total_targets: targets.length,
    results,
  });
}
