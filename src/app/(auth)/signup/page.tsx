"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { supabase, db } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { SADC_CURRENCIES, DEFAULT_CURRENCY, type CurrencyCode } from "@/lib/currency";

export default function SignupPage() {
  const router = useRouter();
  const [shopName, setShopName] = useState("");
  const [currency, setCurrency] = useState<CurrencyCode>(DEFAULT_CURRENCY.code);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [referralCode, setReferralCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-fill referral code from ?ref=CODE in the URL so a tracked link
  // pre-fills the field on first paint.
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const ref = params.get("ref") || params.get("referral");
      if (ref) setReferralCode(ref.toUpperCase().slice(0, 32));
    } catch {
      // ignore
    }
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (!shopName.trim()) {
      setError("Please enter your shop name.");
      return;
    }

    setSubmitting(true);

    // 1. Create the auth user
    const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
      email: email.trim(),
      password,
    });

    if (signUpError) {
      setError(signUpError.message);
      setSubmitting(false);
      return;
    }

    // If Supabase requires email confirmation, signUpData.session will be null.
    // We need an active session to call the create_organization_for_user RPC.
    // Sign in immediately afterwards in case session was not auto-created.
    if (!signUpData.session) {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (signInError) {
        // Likely email confirmation is required by the project settings.
        setError(
          "Account created. Please check your email to confirm your address, then sign in."
        );
        setSubmitting(false);
        return;
      }
    }

    // 2. Create the organization and link the user as owner.
    const { data: orgIdResult, error: rpcError } = await db.rpc("create_organization_for_user", {
      p_name: shopName.trim(),
      p_currency: currency,
      p_referral_code: referralCode.trim() || null,
    });

    if (rpcError) {
      setError("Account created but could not set up your shop: " + rpcError.message);
      setSubmitting(false);
      return;
    }

    // Cache currency immediately so the dashboard renders the right symbol on first load
    try {
      window.localStorage.setItem("tilify_currency", currency);
    } catch {
      // ignore
    }

    // 3. Go to the dashboard
    router.push("/dashboard");
    void orgIdResult;
  }

  return (
    <div className="bg-white rounded-2xl shadow-xl p-8">
      <div className="text-center mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Start your Tilify shop</h1>
        <p className="text-sm text-gray-500 mt-1">14 days free, no card needed</p>
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

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
          />
          <p className="text-xs text-gray-500 mt-1">At least 8 characters.</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Referral code <span className="text-xs text-gray-400 font-normal">(optional)</span>
          </label>
          <input
            type="text"
            value={referralCode}
            onChange={(e) => setReferralCode(e.target.value.toUpperCase().slice(0, 32))}
            placeholder="e.g. JIMMY2026"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono tracking-wider focus:border-green-500 focus:ring-1 focus:ring-green-500"
          />
          <p className="text-xs text-gray-500 mt-1">
            If a Tilify partner referred you, paste their code here so they get credit.
          </p>
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

      <div className="mt-6 text-center text-sm text-gray-500">
        Already have an account?{" "}
        <Link href="/login" className="text-green-700 font-medium hover:underline">
          Sign in
        </Link>
      </div>
    </div>
  );
}
