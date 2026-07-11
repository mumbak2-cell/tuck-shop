// PATCH /api/admin/orgs/[id] — platform-admin overrides of an org's
// subscription state from the /admin/customers page.
//
// Editable: trial_ends_at, subscription_plan, subscription_status,
// current_period_end. Each field that actually changes is applied AND
// written to admin_org_overrides (migration 041) with the old→new value,
// the acting admin, and an optional reason.
//
// These edits sit outside the payment provider: setting status='active'
// by hand grants access without a real charge, which is why that path
// requires a note. Keep this route the ONLY write surface for these
// columns from the UI — the list route (../route.ts) stays read-only.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireAdmin } from "@/lib/platform-admin";

export const runtime = "nodejs";

const PLAN_TIERS = ["starter", "growth", "pro"] as const;
const STATUSES = ["trialing", "active", "past_due", "cancelled"] as const;

interface PatchBody {
  trialEndsAt?: string; // ISO datetime or YYYY-MM-DD (interpreted as end of that day, UTC)
  plan?: string;
  status?: string;
  currentPeriodEnd?: string | null;
  note?: string;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalise a date input to an ISO string, or return undefined if invalid.
 * A bare YYYY-MM-DD is treated as the END of that day (UTC) so a trial or
 * comp period set to "the 25th" stays valid through all of the 25th rather
 * than lapsing at midnight.
 */
function normaliseDate(input: string): string | undefined {
  const raw = DATE_ONLY.test(input) ? `${input}T23:59:59.999Z` : input;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

interface OrgState {
  id: string;
  name: string;
  trial_ends_at: string;
  subscription_plan: string;
  subscription_status: string;
  current_period_end: string | null;
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { id } = await params;

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const admin = getSupabaseAdmin();

  const { data: current, error: readErr } = await admin
    .from("organizations")
    .select("id, name, trial_ends_at, subscription_plan, subscription_status, current_period_end")
    .eq("id", id)
    .maybeSingle();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  if (!current) return NextResponse.json({ error: "Organisation not found" }, { status: 404 });

  const org = current as OrgState;
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;

  const patch: Record<string, unknown> = {};
  const changes: { field: string; old: string | null; new: string | null }[] = [];
  const record = (field: string, oldVal: string | null, newVal: string | null) => {
    patch[field] = newVal;
    changes.push({ field, old: oldVal, new: newVal });
  };

  if (body.trialEndsAt !== undefined) {
    const iso = normaliseDate(body.trialEndsAt);
    if (!iso) return NextResponse.json({ error: "Invalid trial end date" }, { status: 400 });
    if (iso !== org.trial_ends_at) record("trial_ends_at", org.trial_ends_at, iso);
  }

  if (body.plan !== undefined) {
    if (!(PLAN_TIERS as readonly string[]).includes(body.plan)) {
      return NextResponse.json({ error: "Invalid plan tier" }, { status: 400 });
    }
    if (body.plan !== org.subscription_plan) record("subscription_plan", org.subscription_plan, body.plan);
  }

  if (body.status !== undefined) {
    if (!(STATUSES as readonly string[]).includes(body.status)) {
      return NextResponse.json({ error: "Invalid subscription status" }, { status: 400 });
    }
    // Manually flipping an org to 'active' grants paid access with no charge
    // on record — require a reason so the audit log explains the comp.
    if (body.status === "active" && org.subscription_status !== "active" && !note) {
      return NextResponse.json(
        { error: "A reason is required when activating an org manually." },
        { status: 400 }
      );
    }
    if (body.status !== org.subscription_status) record("subscription_status", org.subscription_status, body.status);
  }

  if (body.currentPeriodEnd !== undefined) {
    let iso: string | null = null;
    if (body.currentPeriodEnd !== null) {
      const norm = normaliseDate(body.currentPeriodEnd);
      if (!norm) return NextResponse.json({ error: "Invalid period end date" }, { status: 400 });
      iso = norm;
    }
    if (iso !== org.current_period_end) record("current_period_end", org.current_period_end, iso);
  }

  if (changes.length === 0) {
    return NextResponse.json({ ok: true, unchanged: true });
  }

  const { data: updated, error: updErr } = await admin
    .from("organizations")
    .update(patch)
    .eq("id", id)
    .select("id, name, trial_ends_at, subscription_plan, subscription_status, current_period_end")
    .single();
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  // Append the audit rows. The change is already applied; if logging fails we
  // still return success but flag it, so a broken audit trail is visible
  // rather than silent.
  const auditRows = changes.map((c) => ({
    org_id: id,
    admin_user_id: auth.userId,
    admin_email: auth.email ?? null,
    field: c.field,
    old_value: c.old,
    new_value: c.new,
    note,
  }));
  const { error: auditErr } = await admin.from("admin_org_overrides").insert(auditRows);

  return NextResponse.json({
    ok: true,
    org: updated,
    changed: changes.map((c) => c.field),
    ...(auditErr ? { auditWarning: `Change applied but not logged: ${auditErr.message}` } : {}),
  });
}
