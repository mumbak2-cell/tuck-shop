// PATCH  /api/team/[id] — change which branch a cashier is assigned to.
// DELETE /api/team/[id] — remove a member from the owner's org.
// [id] is the org_members row id.
//
// Owner only. Removing a member drops their org_members row, so they lose
// access to this shop's data at the RLS layer on their next request. Their
// login is left intact — they may belong to other orgs, and deleting the
// auth user is not ours to do from here.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireOrgOwner } from "@/lib/org-owner";

export const runtime = "nodejs";

/**
 * Reassign a cashier to a different branch. A cashier with no branch has no
 * accessible locations at all (current_user_location_ids matches on
 * assigned_location_id), which silently breaks their POS — so this is the
 * owner's way to correct it without deleting and re-adding the person.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOrgOwner(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  let body: { locationId?: string };
  try {
    body = (await req.json()) as { locationId?: string };
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const admin = getSupabaseAdmin();

  const { data: member } = await admin
    .from("org_members")
    .select("id, role, org_id")
    .eq("id", id)
    .maybeSingle();

  if (!member || member.org_id !== auth.orgId) {
    return NextResponse.json({ error: "Member not found on your team" }, { status: 404 });
  }
  if (member.role !== "member") {
    return NextResponse.json(
      { error: "Only cashiers are tied to a branch — owners and managers see every branch." },
      { status: 409 }
    );
  }

  const locationId = (body.locationId || "").trim();
  if (!locationId) {
    return NextResponse.json({ error: "Pick a branch for this cashier" }, { status: 400 });
  }
  const { data: loc } = await admin
    .from("locations")
    .select("id")
    .eq("org_id", auth.orgId!)
    .eq("id", locationId)
    .maybeSingle();
  if (!loc) {
    return NextResponse.json({ error: "That location does not belong to your shop" }, { status: 400 });
  }

  const { error } = await admin
    .from("org_members")
    .update({ assigned_location_id: locationId })
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ updated: true });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOrgOwner(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  const admin = getSupabaseAdmin();

  // Fetch the target and confirm it belongs to the caller's org before touching it.
  const { data: member } = await admin
    .from("org_members")
    .select("id, user_id, role, org_id")
    .eq("id", id)
    .maybeSingle();

  if (!member || member.org_id !== auth.orgId) {
    return NextResponse.json({ error: "Member not found on your team" }, { status: 404 });
  }
  if (member.role === "owner") {
    return NextResponse.json({ error: "The owner cannot be removed" }, { status: 409 });
  }
  if (member.user_id === auth.userId) {
    return NextResponse.json({ error: "You cannot remove yourself" }, { status: 409 });
  }

  const { error } = await admin.from("org_members").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ removed: true });
}
