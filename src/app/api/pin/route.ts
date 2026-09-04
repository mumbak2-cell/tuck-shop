// PATCH /api/pin — self-service PIN change. Any signed-in org member may
// change their own PIN; no owner check (contrast with /api/team/[id], where
// an owner sets/changes someone ELSE's PIN).
//
// Auth pattern mirrors src/lib/org-owner.ts: validate the caller's JWT with
// an anon-key client (not the service-role client), then look up their own
// org_members row with the admin client to write the PIN.

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

export async function PATCH(req: Request) {
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

  let body: { newPin?: string };
  try {
    body = (await req.json()) as { newPin?: string };
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const newPin = (body.newPin || "").trim();
  if (!newPin) {
    return NextResponse.json({ error: "PIN is required" }, { status: 400 });
  }
  if (!/^\d{4,6}$/.test(newPin)) {
    return NextResponse.json({ error: "PIN must be 4–6 digits" }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  const { data: member, error: memErr } = await admin
    .from("org_members")
    .select("id")
    .eq("user_id", userData.user.id)
    .maybeSingle();
  if (memErr || !member) {
    return NextResponse.json({ error: "You are not a member of any shop" }, { status: 404 });
  }

  const { error } = await admin.rpc("set_member_pin", { p_member_id: member.id, p_pin: newPin });

  if (error) {
    if (error.code === "P0409") {
      return NextResponse.json({ error: "That PIN is already used by another team member" }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ updated: true });
}
