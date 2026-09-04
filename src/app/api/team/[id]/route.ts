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
import { requireOrgOwner, requireOrgManager } from "@/lib/org-owner";

export const runtime = "nodejs";

// Mirrors the rule in POST /api/team: a manager sees every branch, so
// promoting one only makes sense once the shop actually has more than one.
const MANAGER_MIN_LOCATIONS = 2;

async function locationCount(admin: ReturnType<typeof getSupabaseAdmin>, orgId: string): Promise<number> {
  const { count } = await admin
    .from("locations")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId);
  return count ?? 0;
}

/**
 * Reassign a cashier to a different branch, and/or (owner only) grant or
 * withdraw a manager's admin-function permissions (migration 077), and/or
 * (owner only) change someone's role between Cashier and Manager. A cashier
 * with no branch has no accessible locations at all
 * (current_user_location_ids matches on assigned_location_id), which
 * silently breaks their POS — so branch reassignment is the owner's way to
 * correct it without deleting and re-adding the person.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let body: { locationId?: string; permissions?: Record<string, boolean>; role?: string; pin?: string | null; displayName?: string };
  try {
    body = (await req.json()) as { locationId?: string; permissions?: Record<string, boolean>; role?: string; pin?: string | null; displayName?: string };
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  // Editing permissions, role, or PIN is an owner-only action (it decides
  // what someone may do, or who they can log in as); reassigning a cashier's
  // branch stays open to managers too — day-to-day floor management.
  const editingPermissions = body.permissions !== undefined;
  const editingRole = body.role !== undefined;
  const editingPin = body.pin !== undefined;
  const auth = editingPermissions || editingRole || editingPin ? await requireOrgOwner(req) : await requireOrgManager(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  const admin = getSupabaseAdmin();

  const { data: member } = await admin
    .from("org_members")
    .select("id, role, org_id")
    .eq("id", id)
    .maybeSingle();

  if (!member || member.org_id !== auth.orgId) {
    return NextResponse.json({ error: "Member not found on your team" }, { status: 404 });
  }

  const update: {
    assigned_location_id?: string | null;
    permissions?: Record<string, boolean>;
    role?: "admin" | "member";
    display_name?: string | null;
  } = {};

  if (editingRole) {
    if (member.role === "owner") {
      return NextResponse.json({ error: "The owner's role cannot be changed" }, { status: 409 });
    }
    const desiredRole: "admin" | "member" = body.role === "admin" ? "admin" : "member";
    if (desiredRole !== member.role) {
      if (desiredRole === "admin") {
        const locations = await locationCount(admin, auth.orgId!);
        if (locations < MANAGER_MIN_LOCATIONS) {
          return NextResponse.json(
            { error: "Managers can be added once your shop has more than one location." },
            { status: 403 }
          );
        }
        // A manager is never location-locked — they see every branch.
        update.assigned_location_id = null;
      }
      update.role = desiredRole;
    }
  }

  if (editingPermissions) {
    if ((update.role ?? member.role) !== "admin") {
      return NextResponse.json(
        { error: "Permissions only apply to managers" },
        { status: 409 }
      );
    }
    update.permissions = body.permissions;
  }

  // Format-validated here, same as before; the actual write goes through
  // set_member_pin() (migration 108) further down, alongside the other
  // field updates.
  let newPin: string | null | undefined;
  if (editingPin) {
    if (member.role === "owner") {
      return NextResponse.json({ error: "The owner's PIN is managed in account settings" }, { status: 409 });
    }
    if (body.pin === null || body.pin === "") {
      newPin = null;
    } else {
      const pinVal = (body.pin || "").trim();
      if (!/^\d{4,6}$/.test(pinVal)) {
        return NextResponse.json({ error: "PIN must be 4–6 digits" }, { status: 400 });
      }
      newPin = pinVal;
    }
  }

  if (body.displayName !== undefined) {
    update.display_name = (body.displayName || "").trim() || null;
  }

  if (body.locationId !== undefined) {
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
    update.assigned_location_id = locationId;
  }

  if (Object.keys(update).length === 0 && !editingPin) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  // PIN writes go through set_member_pin() (migration 108) instead of a
  // plain column update — it hashes the PIN and does the duplicate check
  // that idx_org_members_org_pin used to do (that index is gone; bcrypt
  // digests of the same PIN don't collide, so it can't enforce anything).
  if (editingPin) {
    const { error: pinError } = await admin.rpc("set_member_pin", { p_member_id: id, p_pin: newPin });
    if (pinError) {
      if (pinError.code === "P0409") {
        return NextResponse.json({ error: "That PIN is already used by another team member" }, { status: 409 });
      }
      return NextResponse.json({ error: pinError.message }, { status: 500 });
    }
  }

  if (Object.keys(update).length > 0) {
    const { error } = await admin.from("org_members").update(update).eq("id", id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

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
