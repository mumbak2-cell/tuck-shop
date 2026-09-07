// POST /api/leads/leak-calculator
// Body: { name, whatsapp, monthlyStockValue, shrinkPct }
//
// Public endpoint (no auth) behind the Facebook "Inventory Leak Calculator"
// ad landing page. Recomputes the estimate server-side (never trusts a
// client-sent total) and emails the lead to the team via Resend, following
// the same send pattern as /api/team and /api/reports/send-test.

import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { z } from "zod";

export const runtime = "nodejs";

const NOTIFY_EMAIL = "info@mkglobal.co.za";

const LeadSchema = z.object({
  name: z.string().trim().min(1).max(100),
  // Normalized to international format (+<countrycode><number>) client-side
  // via lib/currency's toInternationalPhone before it ever reaches here.
  whatsapp: z.string().trim().regex(/^\+\d{7,15}$/, "Invalid WhatsApp number"),
  country: z.string().trim().min(1).max(100),
  monthlyStockValue: z.number().positive().max(1_000_000_000),
  shrinkPct: z.number().min(0).max(100),
});

async function sendViaResend(toEmail: string, subject: string, html: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  const fromAddress = process.env.RESEND_FROM_ADDRESS || "Tilify <reports@mkglobal.co.za>";
  if (!apiKey) return { ok: false, error: "RESEND_API_KEY not configured on the server" };

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: fromAddress, to: [toEmail], subject, html, text }),
  });
  if (!res.ok) {
    const err = await res.text();
    return { ok: false, error: `Resend ${res.status}: ${err.slice(0, 240)}` };
  }
  return { ok: true };
}

export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rl = await rateLimit(`leak-calc:${ip}`, { max: 5, windowMs: 60_000 });
  if (!rl.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const parsed = LeadSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const { name, whatsapp, country, monthlyStockValue, shrinkPct } = parsed.data;

  const monthlyLoss = monthlyStockValue * (shrinkPct / 100);
  const annualLoss = monthlyLoss * 12;

  const subject = `Leak calculator lead: ${name}`;
  const text = `New lead from the Inventory Leak Calculator page.

Name: ${name}
WhatsApp: ${whatsapp}
Country: ${country}
Monthly stock value: ${monthlyStockValue}
Shrinkage rate: ${shrinkPct}%
Estimated monthly loss: ${monthlyLoss.toFixed(2)}
Estimated annual loss: ${annualLoss.toFixed(2)}`;
  const html = `<p>New lead from the Inventory Leak Calculator page.</p>
<p><strong>Name:</strong> ${name}<br>
<strong>WhatsApp:</strong> ${whatsapp}<br>
<strong>Country:</strong> ${country}<br>
<strong>Monthly stock value:</strong> ${monthlyStockValue}<br>
<strong>Shrinkage rate:</strong> ${shrinkPct}%<br>
<strong>Estimated monthly loss:</strong> ${monthlyLoss.toFixed(2)}<br>
<strong>Estimated annual loss:</strong> ${annualLoss.toFixed(2)}</p>`;

  const send = await sendViaResend(NOTIFY_EMAIL, subject, html, text);
  if (!send.ok) {
    console.error("[leads/leak-calculator]", send.error);
    return NextResponse.json({ error: "Could not send your details. Please try again." }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
