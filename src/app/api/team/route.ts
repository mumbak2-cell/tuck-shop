// GET  /api/team  — list the owner's org members with seat usage.
// POST /api/team  — add a cashier: create their login (or link an existing
//                   Tilify account) and attach them to the org as a member.
//
// Owner only, enforced by requireOrgOwner. All writes use the service-role
// client because creating an auth.users row is an admin-API operation; the
// owner check above is the authorisation gate.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireOrgOwner, requireOrgManager } from "@/lib/org-owner";
import { getPlan, type PlanCode } from "@/lib/plans";
import { rateLimit } from "@/lib/rate-limit";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

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

// Seat limit for an org whose plan is not in the catalogue (trial, past_due,
// cancelled). Trial shops get the entry-tier allowance; once they pay, their
// real plan's limit applies. Never invent headroom above Starter here.
const FALLBACK_MAX_USERS = getPlan("starter")!.limits.maxUsers;

interface MemberRow {
  id: string;
  user_id: string;
  role: "owner" | "admin" | "member";
  created_at: string;
  assigned_location_id: string | null;
  permissions: Record<string, boolean> | null;
  pin: string | null;
  display_name: string | null;
}

/** Map user ids to emails by looking up each user individually. */
async function emailsFor(admin: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const results = await Promise.allSettled(
    ids.map(async (id) => {
      const { data, error } = await admin.auth.admin.getUserById(id);
      if (error || !data.user?.email) return;
      out.set(id, data.user.email);
    })
  );
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
  try {
  // Managers may view the team (and change a cashier's branch via PATCH);
  // adding and removing staff below stays owner-only.
  const auth = await requireOrgManager(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const admin = getSupabaseAdmin();
    const { data: membersData, error } = await admin
      .from("org_members")
      .select("id, user_id, role, created_at, assigned_location_id, permissions, pin, display_name")
      .eq("org_id", auth.orgId!)
      .order("created_at", { ascending: true });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const members = (membersData as MemberRow[] | null) || [];
    const emails = await emailsFor(admin, members.map((m) => m.user_id));
    const { maxUsers, memberCount } = await planLimitAndCount(admin, auth.orgId!);

    // Location names for the "assigned to <branch>" label on each cashier.
    const { data: locRows } = await admin
      .from("locations")
      .select("id, name")
      .eq("org_id", auth.orgId!);
    const locationNames = new Map<string, string>(
      ((locRows as { id: string; name: string }[] | null) || []).map((l) => [l.id, l.name])
    );

    return NextResponse.json({
      members: members.map((m) => ({
        id: m.id,
        email: emails.get(m.user_id) ?? "(unknown)",
        role: m.role,
        isSelf: m.user_id === auth.userId,
        isOwner: m.role === "owner",
        joinedAt: m.created_at,
        assignedLocationId: m.assigned_location_id,
        assignedLocationName: m.assigned_location_id ? locationNames.get(m.assigned_location_id) ?? null : null,
        permissions: m.permissions ?? {},
        hasPin: !!m.pin,
        displayName: m.display_name,
      })),
      seats: { used: memberCount, max: maxUsers },
    });
  } catch (e) {
    // emailsFor throws on an admin.auth.admin.listUsers failure (rate limit,
    // transient network error); without this, that crashed the whole route
    // with an empty response body — the client's res.json() then failed with
    // "Unexpected end of JSON input", masking the real cause.
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not load team" },
      { status: 500 }
    );
  }
}

interface InviteBody {
  email?: string;
  name?: string;
  locationId?: string;
  /** "member" (cashier) or "admin" (manager). Defaults to member. */
  role?: string;
  pin?: string;
  displayName?: string;
}

/** Managers (org_members.admin) may only be added by an owner whose org runs
 *  more than one location — a single-branch shop is expected to be managed by
 *  the owner directly. Returns the location count for messaging. */
async function locationCount(admin: SupabaseClient, orgId: string): Promise<number> {
  const { count } = await admin
    .from("locations")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId);
  return count ?? 0;
}

const MANAGER_MIN_LOCATIONS = 2; // "more than one"

/** Validate that a location id belongs to the org. Returns the id when valid,
 *  null when the caller passed nothing, or throws a user-facing message when
 *  the id is present but does not belong to this org. Cashiers are hard-locked
 *  to a single location, so assigning a foreign one must be rejected. */
