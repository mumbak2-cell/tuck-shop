"use client";
import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { KeyRound } from "lucide-react";

/**
 * First-login gate. A cashier (or manager) created with a one-time temporary
 * password is flagged `must_change_password` in their user_metadata. This
 * screen forces them to set their own password before they can use the app,
 * and clears the flag in the same update. Rendered by the dashboard/WMS
 * layouts in place of everything else while the flag is set.
 */
export function ForcePasswordChange({
  email,
  onDone,
  onSignOut,
}: {
  email?: string | null;
  onDone: () => void | Promise<void>;
  onSignOut: () => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    // Update the password and clear the flag in one call. updateUser refreshes
    // the local session, so the layout's re-read sees must_change_password gone.
    const { error: updErr } = await supabase.auth.updateUser({
      password,
      data: { must_change_password: false },
    });
    if (updErr) {
      setError(updErr.message);
      setSubmitting(false);
      return;
    }
    await onDone();
    // On success the layout stops rendering this screen, so no need to reset state.
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-green-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-sm">
        <div className="text-center mb-6">
          <div className="w-14 h-14 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <KeyRound className="w-7 h-7 text-green-600" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Set your own password</h1>
          <p className="text-sm text-gray-500 mt-1">
            You&apos;re signed in with a temporary password. Choose a new one to continue.
          </p>
          {email && <p className="text-xs text-gray-400 mt-2">{email}</p>}
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
            Save password &amp; continue
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
