// Subscription plan catalogue. Prices and limits per plan tier, with
// currency-specific amounts. The billing routing layer reads from here
// to construct the Paystack / Flutterwave transaction for the org's
// currency, and the UI reads from here to render the pricing modal.

export type PlanCode = "starter" | "growth" | "pro";

/** Billing cycle the operator chooses at checkout. Maps to Paystack Plan
 *  intervals monthly / quarterly / annually (see lib/paystack-plans.ts). */
export type BillingCycle = "monthly" | "quarterly" | "annual";

export interface PlanLimits {
  /** Maximum locations the org can create. null = unlimited. */
  maxLocations: number | null;
  /** Maximum users (org_members). null = unlimited. */
  maxUsers: number | null;
}

export interface PlanPrice {
  /** Monthly fee in the given currency, in minor units (cents for ZAR). */
  monthlyMinor: number;
  /** Quarterly fee (~6% off 3× monthly), in minor units. */
  quarterlyMinor: number;
  /** Annual fee with 2 months free (monthlyMinor * 10), in minor units. */
  annualMinor: number;
  /** Friendly display string of the monthly price. */
  monthlyDisplay: string;
  /** Friendly display string of the quarterly price. */
  quarterlyDisplay: string;
  /** Friendly display string of the annual price. */
  annualDisplay: string;
}

export interface Plan {
  code: PlanCode;
  name: string;
  tagline: string;
  highlight?: boolean;
  features: string[];
  limits: PlanLimits;
  /** Paystack recurring Plan codes are resolved server-side per (tier, cycle)
   * from environment variables — see lib/paystack-plans.ts. They are not held
   * here because test-mode and live-mode codes differ per deployment, and they
   * must never reach the client bundle. When no code is configured for a
   * (tier, cycle), checkout falls back to a one-time charge. */
  flutterwavePaymentPlanId?: number;
  /** Per-currency pricing. Currencies not listed here are unsupported
   * for that plan; the upgrade flow shows a "contact us" message. */
  prices: Partial<Record<string, PlanPrice>>;
}

export const PLANS: Plan[] = [
  {
    code: "starter",
    name: "Starter",
    tagline: "Single shop, just sell",
    features: [
      "1 location",
      "2 users",
      "Full POS, stock, customers, Revenue Assurance",
      "SADC mobile money payment methods",
      "WhatsApp support",
    ],
    limits: { maxLocations: 1, maxUsers: 2 },
    prices: {
      ZAR: {
        monthlyMinor: 1000,
        quarterlyMinor: 84900,
        annualMinor: 299000,
        monthlyDisplay: "R10",
        quarterlyDisplay: "R849",
        annualDisplay: "R2,990",
      },
    },
  },
  {
    code: "growth",
    name: "Growth",
    tagline: "Two or three locations under one owner",
    highlight: true,
    features: [
      "Up to 3 locations",
      "5 users",
      "Per-location reports + consolidated view",
      "Per-location cashier assignment",
      "Email support 24h response",
    ],
    limits: { maxLocations: 3, maxUsers: 5 },
    prices: {
      ZAR: {
        monthlyMinor: 59900,
        quarterlyMinor: 169900,
        annualMinor: 599000,
        monthlyDisplay: "R599",
        quarterlyDisplay: "R1,699",
        annualDisplay: "R5,990",
      },
    },
  },
  {
    code: "pro",
    name: "Pro",
    tagline: "A chain that needs everything",
    features: [
      "Unlimited locations",
      "15 users",
      "Priority support 8h response + WhatsApp",
      "Onboarding session for new locations",
      "Custom reporting on request",
    ],
    limits: { maxLocations: null, maxUsers: 15 },
    prices: {
      ZAR: {
        monthlyMinor: 99900,
        quarterlyMinor: 279900,
        annualMinor: 999000,
        monthlyDisplay: "R999",
        quarterlyDisplay: "R2,799",
        annualDisplay: "R9,990",
      },
    },
  },
];

export function getPlan(code: PlanCode): Plan | undefined {
  return PLANS.find((p) => p.code === code);
}

export function getPlanRank(code: string | null | undefined): number {
  switch (code) {
    case "starter": return 1;
    case "growth": return 2;
    case "pro": return 3;
    default: return 0;
  }
}

export function isAtLeastPlan(orgPlan: string | null | undefined, required: PlanCode): boolean {
  return getPlanRank(orgPlan) >= getPlanRank(required);
}

/**
 * All Tilify subscriptions are billed in ZAR via Paystack, regardless of the
 * operator's display currency. The operator's local-currency view of their
 * POS, products, and customer balances is unaffected - only the monthly
 * Tilify fee is in ZAR. This keeps billing simple and reaches all 16 SADC
 * countries from day one without needing Flutterwave, DPO, or per-country
 * integrations.
 *
 * Operators pay with any card accepted by Paystack - their card issuer
 * handles the FX conversion automatically.
 */
export type BillingProvider = "paystack";

export const BILLING_CURRENCY = "ZAR";

export function providerForCurrency(_currency: string): BillingProvider {
  return "paystack";
}
