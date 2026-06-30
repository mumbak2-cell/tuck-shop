"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { KeyRound, CheckCircle } from "lucide-react";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // While we wait for Supabase to parse the recovery token from the URL hash
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [recoveryDenied, setRecoveryDenied] = useState(false);

  // Supabase auto-detects the recovery token on this page from the URL hash.
  // We listen for the PASSWORD_RECOVERY auth event before showing the form.
  useEffect(() => {
    // If the user landed here with an existing valid session, also allow the change.
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) setRecoveryReady(true);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") {
        setRecoveryReady(true);
      }
    });

    // If no recovery event arrives within 4 seconds, the link is stale or missing.
    const timer = setTimeout(() => {
      if (!recoveryReady) setRecoveryDenied(true);
    }, 4000);

    return () => {
      sub.subscription.unsubscribe();
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    setSubmitting(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });

    if (updateError) {
      setError(updateError.message);
      setSubmitting(false);
      return;
    }

    setSuccess(true);
    setSubmitting(false);

    // Send them to the dashboard after a moment - they are signed in already.
    setTimeout(() => router.push("/dashboard"), 1500);
  }

  if (success) {
    return (
      <div className="bg-white rounded-2xl shadow-xl p-8">
        <div className="flex flex-col items-center text-center">
          <div className="w-14 h-14 bg-green-100 rounded-full flex items-center justify-center mb-4">
            <CheckCircle className="w-7 h-7 text-green-600" />
          </div>
          <h1 className="text-xl font-bold text-gray-900">Password updated</h1>
          <p className="text-sm text-gray-500 mt-2">Taking you to your dashboard...</p>
        </div>
      </div>
    );
  }

  if (recoveryDenied && !recoveryReady) {
    return (
      <div className="bg-white rounded-2xl shadow-xl p-8 text-center">
        <h1 className="text-xl font-bold text-gray-900">Reset link expired</h1>
        <p className="text-sm text-gray-500 mt-2">
          The link you used is no longer valid. Request a new one to keep going.
        </p>
        <Link
          href="/forgot-password"
          className="mt-5 inline-flex items-center gap-2 text-sm text-green-700 font-medium hover:underline"
        >
          Request a new reset link
        </Link>
      </div>
    );
  }

  if (!recoveryReady) {
    return (
      <div className="bg-white rounded-2xl shadow-xl p-8 text-center text-gray-400 text-sm">
        Verifying your reset link...
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl shadow-xl p-8">
      <div className="text-center mb-6">
        <div className="w-14 h-14 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <KeyRound className="w-7 h-7 text-green-600" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900">Set a new password</h1>
        <p className="text-sm text-gray-500 mt-1">At least 8 characters.</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">New password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Confirm password</label>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
          />
        </div>

        {error && (
          <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        <Button type="submit" loading={submitting} className="w-full">
          Update password
        </Button>
      </form>
    </div>
  );
}
