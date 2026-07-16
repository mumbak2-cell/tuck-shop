// Server-side helper: verify the caller is the OWNER of an organisation.
//
// Distinct from requireAdmin (src/lib/platform-admin.ts), which gates the
// MK Global platform tools. This gates a shop owner managing their own team:
// only role='owner' may add or remove members, mirroring the org_members
// RLS policies member_insert_owner / member_delete_own_or_owner.
//
// Used by /api/team/* route handlers.

import { createClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export interface OrgOwnerAuth {
  ok: boolean;
  userId?: string;
  email?: string;
  orgId?: string;
  error?: string;
  status?: number;
}

export async function requireOrgOwner(req: Request): Promise<OrgOwnerAuth> {
  const authHeader = req.headers.get("authorization") || "";
  const accessToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!accessToken) {
    return { ok: false, error: "Not authenticated", status: 401 };
  }

  const userClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${accessToken}` } } }
  );
  const { data: userData, error: userErr } = await userClient.auth.getUser(accessToken);
  if (userErr || !userData.user) {
    return { ok: false, error: "Not authenticated", status: 401 };
  }

  // Find the org this user owns. The signup RPC allows only one org per user,
  // so there is at most one owner row; maybeSingle tolerates zero.
  const admin = getSupabaseAdmin();
  const { data: row } = await admin
    .from("org_members")
    .select("org_id")
    .eq("user_id", userData.user.id)
    .eq("role", "owner")
    .maybeSingle();

  if (!row) {
    return {
      ok: false,
      error: "Only the shop owner can manage the team",
      status: 403,
    };
  }

  return {
    ok: true,
    userId: userData.user.id,
    email: userData.user.email,
    orgId: row.org_id as string,
  };
}

/**
 * Like requireOrgOwner, but also admits a Manager (org_members.admin). Use for
 * oversight surfaces an owner delegates to a manager — e.g. the per-cashier
 * expense report — while keeping team management (add/remove staff) owner-only.
 */
export async function requireOrgManager(req: Request): Promise<OrgOwnerAuth> {
  const authHeader = req.headers.get("authorization") || "";
  const accessToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!accessToken) {
    return { ok: false, error: "Not authenticated", status: 401 };
  }

  const userClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${accessToken}` } } }
  );
  const { data: userData, error: userErr } = await userClient.auth.getUser(accessToken);
  if (userErr || !userData.user) {
    return { ok: false, error: "Not authenticated", status: 401 };
  }

  // One membership per user; admit only owner or admin (manager).
  const admin = getSupabaseAdmin();
  const { data: row } = await admin
    .from("org_members")
    .select("org_id, role")
    .eq("user_id", userData.user.id)
    .in("role", ["owner", "admin"])
    .maybeSingle();

  if (!row) {
    return {
      ok: false,
      error: "Only an owner or manager can view this",
      status: 403,
    };
  }

  return {
    ok: true,
    userId: userData.user.id,
    email: userData.user.email,
    orgId: row.org_id as string,
  };
}
