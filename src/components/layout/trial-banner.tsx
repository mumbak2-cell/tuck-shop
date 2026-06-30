"use client";
import { useState } from "react";
import { useOrg } from "@/lib/org-context";
import { AlertTriangle, Clock } from "lucide-react";
import { PricingModal } from "@/components/billing/pricing-modal";

export function TrialBanner() {
  const { subscriptionStatus, trialDaysLeft, isWritable } = useOrg();
  const [showPricing, setShowPricing] = useState(false);

  if (subscriptionStatus !== "trialing") return null;
  if (trialDaysLeft === null) return null;

  // Trial has expired
  if (!isWritable) {
    return (
      <>
        <div className="bg-red-50 border-b border-red-200">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2 flex items-center gap-3">
            <AlertTriangle className="w-4 h-4 text-red-600 flex-shrink-0" />
            <p className="text-sm text-red-800 flex-1">
              <span className="font-semibold">Your free trial has ended.</span>{" "}
              The app is now read-only. Choose a plan to keep saving sales, stock counts and customer
              balances.
            </p>
            <button
              onClick={() => setShowPricing(true)}
              className="text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg px-3 py-1.5 whitespace-nowrap"
            >
              Choose a plan
            </button>
          </div>
        </div>
        <PricingModal open={showPricing} onClose={() => setShowPricing(false)} />
      </>
    );
  }

  // Trial active. Only show banner in the last 7 days so we are not noisy on day one.
  if (trialDaysLeft > 7) return null;

  const isUrgent = trialDaysLeft <= 3;
  const bg = isUrgent ? "bg-amber-50 border-amber-200" : "bg-blue-50 border-blue-200";
  const text = isUrgent ? "text-amber-900" : "text-blue-900";
  const icon = isUrgent ? "text-amber-600" : "text-blue-600";

  return (
    <>
      <div className={`${bg} border-b`}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2 flex items-center gap-3">
          <Clock className={`w-4 h-4 ${icon} flex-shrink-0`} />
          <p className={`text-sm ${text} flex-1`}>
            {trialDaysLeft === 1 ? (
              <>
                <span className="font-semibold">Last day of your free trial.</span> Choose a plan to
                keep using Tilify after today.
              </>
            ) : (
              <>
                <span className="font-semibold">{trialDaysLeft} days left</span> in your free trial.
              </>
            )}
          </p>
          <button
            onClick={() => setShowPricing(true)}
            className={`text-sm font-medium ${isUrgent ? "text-amber-900 hover:text-amber-700" : "text-blue-900 hover:text-blue-700"} underline whitespace-nowrap`}
          >
            Choose a plan
          </button>
        </div>
      </div>
      <PricingModal open={showPricing} onClose={() => setShowPricing(false)} />
    </>
  );
}
