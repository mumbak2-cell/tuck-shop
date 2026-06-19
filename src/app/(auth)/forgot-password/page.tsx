"use client";
import { useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Mail, ArrowLeft, CheckCircle } from "lucide-react";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    // Supabase sends the reset email and embeds a recovery token in a URL
    // that points back at our /reset-password page. The token lives in the
    // URL hash fragment; the supabase-js client picks it up on page load.
    const redirectTo = `${window.location.origin}/reset-password`;
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo,
    });

    if (resetError) {
      // We intentionally do NOT surface "email not found" errors here.
      // Showing whether an email exists is a small information leak that lets
      // someone enumerate accounts on the system. Always show success.
      console.error(resetError);
    }

    setSent(true);
    setSubmitting(false);
  }

  if (sent) {
    return (
      <div className="bg-white rounded-2xl shadow-xl p-8">
        <div className="flex flex-col items-center text-center">
          <div className="w-14 h-14 bg-green-100 rounded-full flex items-center justify-center mb-4">
            <CheckCircle className="w-7 h-7 text-green-600" />
          </div>
          <h1 className="text-xl font-bold text-gray-900">Check your inbox</h1>
          <p className="text-sm text-gray-500 mt-2 max-w-sm">
            If an account exists for <span className="font-medium text-gray-700">{email}</span>, we
            have sent a password reset link. The link expires in 1 hour.
          </p>
          <Link
            href="/login"
            className="mt-6 inline-flex items-center gap-2 text-sm text-green-700 font-medium hover:underline"
          >
            <ArrowLeft className="w-4 h-4" /> Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl shadow-xl p-8">
      <div className="text-center mb-6">
        <div className="w-14 h-14 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <Mail className="w-7 h-7 text-green-600" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900">Reset your password</h1>
        <p className="text-sm text-gray-500 mt-1">
          Enter the email you signed up with. We will send a link to set a new password.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
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

        {error && (
          <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        <Button type="submit" loading={submitting} className="w-full">
          Send reset link
        </Button>
      </form>

      <div className="mt-6 text-center text-sm text-gray-500">
        Remembered it?{" "}
        <Link href="/login" className="text-green-700 font-medium hover:underline">
          Back to sign in
        </Link>
      </div>
    </div>
  );
}
