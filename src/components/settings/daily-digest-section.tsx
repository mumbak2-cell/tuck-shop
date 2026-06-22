"use client";
import { useEffect, useState } from "react";
import { db, supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Mail, Plus, Trash2, Send, AlertCircle, Check } from "lucide-react";

interface Subscription {
  id: string;
  email: string;
  enabled: boolean;
  send_hour_local: number;
  last_sent_at: string | null;
  last_error: string | null;
  created_at: string;
}

export function DailyDigestSection() {
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [newEmail, setNewEmail] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [sentOk, setSentOk] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const { data, error: err } = await db
      .from("report_subscriptions")
      .select("*")
      .order("created_at", { ascending: true });
    if (err) {
      setError(err.message);
    } else {
      setSubs((data as Subscription[]) || []);
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function toggleEnabled(sub: Subscription) {
    const { error: err } = await db
      .from("report_subscriptions")
      .update({ enabled: !sub.enabled })
      .eq("id", sub.id);
    if (err) {
      setError(err.message);
      return;
    }
    setSubs((s) => s.map((x) => (x.id === sub.id ? { ...x, enabled: !x.enabled } : x)));
  }

  async function changeHour(sub: Subscription, hour: number) {
    const { error: err } = await db
      .from("report_subscriptions")
      .update({ send_hour_local: hour })
      .eq("id", sub.id);
    if (err) {
      setError(err.message);
      return;
    }
    setSubs((s) => s.map((x) => (x.id === sub.id ? { ...x, send_hour_local: hour } : x)));
  }

  async function addRecipient(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const email = newEmail.trim();
    if (!email || !email.includes("@")) {
      setError("Enter a valid email address.");
      return;
    }
    setAdding(true);
    const { error: err } = await db.from("report_subscriptions").insert({
      email,
      enabled: true,
    });
    if (err) {
      setError(err.message);
    } else {
      setNewEmail("");
      await load();
    }
    setAdding(false);
  }

  async function removeRecipient(sub: Subscription) {
    if (!confirm(`Remove ${sub.email} from the daily digest?`)) return;
    const { error: err } = await db.from("report_subscriptions").delete().eq("id", sub.id);
    if (err) {
      setError(err.message);
      return;
    }
    setSubs((s) => s.filter((x) => x.id !== sub.id));
  }

  async function sendTest(sub: Subscription) {
    setSentOk(null);
    setError(null);
    setSending(sub.id);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) throw new Error("Not signed in");

      const res = await fetch("/api/reports/send-test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ subscription_id: sub.id }),
      });
      const json = await res.json();
      if (!res.ok || json.error) {
        throw new Error(json.error || "Send failed");
      }
      setSentOk(sub.id);
      await load();
      setTimeout(() => setSentOk(null), 4000);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Send failed";
      setError(message);
    } finally {
      setSending(null);
    }
  }

  if (loading) {
    return <div className="text-sm text-gray-400">Loading daily digest settings...</div>;
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-6">
      <div className="flex items-start gap-3 mb-4">
        <Mail className="w-5 h-5 text-gray-600 mt-0.5 flex-shrink-0" />
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Daily Email Digest</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Each morning, a summary of yesterday&apos;s sales, expenses, stock loss, and top products is emailed to every recipient below. Send a test email to confirm the address works before relying on it.
          </p>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm mb-4">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Recipient list */}
      {subs.length === 0 ? (
        <p className="text-sm text-gray-400 italic py-3">
          No recipients yet. Add an email below to start receiving the digest.
        </p>
      ) : (
        <div className="divide-y divide-gray-100 border border-gray-100 rounded-lg overflow-hidden mb-4">
          {subs.map((sub) => (
            <div key={sub.id} className="flex flex-col sm:flex-row sm:items-center gap-3 px-4 py-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">{sub.email}</p>
                <div className="flex items-center gap-3 text-xs text-gray-500 mt-1 flex-wrap">
                  {sub.last_sent_at ? (
                    <span className="inline-flex items-center gap-1">
                      <Check className="w-3 h-3 text-green-600" />
                      Last sent {new Date(sub.last_sent_at).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" })}
                    </span>
                  ) : (
                    <span className="text-gray-400">Never sent</span>
                  )}
                  {sub.last_error && (
                    <span className="text-red-600 inline-flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" /> {sub.last_error.slice(0, 60)}{sub.last_error.length > 60 ? "..." : ""}
                    </span>
                  )}
                  {sentOk === sub.id && (
                    <span className="text-green-700 font-medium inline-flex items-center gap-1">
                      <Check className="w-3 h-3" /> Test email sent
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <select
                  value={sub.send_hour_local}
                  onChange={(e) => changeHour(sub, parseInt(e.target.value, 10))}
                  className="text-xs border border-gray-300 rounded px-2 py-1.5 focus:border-green-500 focus:ring-1 focus:ring-green-500"
                  title="Local hour at which you would like the digest"
                >
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>{h.toString().padStart(2, "0")}:00</option>
                  ))}
                </select>
                <label className="inline-flex items-center gap-2 text-sm cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={sub.enabled}
                    onChange={() => toggleEnabled(sub)}
                    className="w-4 h-4 text-green-600 border-gray-300 rounded focus:ring-green-500"
                  />
                  <span className="text-gray-700">{sub.enabled ? "On" : "Off"}</span>
                </label>
                <button
                  onClick={() => sendTest(sub)}
                  disabled={sending === sub.id}
                  className="text-xs text-green-700 hover:text-green-900 hover:underline inline-flex items-center gap-1 disabled:opacity-50"
                >
                  <Send className="w-3 h-3" />
                  {sending === sub.id ? "Sending..." : "Send test"}
                </button>
                <button
                  onClick={() => removeRecipient(sub)}
                  className="text-xs text-red-500 hover:text-red-700"
                  title="Remove recipient"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add new recipient */}
      <form onSubmit={addRecipient} className="flex gap-2">
        <input
          type="email"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          placeholder="recipient@example.com"
          className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
        />
        <Button type="submit" variant="secondary" loading={adding}>
          <Plus className="w-4 h-4 mr-1" /> Add
        </Button>
      </form>
      <p className="text-xs text-gray-500 mt-2">
        Cron currently runs once at 04:30 UTC (06:30 SAST/CAT). The per-recipient hour above is recorded for future per-hour delivery but does not yet filter when the cron runs.
      </p>
    </div>
  );
}
