"use client";
import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

// Marketing landing page for the Facebook "Inventory Leak Calculator" ad.
// Public, no auth. Result computes instantly client-side (no gate, matches
// the ad's "no commitment" promise); the lead form below it is optional —
// only submitted leads hit the API.

const DEFAULT_SHRINK_PCT = 3;

export default function LeakCalculatorPage() {
  const [stockValue, setStockValue] = useState("");
  const [shrinkPct, setShrinkPct] = useState(String(DEFAULT_SHRINK_PCT));

  const [name, setName] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const stockValueNum = parseFloat(stockValue);
  const shrinkPctNum = parseFloat(shrinkPct);
  const hasResult = stockValueNum > 0 && shrinkPctNum >= 0;
  const monthlyLoss = hasResult ? stockValueNum * (shrinkPctNum / 100) : 0;
  const annualLoss = monthlyLoss * 12;

  async function handleLeadSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);

    if (!name.trim()) {
      setSubmitError("Please enter your name.");
      return;
    }
    if (!/^[+\d][\d\s-]{6,19}$/.test(whatsapp.trim())) {
      setSubmitError("Please enter a valid WhatsApp number.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/leads/leak-calculator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          whatsapp: whatsapp.trim(),
          monthlyStockValue: stockValueNum,
          shrinkPct: shrinkPctNum,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSubmitError(data.error || "Something went wrong. Please try again.");
        setSubmitting(false);
        return;
      }
      setSubmitted(true);
    } catch {
      setSubmitError("Network error. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-dvh bg-white text-gray-900">
      <header className="border-b border-gray-200">
        <div className="mx-auto flex max-w-2xl items-center px-6 py-4">
          <Link href="/pricing" className="text-lg font-bold text-green-700">Tilify</Link>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-6 py-10">
        <h1 className="text-3xl font-bold text-gray-900 text-balance">
          How much is your store really losing?
        </h1>
        <p className="mt-2 text-gray-600">
          Most small stores lose stock and cash every month to shrinkage and
          pricing slips — and don&apos;t see it until it&apos;s gone. Enter your
          numbers below for a free, instant estimate.
        </p>

        <div className="mt-8 bg-gray-50 border border-gray-200 rounded-xl p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Your average monthly stock value
            </label>
            <input
              type="number"
              min="0"
              inputMode="decimal"
              value={stockValue}
              onChange={(e) => setStockValue(e.target.value)}
              placeholder="e.g. 50000"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Estimated shrinkage / loss rate (%)
            </label>
            <input
              type="number"
              min="0"
              max="100"
              step="0.5"
              inputMode="decimal"
              value={shrinkPct}
              onChange={(e) => setShrinkPct(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
            />
            <p className="text-xs text-gray-500 mt-1">
              Not sure? Small retail stores typically lose {DEFAULT_SHRINK_PCT}% of stock
              value a month to theft, damage, and pricing errors — we&apos;ve
              pre-filled that as a starting point.
            </p>
          </div>

          {hasResult && (
            <div className="pt-2 border-t border-gray-200">
              <p className="text-sm text-gray-600">You could be losing about</p>
              <p className="text-3xl font-bold text-red-600">
                {monthlyLoss.toLocaleString(undefined, { maximumFractionDigits: 0 })} / month
              </p>
              <p className="text-sm text-gray-500">
                That&apos;s {annualLoss.toLocaleString(undefined, { maximumFractionDigits: 0 })} a year.
              </p>
            </div>
          )}
        </div>

        {hasResult && !submitted && (
          <div className="mt-8 bg-green-50 border border-green-200 rounded-xl p-6">
            <h2 className="text-lg font-bold text-gray-900">
              Want a specialist to walk through your numbers?
            </h2>
            <p className="text-sm text-gray-600 mt-1">
              No obligation — leave your WhatsApp number and we&apos;ll reach out.
            </p>
            <form onSubmit={handleLeadSubmit} className="mt-4 space-y-3">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
              />
              <input
                type="tel"
                value={whatsapp}
                onChange={(e) => setWhatsapp(e.target.value)}
                placeholder="WhatsApp number"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
              />
              {submitError && (
                <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  {submitError}
                </div>
              )}
              <Button type="submit" loading={submitting} className="w-full">
                Get my full breakdown
              </Button>
            </form>
          </div>
        )}

        {submitted && (
          <div className="mt-8 bg-green-50 border border-green-200 rounded-xl p-6 text-center">
            <p className="font-medium text-gray-900">Thanks, {name.split(" ")[0]}!</p>
            <p className="text-sm text-gray-600 mt-1">
              We&apos;ll reach out on WhatsApp shortly.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
