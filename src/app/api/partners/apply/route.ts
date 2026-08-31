// POST /api/partners/apply — public, no auth.
//
// A would-be Tilify partner submits their details. This creates a PENDING
// row in partner_applications; it does not create a partner. A platform
// admin reviews the queue in /admin/partners and approves or rejects.
//
// Uses the service-role client (there is no public INSERT policy on the
// table). Light anti-abuse: a honeypot field and one-open-application-per-
// email (enforced by a partial unique index).

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

interface ApplyBody {
  name?: string;
  email?: string;
  phone?: string;
  requested_code?: string;
  pitch?: string;
  company?: string; // honeypot — real submitters never fill this
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: Request) {
  let body: ApplyBody;
  try {
    body = (await req.json()) as ApplyBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Honeypot: pretend success, write nothing.
  if (body.company && body.company.trim() !== "") {
    return NextResponse.json({ ok: true });
  }

  const name = (body.name || "").trim();
  const email = (body.email || "").trim().toLowerCase();
  const phone = body.phone?.trim() || null;
  const pitch = body.pitch?.trim() || null;
  const requestedCode = (body.requested_code || "").trim().toUpperCase() || null;

  if (!name || name.length < 2) {
    return NextResponse.json({ error: "Please enter your full name." }, { status: 400 });
  }
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Please enter a valid email address." }, { status: 400 });
  }
  if (requestedCode && !/^[A-Z0-9_-]{3,32}$/.test(requestedCode)) {
    return NextResponse.json(
      { error: "Requested code must be 3–32 characters: letters, numbers, hyphen, underscore." },
      { status: 400 }
    );
  }

  const admin = getSupabaseAdmin();
  const { error } = await admin.from("partner_applications").insert({
    name,
    email,
    phone,
    requested_code: requestedCode,
    pitch,
  });

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json(
        { error: "You already have an application pending review. We'll be in touch soon." },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: "Could not submit your application. Please try again." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
