"use client";
import { useState } from "react";
import { db } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { SADC_CURRENCIES, DEFAULT_CURRENCY, type CurrencyCode } from "@/lib/currency";
import { Store } from "lucide-react";

/**
 * Recovery screen for a signed-in user with zero org_members rows — a
 * genuinely incomplete signup (create_organization_for_user never ran or
 * failed), not an offline/loading blip. Previously this was a dead end
 * ("contact support"); this re-runs the same RPC the signup page calls, so
 * the account can self-heal on next login instead of staying stranded.
 */
export function CompleteOrgSetup({
  onDone,
  onSignOut,
}: {
  onDone: () => void | Promise<void>;
  onSignOut: () => void;
}) {
  const [shopName, setShopName] = useState("");
  const [currency, setCurrency] = useState<CurrencyCode>(DEFAULT_CURRENCY.code);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!shopName.trim()) {
      setError("Please enter your shop name.");
      return;
    }
    setSubmitting(true);

    const { error: rpcError } = await db.rpc("create_organization_for_user", {
      p_name: shopName.trim(),
      p_currency: currency,
    });

    if (rpcError) {
      setError(rpcError.message);
      setSubmitting(false);
      return;
    }

    await onDone();
    // On success the layout stops rendering this screen, so no need to reset state.
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-sm">
        <div className="text-center mb-6">
          <div className="w-14 h-14 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <Store className="w-7 h-7 text-green-600" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Finish setting up your shop</h1>
          <p className="text-sm text-gray-500 mt-1">
            Your account was created but your shop wasn&apos;t. Let&apos;s finish that now.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Shop name</label>
            <input
              type="text"
              value={shopName}
              onChange={(e) => setShopName(e.target.value)}
              required
              placeholder="e.g. Mama Lerato's Spaza"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Currency</label>
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value as CurrencyCode)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
            >
              {SADC_CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.country} — {c.symbol} ({c.code})
                </option>
              ))}
            </select>
          </div>

          {error && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <Button type="submit" loading={submitting} className="w-full">
            Create my shop
          </Button>
        </form>

        <div className="mt-6 text-center">
          <button
            type="button"
            onClick={onSignOut}
            className="text-sm text-gray-500 hover:text-gray-700 hover:underline"
          >
            Not you? Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
