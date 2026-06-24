// Server-side helper: verify the calling user is a platform admin.
//
// Platform admins are members of MK Global staff allow-listed in the
// platform_admins table (see migration 027). They can view and modify
// every partner, referral, and payout. Regular org owners cannot.
//
// Used by /api/admin/* route handlers.

import { createClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export interface AdminAuthResult {
  ok: boolean;
  userId?: string;
  email?: string;
  error?: string;
  status?: number;
}

export async function requireAdmin(req: Request): Promise<AdminAuthResult> {
  const authHeader = req.headers.get("authorization") || "";
  const accessToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!accessToken) {
    return { ok: false, error: "Not authenticated", status: 401 };
  }

  // Verify the token by asking Supabase for the user.
  const userClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${accessToken}` } } }
  );
  const { data: userData, error: userErr } = await userClient.auth.getUser(accessToken);
  if (userErr || !userData.user) {
    return { ok: false, error: "Not authenticated", status: 401 };
  }

  // Check the platform_admins allow-list using the admin client (bypasses RLS).
  const admin = getSupabaseAdmin();
  const { data: row } = await admin
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", userData.user.id)
    .maybeSingle();

  if (!row) {
    return {
      ok: false,
      error: "Not authorised — platform admins only",
      status: 403,
    };
  }

  return {
    ok: true,
    userId: userData.user.id,
    email: userData.user.email,
  };
}
