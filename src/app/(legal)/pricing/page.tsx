import type { Metadata } from "next";
import { PLANS, BILLING_CURRENCY } from "@/lib/plans";
import { COMPANY, PageShell } from "../_company";

export const metadata: Metadata = {
  title: "Pricing — Tilify",
  description: "Tilify subscription plans and pricing, billed in ZAR via Paystack.",
};

export default function PricingPage() {
  return (
    <PageShell title="Pricing" contactEmail={COMPANY.infoEmail}>
      <p>
        Tilify is a subscription service for retail point-of-sale, inventory and
        revenue-assurance. All plans are billed in South African Rand (ZAR) through
        Paystack. Choose monthly, quarterly (about 6% off) or annual billing (two months
        free). Every plan starts with a 14-day free trial — no card required to begin.
      </p>

      <div className="not-prose mt-8 grid grid-cols-1 gap-4 md:grid-cols-3">
        {PLANS.map((plan) => {
          const p = plan.prices[BILLING_CURRENCY];
          return (
            <div
              key={plan.code}
              className={`flex flex-col rounded-xl border p-5 ${
                plan.highlight ? "border-green-500 bg-green-50/40" : "border-gray-200"
              }`}
            >
              <h3 className="text-lg font-bold text-gray-900">{plan.name}</h3>
              <p className="mt-0.5 text-xs text-gray-500">{plan.tagline}</p>
              {p && (
                <div className="mt-4">
                  <span className="text-3xl font-bold text-gray-900">{p.monthlyDisplay}</span>
                  <span className="ml-1 text-sm text-gray-500">/ month</span>
                  <p className="mt-1 text-xs text-gray-500">
                    or {p.quarterlyDisplay}/quarter · {p.annualDisplay}/year
                  </p>
                </div>
              )}
              <ul className="mt-4 flex-1 space-y-2 text-sm text-gray-700">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2">
                    <span className="mt-0.5 text-green-600">✓</span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      <h2>Billing terms</h2>
      <ul>
        <li>Prices are shown in ZAR and charged in ZAR via Paystack. Prices are inclusive of VAT where applicable.</li>
        <li>Subscriptions renew automatically at the end of each billing cycle until cancelled.</li>
        <li>You can cancel at any time; see our <a href="/refund-policy">Refund &amp; Cancellation Policy</a>.</li>
        <li>Use of the service is governed by our <a href="/terms">Terms of Service</a>.</li>
      </ul>

      <p>
        Questions about pricing or billing? Contact us at{" "}
        <a href={`mailto:${COMPANY.infoEmail}`}>{COMPANY.infoEmail}</a>.
      </p>
    </PageShell>
  );
}
