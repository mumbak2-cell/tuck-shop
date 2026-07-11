// GET  /api/team  — list the owner's org members with seat usage.
// POST /api/team  — add a cashier: create their login (or link an existing
//                   Tilify account) and attach them to the org as a member.
//
// Owner only, enforced by requireOrgOwner. All writes use the service-role
// client because creating an auth.users row is an admin-API operation; the
// owner check above is the authorisation gate.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireOrgOwner } from "@/lib/org-owner";
import { getPlan, type PlanCode } from "@/lib/plans";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

// Seat limit for an org whose plan is not in the catalogue (trial, past_due,
// cancelled). Trial shops get the entry-tier allowance; once they pay, their
// real plan's limit applies. Never invent headroom above Starter here.
const FALLBACK_MAX_USERS = getPlan("starter")!.limits.maxUsers;

interface MemberRow {
  id: string;
  user_id: string;
  role: "owner" | "admin" | "member";
  created_at: string;
}

/** Map user ids to emails via the paginated admin API. */
async function emailsFor(admin: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const want = new Set(ids);
  const out = new Map<string, string>();
  const perPage = 1000;
  for (let page = 1; page <= 20 && out.size < want.size; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(error.message);
    const users = data?.users || [];
    for (const u of users) if (u.email && want.has(u.id)) out.set(u.id, u.email);
    if (users.length < perPage) break;
  }
  return out;
}

/** Readable, transcribable temp password: Tilify-xxxx-xxxx (no ambiguous chars). */
function tempPassword(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789"; // no l/o/0/1
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
  return `Tilify-${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
}

async function planLimitAndCount(admin: SupabaseClient, orgId: string) {
  const { data: org } = await admin
    .from("organizations")
    .select("subscription_plan")
    .eq("id", orgId)
    .maybeSingle();
  const plan = org ? getPlan(org.subscription_plan as PlanCode) : undefined;
  const maxUsers = plan ? plan.limits.maxUsers : FALLBACK_MAX_USERS;

  const { count } = await admin
    .from("org_members")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId);

  return { maxUsers, memberCount: count ?? 0, planName: plan?.name ?? "trial" };
}

export async function GET(req: Request) {
  const auth = await requireOrgOwner(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = getSupabaseAdmin();
  const { data: membersData, error } = await admin
    .from("org_members")
    .select("id, user_id, role, created_at")
    .eq("org_id", auth.orgId!)
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const members = (membersData as MemberRow[] | null) || [];
  const emails = await emailsFor(admin, members.map((m) => m.user_id));
  const { maxUsers, memberCount } = await planLimitAndCount(admin, auth.orgId!);

  return NextResponse.json({
    members: members.map((m) => ({
      id: m.id,
      email: emails.get(m.user_id) ?? "(unknown)",
      role: m.role,
      isSelf: m.user_id === auth.userId,
      isOwner: m.role === "owner",
      joinedAt: m.created_at,
    })),
    seats: { used: memberCount, max: maxUsers },
  });
}

interface InviteBody {
  email?: string;
  name?: string;
}

export async function POST(req: Request) {
  const auth = await requireOrgOwner(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: InviteBody;
  try {
    body = (await req.json()) as InviteBody;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const email = (body.email || "").trim().toLowerCase();
  const name = (body.name || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
  }

  const admin = getSupabaseAdmin();

  // Seat check first — cheapest rejection, and avoids creating an auth user we
  // then can't attach. null max = unlimited.
  const { maxUsers, memberCount, planName } = await planLimitAndCount(admin, auth.orgId!);
  if (maxUsers !== null && memberCount >= maxUsers) {
    return NextResponse.json(
      {
        error: `Your ${planName} plan includes ${maxUsers} user${maxUsers === 1 ? "" : "s"}. Upgrade your plan to add more.`,
      },
      { status: 409 }
    );
  }

  // Does a Tilify account already exist for this email?
  let existingId: string | null = null;
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const found = data?.users?.find((u) => u.email?.toLowerCase() === email);
    if (found) { existingId = found.id; break; }
    if ((data?.users?.length ?? 0) < 1000) break;
  }

  if (existingId) {
    // The app assumes one org per user: create_organization_for_user rejects a
    // second membership, and default_user_org_id() resolves a user's org via
    // `LIMIT 1` with no ordering. Attaching someone who already belongs to any
    // org would give them two memberships, so their POS rows (org_id defaults
    // from that ambiguous lookup) could land in the wrong tenant. So only an
    // account that belongs to no org yet can be linked here.
    const { data: memberships, error: memErr } = await admin
      .from("org_members")
      .select("org_id")
      .eq("user_id", existingId);
    if (memErr) return NextResponse.json({ error: memErr.message }, { status: 500 });

    if (memberships && memberships.length > 0) {
      const onThisTeam = memberships.some((m) => m.org_id === auth.orgId);
      return NextResponse.json(
        {
          error: onThisTeam
            ? `${email} is already on your team`
            : `${email} already has a Tilify account tied to another shop, so it can't be added as a cashier here. Ask them to use a different email.`,
        },
        { status: 409 }
      );
    }

    // Unattached existing login — safe to make this org their only membership.
    const { error: linkErr } = await admin
      .from("org_members")
      .insert({ org_id: auth.orgId!, user_id: existingId, role: "member" });
    if (linkErr) {
      // 23505 = unique_violation on (org_id, user_id): a concurrent add of the
      // same person raced us here. That's the "already on your team" outcome,
      // not a server error.
      if (linkErr.code === "23505") {
        return NextResponse.json({ error: `${email} is already on your team` }, { status: 409 });
      }
      return NextResponse.json({ error: linkErr.message }, { status: 500 });
    }
    return NextResponse.json({
      linked: true,
      email,
      message: `${email} already had a Tilify login and can now sign in to your shop.`,
    });
  }

  // Create the login with a temporary password. email_confirm so they can sign
  // in immediately without an email round-trip.
  const password = tempPassword();
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: name ? { name } : {},
  });
  if (createErr || !created.user) {
    return NextResponse.json({ error: createErr?.message || "Could not create login" }, { status: 500 });
  }

  const { error: memberErr } = await admin
    .from("org_members")
    .insert({ org_id: auth.orgId!, user_id: created.user.id, role: "member" });
  if (memberErr) {
    // Roll back the orphaned auth user so a retry isn't blocked by "email exists".
    await admin.auth.admin.deleteUser(created.user.id);
    return NextResponse.json({ error: memberErr.message }, { status: 500 });
  }

  return NextResponse.json({ created: true, email, name, tempPassword: password });
}
