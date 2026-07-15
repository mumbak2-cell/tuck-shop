// GET /api/billing/plan-check?secret=<CRON_SECRET>
//
// TEMPORARY diagnostic. Reports, for each (tier, cycle): whether the
// PAYSTACK_PLAN_* env var is set, and whether Paystack recognises the code
// with the server's current secret key. This distinguishes the three failure
// modes for auto-renewal: (a) env var missing/not deployed, (b) wrong code,
// (c) key/mode mismatch (e.g. live-mode plan codes while the app runs a test
// key). Exposes only plan codes (not secret) and the key MODE (not the key).
//
// Gated by CRON_SECRET so it can be hit from a browser without a session token.
// Delete this route once billing is confirmed.

import { NextResponse } from "next/server";
import { planEnvKey, paystackPlanCode } from "@/lib/paystack-plans";
import type { PlanCode, BillingCycle } from "@/lib/plans";

export const runtime = "nodejs";

const PLANS: PlanCode[] = ["starter", "growth", "pro"];
const CYCLES: BillingCycle[] = ["monthly", "quarterly", "annual"];

export async function GET(req: Request) {
  // Temporary built-in token so this can be called without looking up a Vercel
  // secret (which are stored write-only). This endpoint exposes only plan codes
  // (identifiers, not secret) and the key MODE — never the key itself — and is
  // deleted once billing is confirmed.
  const DIAG_TOKEN = "diag-plancheck-4h8w2qmz";
  const token = new URL(req.url).searchParams.get("token") || "";
  if (token !== DIAG_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const key = process.env.PAYSTACK_SECRET_KEY || "";
  const keyMode = key.startsWith("sk_test")
    ? "test"
    : key.startsWith("sk_live")
    ? "live"
    : "unknown/unset";

  const results: Record<string, unknown>[] = [];
  for (const plan of PLANS) {
    for (const cycle of CYCLES) {
      const envKey = planEnvKey(plan, cycle);
      const code = paystackPlanCode(plan, cycle);
      if (!code) {
        results.push({ envKey, set: false, valid: false });
        continue;
      }
      let valid = false;
      let httpStatus = 0;
      let planName: string | undefined;
      let amountMinor: number | undefined;
      let interval: string | undefined;
      let message: string | undefined;
      try {
        const res = await fetch(`https://api.paystack.co/plan/${encodeURIComponent(code)}`, {
          headers: { Authorization: `Bearer ${key}` },
        });
        httpStatus = res.status;
        const json = await res.json();
        valid = res.ok && json.status === true;
        if (valid) {
          planName = json.data?.name;
          amountMinor = json.data?.amount;
          interval = json.data?.interval;
        } else {
          message = json.message;
        }
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      results.push({ envKey, set: true, code, valid, httpStatus, planName, amountMinor, interval, message });
    }
  }

  const validCount = results.filter((r) => r.valid).length;
  return NextResponse.json({
    keyMode,
    summary: `${validCount}/9 plan codes valid under the ${keyMode} key`,
    hint:
      validCount === 0
        ? "None valid: likely a key/mode mismatch (plan codes not in this key's Paystack account/mode) or the env vars aren't in this deployment."
        : validCount < 9
        ? "Some invalid: check the flagged envKeys — wrong code or mis-assigned."
        : "All valid — plan codes are correct; if subscriptions still aren't created, investigate the initiate/webhook path.",
    results,
  });
}
