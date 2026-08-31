"use client";
// Admin partner list at /admin/partners.
//
// Shows every partner with quick stats (active referrals, MRR, pending
// commission). Inline form to create a new partner. Click row → detail.

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ShieldCheck, Plus, AlertCircle, Users, TrendingUp, DollarSign, Clock,
  ChevronRight, Inbox, Check, X,
} from "lucide-react";

interface ApplicationRow {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  requested_code: string | null;
  pitch: string | null;
  status: "pending" | "approved" | "rejected";
  created_at: string;
}

interface PartnerRow {
  id: string;
  code: string;
  name: string;
  email: string;
  phone: string | null;
  commission_pct: number;
  status: "active" | "paused" | "terminated";
  created_at: string;
  stats: {
    totalReferrals: number;
    activeReferrals: number;
    totalMrrZar: number;
    pendingCommissionZar: number;
  };
}

function fmtR(n: number): string {
  return `R${n.toFixed(2)}`;
}

export default function AdminPartnersPage() {
  const [partners, setPartners] = useState<PartnerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create-form state
  const [showForm, setShowForm] = useState(false);
  const [fCode, setFCode] = useState("");
  const [fName, setFName] = useState("");
  const [fEmail, setFEmail] = useState("");
  const [fPhone, setFPhone] = useState("");
  const [fPct, setFPct] = useState("20");
  const [fNotes, setFNotes] = useState("");
  const [creating, setCreating] = useState(false);
  const [createMsg, setCreateMsg] = useState<string | null>(null);

  // Applications review queue
  const [applications, setApplications] = useState<ApplicationRow[]>([]);
  const [appBusyId, setAppBusyId] = useState<string | null>(null);
  const [approveId, setApproveId] = useState<string | null>(null);
  const [approveCode, setApproveCode] = useState("");
  const [approvePct, setApprovePct] = useState("20");

  useEffect(() => {
    load();
    loadApplications();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function authToken(): Promise<string> {
    const { data: sess } = await supabase.auth.getSession();
    const t = sess.session?.access_token;
    if (!t) throw new Error("Not signed in");
    return t;
  }

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/partners", {
        headers: { Authorization: `Bearer ${await authToken()}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setPartners(json.partners || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  async function loadApplications() {
    try {
      const res = await fetch("/api/admin/partner-applications?status=pending", {
        headers: { Authorization: `Bearer ${await authToken()}` },
      });
      const json = await res.json();
      if (res.ok) setApplications(json.applications || []);
    } catch {
      // non-fatal — the queue just won't show
    }
  }

  async function decideApplication(
    id: string,
    decision: "approve" | "reject",
    extra?: { code?: string; commission_pct?: number; review_notes?: string }
  ) {
    setAppBusyId(id);
    setCreateMsg(null);
    try {
      const res = await fetch(`/api/admin/partner-applications/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${await authToken()}` },
        body: JSON.stringify({ decision, ...extra }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      setCreateMsg(decision === "approve" ? `Approved — partner "${json.partner?.code}" created.` : "Application rejected.");
      setApproveId(null);
      setApproveCode("");
      setApprovePct("20");
      await Promise.all([load(), loadApplications()]);
    } catch (e) {
      setCreateMsg(e instanceof Error ? e.message : "Failed");
    } finally {
      setAppBusyId(null);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateMsg(null);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Not signed in");
      const res = await fetch("/api/admin/partners", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          code: fCode.toUpperCase(),
          name: fName,
          email: fEmail,
          phone: fPhone || undefined,
          commission_pct: parseFloat(fPct) || 20,
          notes: fNotes || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Create failed");
      setCreateMsg(json.linkedUser
        ? `Partner created and linked to existing Tilify user ${fEmail}. They can sign in and see /partner immediately.`
        : `Partner created. They'll need to sign up at /signup with ${fEmail} — once they do, run the link SQL or invite them.`);
      setFCode(""); setFName(""); setFEmail(""); setFPhone(""); setFPct("20"); setFNotes("");
      setShowForm(false);
      await load();
    } catch (e) {
      setCreateMsg(e instanceof Error ? e.message : "Create failed");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <div className="flex items-start justify-between flex-wrap gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <ShieldCheck className="w-7 h-7 text-green-600" />
            Partners
          </h1>
          <p className="text-sm text-gray-500 mt-1">Create partners, review referrals, generate and reconcile payouts.</p>
        </div>
        <Button onClick={() => setShowForm((v) => !v)}>
          <Plus className="w-4 h-4 mr-1" /> {showForm ? "Cancel" : "New partner"}
        </Button>
      </div>

      {error && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm mb-4">
          <AlertCircle className="w-4 h-4 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {createMsg && (
        <div className="bg-green-50 border border-green-200 text-green-800 px-4 py-3 rounded-lg text-sm mb-4">
          {createMsg}
        </div>
      )}

      {/* Applications review queue */}
      {applications.length > 0 && (
        <div className="bg-white border border-amber-200 rounded-2xl overflow-hidden mb-6">
          <div className="px-5 py-4 border-b border-amber-200 bg-amber-50 flex items-center gap-2">
            <Inbox className="w-4 h-4 text-amber-700" />
            <h2 className="font-semibold text-amber-900">Applications awaiting review</h2>
            <span className="text-sm text-amber-700">{applications.length}</span>
          </div>
          <div className="divide-y divide-gray-100">
            {applications.map((a) => (
              <div key={a.id} className="px-5 py-4">
                <div className="flex items-start justify-between flex-wrap gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-gray-900">
                      {a.name}
                      {a.requested_code && (
                        <span className="ml-2 font-mono text-xs text-gray-500">wants {a.requested_code}</span>
                      )}
                    </p>
                    <p className="text-xs text-gray-500">
                      {a.email}{a.phone ? ` · ${a.phone}` : ""} · {new Date(a.created_at).toLocaleDateString("en-ZA")}
                    </p>
                    {a.pitch && <p className="text-sm text-gray-600 mt-1 max-w-2xl">{a.pitch}</p>}
                  </div>
                  {approveId === a.id ? (
                    <div className="flex flex-col gap-2 items-end">
                      <input
                        type="text"
                        value={approveCode}
                        onChange={(e) => setApproveCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 32))}
                        placeholder="Referral code"
                        className="w-40 border border-gray-300 rounded px-2 py-1 text-xs font-mono"
                      />
                      <input
                        type="number" min="0" max="100" step="0.5"
                        value={approvePct}
                        onChange={(e) => setApprovePct(e.target.value)}
                        placeholder="Commission %"
                        className="w-40 border border-gray-300 rounded px-2 py-1 text-xs"
                      />
                      <div className="flex gap-2">
                        <button
                          disabled={appBusyId === a.id}
                          onClick={() => decideApplication(a.id, "approve", { code: approveCode || a.requested_code || "", commission_pct: parseFloat(approvePct) || 20 })}
                          className="text-xs px-2 py-1 bg-green-600 text-white rounded hover:bg-green-700"
                        >
                          Confirm approve
                        </button>
                        <button onClick={() => setApproveId(null)} className="text-xs text-gray-500 hover:text-gray-900">
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-2 shrink-0">
                      <button
                        disabled={appBusyId === a.id}
                        onClick={() => { setApproveId(a.id); setApproveCode(a.requested_code || ""); setApprovePct("20"); }}
                        className="inline-flex items-center gap-1 text-xs px-2 py-1 bg-green-600 text-white rounded hover:bg-green-700"
                      >
                        <Check className="w-3 h-3" /> Approve
                      </button>
                      <button
                        disabled={appBusyId === a.id}
                        onClick={() => {
                          const notes = window.prompt("Reason for rejecting (optional, not emailed):") ?? undefined;
                          decideApplication(a.id, "reject", { review_notes: notes });
                        }}
                        className="inline-flex items-center gap-1 text-xs px-2 py-1 border border-gray-300 text-gray-600 rounded hover:bg-gray-50"
                      >
                        <X className="w-3 h-3" /> Reject
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Inline create form */}
      {showForm && (
        <form onSubmit={handleCreate} className="bg-white border border-gray-200 rounded-2xl p-6 mb-6 space-y-4">
          <h2 className="text-lg font-semibold text-gray-900">New partner</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Referral code">
              <input type="text" value={fCode} onChange={(e) => setFCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 32))}
                required placeholder="JIMMY2026" className="input font-mono tracking-wider" />
            </Field>
            <Field label="Commission %">
              <input type="number" min="0" max="100" step="0.5" value={fPct}
                onChange={(e) => setFPct(e.target.value)} required className="input" />
            </Field>
            <Field label="Full name">
              <input type="text" value={fName} onChange={(e) => setFName(e.target.value)} required className="input" />
            </Field>
            <Field label="Email">
              <input type="email" value={fEmail} onChange={(e) => setFEmail(e.target.value)} required className="input" />
            </Field>
            <Field label="Phone (optional)">
              <input type="text" value={fPhone} onChange={(e) => setFPhone(e.target.value)} placeholder="+265..." className="input" />
            </Field>
            <Field label="Notes (optional)">
              <input type="text" value={fNotes} onChange={(e) => setFNotes(e.target.value)} placeholder="Context, region, history..." className="input" />
            </Field>
          </div>
          <div className="flex gap-3">
            <Button type="submit" loading={creating}>Create partner</Button>
            <button type="button" onClick={() => setShowForm(false)} className="text-sm text-gray-500 hover:text-gray-900">
              Cancel
            </button>
          </div>
          <style jsx>{`
            .input {
              width: 100%;
              border: 1px solid rgb(209, 213, 219);
              border-radius: 0.5rem;
              padding: 0.5rem 0.75rem;
              font-size: 0.875rem;
            }
            .input:focus { outline: none; border-color: rgb(34, 197, 94); box-shadow: 0 0 0 1px rgb(34, 197, 94); }
          `}</style>
        </form>
      )}

      {/* Partner list */}
      <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="font-semibold text-gray-900">All partners</h2>
          <span className="text-sm text-gray-500">{partners.length}</span>
        </div>
        {loading ? (
          <div className="px-5 py-12 text-center text-gray-400 text-sm">Loading...</div>
        ) : partners.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <ShieldCheck className="w-10 h-10 text-gray-300 mx-auto mb-3" />
            <p className="text-sm text-gray-500">No partners yet. Click <strong>New partner</strong> to create one.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-5 py-3 font-medium text-gray-500">Partner</th>
                  <th className="text-left px-5 py-3 font-medium text-gray-500">Code</th>
                  <th className="text-right px-5 py-3 font-medium text-gray-500">Active / Total</th>
                  <th className="text-right px-5 py-3 font-medium text-gray-500">Their MRR</th>
                  <th className="text-right px-5 py-3 font-medium text-gray-500">Pending</th>
                  <th className="text-left px-5 py-3 font-medium text-gray-500">Status</th>
                  <th className="px-3 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {partners.map((p) => (
                  <tr key={p.id} className="hover:bg-gray-50">
                    <td className="px-5 py-3">
                      <Link href={`/admin/partners/${p.id}`} className="font-medium text-gray-900 hover:text-green-700">
                        {p.name}
                      </Link>
                      <p className="text-xs text-gray-500">{p.email}{p.phone ? ` · ${p.phone}` : ""}</p>
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-gray-700">{p.code}</td>
                    <td className="px-5 py-3 text-right text-gray-700">
                      {p.stats.activeReferrals} / {p.stats.totalReferrals}
                    </td>
                    <td className="px-5 py-3 text-right text-gray-900">{fmtR(p.stats.totalMrrZar)}</td>
                    <td className="px-5 py-3 text-right font-semibold text-amber-700">
                      {p.stats.pendingCommissionZar > 0 ? fmtR(p.stats.pendingCommissionZar) : "—"}
                    </td>
                    <td className="px-5 py-3">
                      <Badge color={p.status === "active" ? "green" : p.status === "paused" ? "amber" : "red"}>
                        {p.status}
                      </Badge>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <Link href={`/admin/partners/${p.id}`} className="text-gray-400 hover:text-gray-700">
                        <ChevronRight className="w-4 h-4" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Aggregate cards */}
      {partners.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-6">
          <Stat icon={Users} label="Partners" value={partners.length.toString()} sub={`${partners.filter((p) => p.status === "active").length} active`} color="bg-green-600" />
          <Stat icon={TrendingUp} label="Total MRR" value={fmtR(partners.reduce((s, p) => s + p.stats.totalMrrZar, 0))} sub="Across all referrals" color="bg-blue-600" />
          <Stat icon={DollarSign} label="Pending payouts" value={fmtR(partners.reduce((s, p) => s + p.stats.pendingCommissionZar, 0))} sub="Across all partners" color="bg-amber-500" />
          <Stat icon={Clock} label="Active referrals" value={partners.reduce((s, p) => s + p.stats.activeReferrals, 0).toString()} sub={`${partners.reduce((s, p) => s + p.stats.totalReferrals, 0)} ever`} color="bg-emerald-600" />
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {children}
    </div>
  );
}

function Stat({ icon: Icon, label, value, sub, color }: {
  icon: React.ElementType; label: string; value: string; sub: string; color: string;
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-4">
      <div className="flex items-center gap-3">
        <div className={`p-2.5 rounded-lg ${color}`}><Icon className="w-5 h-5 text-white" /></div>
        <div className="min-w-0">
          <p className="text-xs text-gray-500">{label}</p>
          <p className="text-lg font-bold text-gray-900 truncate">{value}</p>
          <p className="text-xs text-gray-400 truncate">{sub}</p>
        </div>
      </div>
    </div>
  );
}
