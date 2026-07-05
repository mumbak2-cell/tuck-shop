// Subscription plan catalogue. Prices and limits per plan tier, with
// currency-specific amounts. The billing routing layer reads from here
// to construct the Paystack / Flutterwave transaction for the org's
// currency, and the UI reads from here to render the pricing modal.

export type PlanCode = "starter" | "growth" | "pro";

export interface PlanLimits {
  /** Maximum locations the org can create. null = unlimited. */
  maxLocations: number | null;
  /** Maximum users (org_members). null = unlimited. */
  maxUsers: number | null;
}

export interface PlanPrice {
  /** Monthly fee in the given currency, in minor units (cents for ZAR). */
  monthlyMinor: number;
  /** Quarterly fee (3× monthly, no discount), in minor units. */
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
  /** Provider-side plan code, set up in Paystack / Flutterwave dashboards
   * for recurring subscription billing. Optional - if absent, fall back
   * to a one-time charge of monthlyMinor. */
  paystackPlanCode?: string;
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
        monthlyMinor: 24900,
        quarterlyMinor: 74700,
        annualMinor: 249000,
        monthlyDisplay: "R249",
        quarterlyDisplay: "R747",
        annualDisplay: "R2,490",
      },
      MWK: {
        monthlyMinor: 2400000,
        quarterlyMinor: 7200000,
        annualMinor: 24000000,
        monthlyDisplay: "MK24,000",
        quarterlyDisplay: "MK72,000",
        annualDisplay: "MK240,000",
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
        monthlyMinor: 49900,
        quarterlyMinor: 149700,
        annualMinor: 499000,
        monthlyDisplay: "R499",
        quarterlyDisplay: "R1,497",
        annualDisplay: "R4,990",
      },
      MWK: {
        monthlyMinor: 4800000,
        quarterlyMinor: 14400000,
        annualMinor: 48000000,
        monthlyDisplay: "MK48,000",
        quarterlyDisplay: "MK144,000",
        annualDisplay: "MK480,000",
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
        monthlyMinor: 89900,
        quarterlyMinor: 269700,
        annualMinor: 899000,
        monthlyDisplay: "R899",
        quarterlyDisplay: "R2,697",
        annualDisplay: "R8,990",
      },
      MWK: {
        monthlyMinor: 8600000,
        quarterlyMinor: 25800000,
        annualMinor: 86000000,
        monthlyDisplay: "MK86,000",
        quarterlyDisplay: "MK258,000",
        annualDisplay: "MK860,000",
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