async function resolveAssignedLocation(
  admin: SupabaseClient,
  orgId: string,
  locationId: string | undefined
): Promise<string | null> {
  const id = (locationId || "").trim();
  if (!id) return null;
  const { data, error } = await admin
    .from("locations")
    .select("id")
    .eq("org_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("That location does not belong to your shop");
  return id;
}

export async function POST(req: Request) {
  const auth = await requireOrgOwner(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const rl = rateLimit(`team:${auth.orgId}`, { max: 10 });
  if (!rl.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

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
  const initialPin = (body.pin || "").trim();
  if (initialPin && !/^\d{4,6}$/.test(initialPin)) {
    return NextResponse.json({ error: "PIN must be 4–6 digits" }, { status: 400 });
  }
  const displayName = (body.displayName || body.name || "").trim() || null;

  const admin = getSupabaseAdmin();

  // Cashier (member) or Manager (admin). A manager sees every location and is
  // never location-locked; only an owner of a 3+ location org may create one.
  const desiredRole: "member" | "admin" = body.role === "admin" ? "admin" : "member";
  if (desiredRole === "admin") {
    const locations = await locationCount(admin, auth.orgId!);
    if (locations < MANAGER_MIN_LOCATIONS) {
      return NextResponse.json(
        { error: "Managers can be added once your shop has more than one location." },
        { status: 403 }
      );
    }
  }

  // Hard-lock to one location. Cashiers see and sell only at their assigned
  // branch (org-context pins them; RLS scopes their rows). Managers are never
  // pinned — they need every branch.
  //
  // A cashier MUST get a branch: current_user_location_ids() matches on
  // assigned_location_id, so leaving it null gives them no accessible location
  // at all, which silently breaks their POS (stock reads return nothing).
  let assignedLocationId: string | null = null;
  if (desiredRole === "member") {
    try {
      assignedLocationId = await resolveAssignedLocation(admin, auth.orgId!, body.locationId);
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Invalid location" },
        { status: 400 }
      );
    }
    if (!assignedLocationId && (await locationCount(admin, auth.orgId!)) > 0) {
      return NextResponse.json(
        { error: "Pick the branch this cashier works at — a cashier must be tied to one branch." },
        { status: 400 }
      );
    }
  }

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
      .insert({
        org_id: auth.orgId!,
        user_id: existingId,
        role: desiredRole,
        assigned_location_id: assignedLocationId,
        ...(initialPin ? { pin: initialPin } : {}),
        ...(displayName ? { display_name: displayName } : {}),
      });
    if (linkErr) {
      // 23505 = unique_violation — either (org_id, user_id) (a concurrent add
      // of the same person raced us here) or the partial PIN index (someone
      // else on this org already has that PIN).
      if (linkErr.code === "23505") {
        const msg = linkErr.message?.includes("idx_org_members_org_pin")
          ? "That PIN is already used by another team member"
          : `${email} is already on your team`;
        return NextResponse.json({ error: msg }, { status: 409 });
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
    // Flag the temporary password so the app forces a change on first sign-in.
    user_metadata: { must_change_password: true, ...(name ? { name } : {}) },
  });
  if (createErr || !created.user) {
    return NextResponse.json({ error: createErr?.message || "Could not create login" }, { status: 500 });
  }

  const { error: memberErr } = await admin
    .from("org_members")
    .insert({
      org_id: auth.orgId!,
      user_id: created.user.id,
      role: desiredRole,
      assigned_location_id: assignedLocationId,
      ...(initialPin ? { pin: initialPin } : {}),
      ...(displayName ? { display_name: displayName } : {}),
    });
  if (memberErr) {
    // Roll back the orphaned auth user so a retry isn't blocked by "email exists".
    await admin.auth.admin.deleteUser(created.user.id);
    if (memberErr.code === "23505" && memberErr.message?.includes("idx_org_members_org_pin")) {
      return NextResponse.json({ error: "That PIN is already used by another team member" }, { status: 409 });
    }
    return NextResponse.json({ error: memberErr.message }, { status: 500 });
  }

  // Send the login credentials by email — the caller never sees the password.
  const loginUrl = "https://tilify.mkglobal.co.za/login";
  const greeting = name ? `Hi ${name},` : "Hi,";
  const emailText = `${greeting}

You've been added to the Tilify team. Here are your login details:

Email: ${email}
Temporary password: ${password}

Sign in here: ${loginUrl}

You'll be asked to set a new password on your first sign-in.

— Tilify`;
  const emailHtml = `<p>${greeting}</p><p>You've been added to the Tilify team. Here are your login details:</p><p><strong>Email:</strong> ${email}<br><strong>Temporary password:</strong> ${password}</p><p><a href="${loginUrl}">Sign in to Tilify</a></p><p>You'll be asked to set a new password on your first sign-in.</p><p>— Tilify</p>`;

  const send = await sendViaResend(email, "Your Tilify login", emailHtml, emailText);

  return NextResponse.json({
    created: true,
    email,
    name,
    emailSent: send.ok,
    ...(send.ok ? {} : { emailError: send.error }),
  });
}
