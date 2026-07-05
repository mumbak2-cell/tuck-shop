"use client";
import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { PLANS, BILLING_CURRENCY, type Plan, type PlanCode } from "@/lib/plans";
import { Check, Sparkles, AlertCircle } from "lucide-react";
import { useOrg } from "@/lib/org-context";
import { supabase } from "@/lib/supabase";

interface Props {
  open: boolean;
  onClose: () => void;
}

type BillingCycle = "monthly" | "quarterly" | "annual";

export function PricingModal({ open, onClose }: Props) {
  const org = useOrg();
  const [cycle, setCycle] = useState<BillingCycle>("monthly");
  const [submitting, setSubmitting] = useState<PlanCode | null>(null);
  const [error, setError] = useState<string | null>(null);

  // All subscriptions are billed in ZAR via Paystack regardless of the
  // operator's display currency. Their POS still uses their local currency.
  const billingCurrency = BILLING_CURRENCY;

  // Determine the operator's display currency for informational context only.
  let displayCurrency = "ZAR";
  try {
    if (typeof window !== "undefined") {
      displayCurrency = window.localStorage.getItem("tilify_currency") || "ZAR";
    }
  } catch {
    // ignore
  }

  async function upgrade(plan: Plan) {
    setError(null);
    setSubmitting(plan.code);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) {
        throw new Error("You are signed out. Please sign in again.");
      }
      const res = await fetch("/api/billing/initiate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          planCode: plan.code,
          cycle,
        }),
      });
      const json = await res.json();
      if (!res.ok || json.error) {
        throw new Error(json.error || "Could not start checkout");
      }
      if (json.checkoutUrl) {
        window.location.assign(json.checkoutUrl);
        return;
      }
      throw new Error("No checkout URL returned");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to start checkout";
      setError(message);
      setSubmitting(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Choose a plan" wide>
      <div className="space-y-5">
        {/* Cycle toggle */}
        <div className="flex justify-center">
          <div className="inline-flex bg-gray-100 rounded-lg p-1">
            <button
              onClick={() => setCycle("monthly")}
              className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
                cycle === "monthly" ? "bg-white shadow text-gray-900" : "text-gray-600"
              }`}
            >
              Monthly
            </button>
            <button
              onClick={() => setCycle("quarterly")}
              className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
                cycle === "quarterly" ? "bg-white shadow text-gray-900" : "text-gray-600"
              }`}
            >
              Quarterly
            </button>
            <button
              onClick={() => setCycle("annual")}
              className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
                cycle === "annual" ? "bg-white shadow text-gray-900" : "text-gray-600"
              }`}
            >
              Annual <span className="text-green-600 text-xs ml-1">save 2 months</span>
            </button>
          </div>
        </div>

        {/* Plans */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {PLANS.map((plan) => {
            const price = plan.prices[billingCurrency];
            const display = price
              ? cycle === "monthly"
                ? price.monthlyDisplay
                : cycle === "quarterly"
                ? price.quarterlyDisplay
                : price.annualDisplay
              : null;
            const periodLabel =
              cycle === "monthly" ? "month" : cycle === "quarterly" ? "quarter" : "year";
            const isHighlight = plan.highlight === true;
            const isCurrent = org.subscriptionPlan === plan.code && org.subscriptionStatus === "active";

            return (
              <div
                key={plan.code}
                className={`relative flex flex-col rounded-xl border p-5 ${
                  isHighlight ? "border-green-500 bg-green-50/30 shadow-md" : "border-gray-200 bg-white"
                }`}
              >
                {isHighlight && (
                  <div className="absolute -top-2.5 left-1/2 -translate-x-1/2 px-2 py-0.5 bg-green-600 text-white text-xs font-medium rounded-full inline-flex items-center gap-1">
                    <Sparkles className="w-3 h-3" /> Most popular
                  </div>
                )}

                <h3 className="text-lg font-bold text-gray-900">{plan.name}</h3>
                <p className="text-xs text-gray-500 mt-0.5">{plan.tagline}</p>

                <div className="mt-4">
                  {display && (
                    <>
                      <span className="text-3xl font-bold text-gray-900">{display}</span>
                      <span className="text-sm text-gray-500 ml-1">
                        / {periodLabel}
                      </span>
                    </>
                  )}
                </div>

                <ul className="mt-4 space-y-2 text-sm flex-1">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-gray-700">
                      <Check className="w-4 h-4 text-green-600 mt-0.5 flex-shrink-0" />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>

                <Button
                  onClick={() => upgrade(plan)}
                  disabled={!price || isCurrent || submitting !== null}
                  loading={submitting === plan.code}
                  variant={isHighlight ? "primary" : "secondary"}
                  className="mt-5 w-full"
                >
                  {isCurrent ? "Current plan" : price ? `Upgrade to ${plan.name}` : "Contact us"}
                </Button>
              </div>
            );
          })}
        </div>

        {error && (
          <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <p className="text-xs text-gray-500 text-center">
          {displayCurrency !== "ZAR" && (
            <>
              <span className="font-medium">Billed in ZAR via Paystack.</span> Your POS, products,
              and customer balances stay in {displayCurrency}; only the Tilify subscription is in
              Rand. Pay with any Visa or Mastercard — your card issuer handles the conversion.
              <br />
            </>
          )}
          Cancel anytime. Annual plans get the equivalent of 2 months free.
        </p>
      </div>
    </Modal>
  );
}
