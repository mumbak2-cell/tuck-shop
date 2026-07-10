"use client";
// Team management, owner-only. Lists org members, shows seat usage against the
// plan, and lets the owner add a cashier (creating their login with a one-time
// temporary password) or remove one. Renders nothing for non-owners.

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useOrg } from "@/lib/org-context";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Users, UserPlus, Trash2, AlertCircle, Copy, Check } from "lucide-react";

interface Member {
  id: string;
  email: string;
  role: "owner" | "admin" | "member";
  isSelf: boolean;
  isOwner: boolean;
  joinedAt: string;
}

interface NewCredential {
  email: string;
  name?: string;
  tempPassword: string;
}

const ROLE_LABEL: Record<Member["role"], string> = {
  owner: "Owner",
  admin: "Manager",
  member: "Cashier",
};

async function token(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const t = data.session?.access_token;
  if (!t) throw new Error("Not signed in");
  return t;
}

export function TeamSection() {
  const { role } = useOrg();
  const [members, setMembers] = useState<Member[]>([]);
  const [seats, setSeats] = useState<{ used: number; max: number | null }>({ used: 0, max: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [credential, setCredential] = useState<NewCredential | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (role !== "owner") return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/team", { headers: { Authorization: `Bearer ${await token()}` } });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        if (cancelled) return;
        setMembers(json.members || []);
        setSeats(json.seats || { used: 0, max: null });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load team");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [role]);

  // The whole section is owner-only. Cashiers manage nothing here.
  if (role !== "owner") return null;

  async function reload() {
    const res = await fetch("/api/team", { headers: { Authorization: `Bearer ${await token()}` } });
    const json = await res.json();
    if (res.ok) {
      setMembers(json.members || []);
      setSeats(json.seats || { used: 0, max: null });
    }
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    setError(null);
    setNotice(null);
    setCredential(null);
    setCopied(false);
    try {
      const res = await fetch("/api/team", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${await token()}` },
        body: JSON.stringify({ email, name: name || undefined }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not add cashier");
      if (json.tempPassword) {
        setCredential({ email: json.email, name: json.name, tempPassword: json.tempPassword });
      } else {
        setNotice(json.message || `${json.email} was added to your team.`);
      }
      setEmail("");
      setName("");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add cashier");
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(m: Member) {
    if (!confirm(`Remove ${m.email} from your shop? They will lose access on their next sign-in. Their login itself is not deleted.`)) return;
    setError(null);
    try {
      const res = await fetch(`/api/team/${m.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${await token()}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not remove");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove");
    }
  }

  const atLimit = seats.max !== null && seats.used >= seats.max;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
          <Users className="w-5 h-5 text-green-600" />
          Team
        </h2>
        <span className="text-sm text-gray-500">
          {seats.max === null ? `${seats.used} users` : `${seats.used} of ${seats.max} seats`}
        </span>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        Give your cashiers their own login. Each person counts as one seat on your plan.
      </p>

      {error && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm mb-4">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="bg-green-50 border border-green-200 text-green-800 px-4 py-3 rounded-lg text-sm mb-4">
          {notice}
        </div>
      )}

      {/* One-time credential hand-off */}
      {credential && (
        <div className="bg-amber-50 border border-amber-300 rounded-lg p-4 mb-4">
          <p className="text-sm font-medium text-amber-900 mb-2">
            Login created for {credential.name || credential.email}. Give them these details now — the password is shown only once.
          </p>
          <div className="bg-white border border-amber-200 rounded-md p-3 font-mono text-sm text-gray-800 space-y-1">
            <div>email: {credential.email}</div>
            <div>password: {credential.tempPassword}</div>
          </div>
          <div className="flex items-center gap-3 mt-3">
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(`email: ${credential.email}\npassword: ${credential.tempPassword}`);
                setCopied(true);
              }}
              className="inline-flex items-center gap-1.5 text-sm text-amber-800 hover:text-amber-950 font-medium"
            >
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              {copied ? "Copied" : "Copy"}
            </button>
            <span className="text-xs text-amber-700">Ask them to change it after their first sign-in.</span>
          </div>
        </div>
      )}

      {/* Member list */}
      <div className="divide-y divide-gray-100 border border-gray-100 rounded-lg mb-5">
        {loading ? (
          <div className="px-4 py-6 text-center text-sm text-gray-400">Loading team...</div>
        ) : members.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-gray-500">Just you so far.</div>
        ) : (
          members.map((m) => (
            <div key={m.id} className="flex items-center justify-between px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">
                  {m.email}
                  {m.isSelf && <span className="text-gray-400 font-normal"> (you)</span>}
                </p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <Badge color={m.isOwner ? "green" : m.role === "admin" ? "blue" : "gray"}>
                  {ROLE_LABEL[m.role]}
                </Badge>
                {!m.isOwner && !m.isSelf && (
                  <button
                    type="button"
                    onClick={() => handleRemove(m)}
                    aria-label={`Remove ${m.email}`}
                    className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Add form */}
      {atLimit ? (
        <p className="text-sm text-amber-700">
          You have used all {seats.max} seats on your plan. Upgrade to add more cashiers.
        </p>
      ) : (
        <form onSubmit={handleAdd} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="cashier's email"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-green-500 focus:ring-1 focus:ring-green-500"
            />
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="name (optional)"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-green-500 focus:ring-1 focus:ring-green-500"
            />
          </div>
          <Button type="submit" loading={adding}>
            <UserPlus className="w-4 h-4 mr-1.5" />
            Add cashier
          </Button>
        </form>
      )}
    </div>
  );
}
