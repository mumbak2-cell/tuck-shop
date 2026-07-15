// Server-only: resolves Paystack recurring Plan codes for a (tier, cycle).
//
// Paystack recurring billing works via *Plans*: a Plan bakes in an amount + an
// interval + a currency and gets a code like `PLN_xxxx`. When a transaction is
// initialised with that code, Paystack charges the plan's amount, creates a
// Subscription, and then re-charges the saved card automatically each interval —
// firing charge.success / invoice.* / subscription.* webhooks. We never schedule
// the recurring charge ourselves; Paystack's interval drives it.
//
// Codes live in environment variables rather than in source because:
//   • test-mode and live-mode Plans have different codes (per deployment), and
//   • plan codes must never reach the client bundle (plans.ts is imported there).
//
// Set these 9 variables (test codes in local/preview env, live codes in the
// production env). Absent value ⇒ that (tier, cycle) falls back to a one-time
// charge, so the app is safe to ship before the Plans exist:
//
//   PAYSTACK_PLAN_STARTER_MONTHLY     PAYSTACK_PLAN_STARTER_QUARTERLY   PAYSTACK_PLAN_STARTER_ANNUAL
//   PAYSTACK_PLAN_GROWTH_MONTHLY      PAYSTACK_PLAN_GROWTH_QUARTERLY    PAYSTACK_PLAN_GROWTH_ANNUAL
//   PAYSTACK_PLAN_PRO_MONTHLY         PAYSTACK_PLAN_PRO_QUARTERLY       PAYSTACK_PLAN_PRO_ANNUAL

import type { PlanCode, BillingCycle } from "./plans";

const PLAN_CODES: readonly PlanCode[] = ["starter", "growth", "pro"];
const CYCLES: readonly BillingCycle[] = ["monthly", "quarterly", "annual"];

/** The env var name that holds the Paystack Plan code for a (tier, cycle). */
export function planEnvKey(plan: PlanCode, cycle: BillingCycle): string {
  return `PAYSTACK_PLAN_${plan.toUpperCase()}_${cycle.toUpperCase()}`;
}

/**
 * The Paystack recurring Plan code for a (tier, cycle), or undefined when it
 * isn't configured — in which case the caller should fall back to a one-time
 * charge for that cycle.
 */
export function paystackPlanCode(
  plan: PlanCode,
  cycle: BillingCycle,
): string | undefined {
  const code = process.env[planEnvKey(plan, cycle)]?.trim();
  return code ? code : undefined;
}

/**
 * Reverse lookup: given a Paystack Plan code seen on a webhook (e.g. a renewal
 * charge.success carries data.plan.plan_code but not our metadata), find which
 * (tier, cycle) it belongs to. Returns undefined if it matches no configured
 * plan (e.g. a Plan created in the dashboard we don't know about).
 */
export function resolveByPaystackCode(
  paystackCode: string,
): { plan: PlanCode; cycle: BillingCycle } | undefined {
  for (const plan of PLAN_CODES) {
    for (const cycle of CYCLES) {
      if (paystackPlanCode(plan, cycle) === paystackCode) return { plan, cycle };
    }
  }
  return undefined;
}

/** Map a Paystack Plan interval string back to our billing cycle. */
export function cycleFromInterval(interval?: string): BillingCycle | undefined {
  switch (interval) {
    case "monthly":
      return "monthly";
    case "quarterly":
      return "quarterly";
    case "annually":
      return "annual";
    default:
      return undefined;
  }
}

/** Advance a date by one billing cycle — used to set current_period_end. */
export function addCycle(from: Date, cycle: BillingCycle): Date {
  const d = new Date(from);
  if (cycle === "annual") d.setFullYear(d.getFullYear() + 1);
  else if (cycle === "quarterly") d.setMonth(d.getMonth() + 3);
  else d.setMonth(d.getMonth() + 1);
  return d;
}
