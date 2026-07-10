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
