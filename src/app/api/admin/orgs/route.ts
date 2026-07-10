// GET /api/admin/orgs — list every organisation on the platform with the
// facts a founder needs at a glance: who owns it, how many users and
// locations it has, what plan it is on, and whether its trial has lapsed.
//
// Platform admin only. Read-only: this route has no POST/PATCH. Changing a
// subscription or extending a trial is a separate, deliberate surface.
//
// `writable` mirrors the SQL predicate in current_user_writable_org_ids(),
// as redefined by migration 035 — an active org must ALSO have a
// current_period_end in the future (or NULL, for legacy rows). When it is
// false the org's RLS policies block every INSERT/UPDATE/DELETE — the
// operator can read their data but cannot trade.
// Keep the two in step: if the SQL changes, change this too.
//
// Caveat: submit_sale_batch is SECURITY DEFINER and performs no membership
// or writability check, so POS sales bypass this gate entirely. `writable`
// therefore describes every write path EXCEPT that RPC. In practice the POS
// is still unreachable for a gated org because opening a shift writes to
// `shifts`, which is gated. See migration 034.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireAdmin } from "@/lib/platform-admin";
import { getPlan, type PlanCode } from "@/lib/plans";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const MS_PER_DAY = 86_400_000;

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  trial_ends_at: string;
  subscription_plan: string;
  subscription_status: "trialing" | "active" | "past_due" | "cancelled";
  current_period_end: string | null;
  referral_code: string | null;
  created_at: string;
}

/** Whole days from now until `iso`. Negative once the date has passed. */
function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / MS_PER_DAY);
}

/**
 * Map every auth user id to their email. auth.admin.listUsers is paginated
 * and silently stops at perPage, so page until a short page comes back.
 */
async function fetchUserEmails(admin: SupabaseClient): Promise<Map<string, string>> {
  const emails = new Map<string, string>();
  const perPage = 1000;
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`Could not list users: ${error.message}`);
    const users = data?.users || [];
    users.forEach((u) => {
      if (u.email) emails.set(u.id, u.email);
    });
    if (users.length < perPage) break;
  }
  return emails;
}

export async function GET(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const admin = getSupabaseAdmin();

  const { data: orgsData, error: orgsErr } = await admin
    .from("organizations")
    .select(
      "id, name, slug, trial_ends_at, subscription_plan, subscription_status, current_period_end, referral_code, created_at"
    )
    .order("created_at", { ascending: false });

  if (orgsErr) {
    return NextResponse.json({ error: orgsErr.message }, { status: 500 });
  }
  const orgs = (orgsData as OrgRow[] | null) || [];
  if (orgs.length === 0) {
    return NextResponse.json({ orgs: [] });
  }

  const orgIds = orgs.map((o) => o.id);

  const [membersRes, locationsRes, emails] = await Promise.all([
    admin.from("org_members").select("org_id, user_id, role").in("org_id", orgIds),
    admin.from("locations").select("org_id, active").in("org_id", orgIds),
    fetchUserEmails(admin),
  ]);

  if (membersRes.error) {
    return NextResponse.json({ error: membersRes.error.message }, { status: 500 });
  }
  if (locationsRes.error) {
    return NextResponse.json({ error: locationsRes.error.message }, { status: 500 });
  }

  const members = (membersRes.data as Array<{
    org_id: string;
    user_id: string;
    role: "owner" | "admin" | "member";
  }> | null) || [];

  const locations = (locationsRes.data as Array<{
    org_id: string;
    active: boolean;
  }> | null) || [];

  const memberCount = new Map<string, number>();
  const ownerEmails = new Map<string, string[]>();
  members.forEach((m) => {
    memberCount.set(m.org_id, (memberCount.get(m.org_id) || 0) + 1);
    if (m.role === "owner") {
      const email = emails.get(m.user_id);
      if (email) ownerEmails.set(m.org_id, [...(ownerEmails.get(m.org_id) || []), email]);
    }
  });

  const activeLocations = new Map<string, number>();
  locations.forEach((l) => {
    if (l.active) activeLocations.set(l.org_id, (activeLocations.get(l.org_id) || 0) + 1);
  });

  const now = Date.now();

  return NextResponse.json({
    orgs: orgs.map((o) => {
      const onTrial = o.subscription_status === "trialing";
      const trialDaysLeft = daysUntil(o.trial_ends_at);
      const plan = getPlan(o.subscription_plan as PlanCode);

      // Paid-but-lapsed: status still says 'active' but the period they paid
      // for has ended, usually a failed renewal whose webhook never landed.
      const paidPeriodValid =
        o.current_period_end === null ||
        new Date(o.current_period_end).getTime() > now;

      return {
        id: o.id,
        name: o.name,
        slug: o.slug,
        owners: ownerEmails.get(o.id) || [],
        memberCount: memberCount.get(o.id) || 0,
        locationCount: activeLocations.get(o.id) || 0,
        maxUsers: plan?.limits.maxUsers ?? null,
        maxLocations: plan?.limits.maxLocations ?? null,
        plan: o.subscription_plan,
        status: o.subscription_status,
        trialEndsAt: o.trial_ends_at,
        // Only meaningful while status is 'trialing'; null once they have paid
        // or cancelled, so the UI does not render a stale countdown.
        trialDaysLeft: onTrial ? trialDaysLeft : null,
        currentPeriodEnd: o.current_period_end,
        writable:
          (o.subscription_status === "active" && paidPeriodValid) ||
          (onTrial && new Date(o.trial_ends_at).getTime() > now),
        referralCode: o.referral_code,
        createdAt: o.created_at,
      };
    }),
  });
}
