"use client";
// Per-partner admin detail at /admin/partners/[id].
//
// Shows partner record + edit form, referrals table, generate-payout form,
// payout history with mark-paid action.

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft, AlertCircle, Check, DollarSign, Calendar, Save, Trash2,
} from "lucide-react";

interface Partner {
  id: string;
  code: string;
  name: string;
  email: string;
  phone: string | null;
  commission_pct: number;
  status: "active" | "paused" | "terminated";
  notes: string | null;
  user_id: string | null;
  created_at: string;
}

interface Referral {
  id: string;
  orgName: string;
  plan: string | null;
  subscriptionStatus: string | null;
  status: "trialing" | "active" | "churned";
  referredAt: string;
  convertedAt: string | null;
  mrrZar: number;
}

interface Payout {
  id: string;
  period_start: string;
  period_end: string;
  total_referrals_active: number;
  total_mrr_zar: string | number;
  commission_pct: string | number;
  commission_amount_zar: string | number;
  paid_at: string | null;
  paid_reference: string | null;
  notes: string | null;
  created_at: string;
}

interface DetailData {
  partner: Partner;
  stats: {
    totalReferrals: number;
    activeReferrals: number;
    totalMrrZar: number;
    estimatedMonthlyCommissionZar: number;
    totalCommissionPaidZar: number;
    totalCommissionPendingZar: number;
  };
  referrals: Referral[];
  payouts: Payout[];
}

function fmtR(n: number | string): string {
  return `R${Number(n).toFixed(2)}`;
}
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" });
}
function firstOfThisMonth(): string {
  const d = new Date();
  d.setDate(1);
  return d.toLocaleDateString("en-CA");
}
function todayIso(): string {
  return new Date().toLocaleDateString("en-CA");
}

export default function PartnerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<DetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // Edit fields
  const [eStatus, setEStatus] = useState<"active" | "paused" | "terminated">("active");
  const [ePct, setEPct] = useState("20");
  const [eNotes, setENotes] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  // Generate payout
  const [pStart, setPStart] = useState(firstOfThisMonth());
  const [pEnd, setPEnd] = useState(todayIso());
  const [pNotes, setPNotes] = useState("");
  const [generating, setGenerating] = useState(false);

  // Mark paid form
  const [payRef, setPayRef] = useState("");
  const [showPayId, setShowPayId] = useState<string | null>(null);
  const [markingPaid, setMarkingPaid] = useState(false);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Not signed in");
      const res = await fetch(`/api/admin/partners/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setData(json);
      setEStatus(json.partner.status);
      setEPct(String(json.partner.commission_pct));
      setENotes(json.partner.notes || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  async function saveEdit() {
    setSavingEdit(true);
    setMsg(null);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      const res = await fetch(`/api/admin/partners/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          status: eStatus,
          commission_pct: parseFloat(ePct) || 20,
          notes: eNotes || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      setMsg("Partner details saved.");
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingEdit(false);
    }
  }

  async function generatePayout() {
    setGenerating(true);
    setMsg(null);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      const res = await fetch(`/api/admin/payouts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          partner_id: id,
          period_start: pStart,
          period_end: pEnd,
          notes: pNotes || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Generate failed");
      setMsg(`Payout generated for ${pStart} → ${pEnd}: ${fmtR(json.payout.commission_amount_zar)} pending.`);
      setPNotes("");
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Generate failed");
    } finally {
      setGenerating(false);
    }
  }

  async function markPaid(payoutId: string) {
    setMarkingPaid(true);
    setMsg(null);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      const res = await fetch(`/api/admin/payouts/${payoutId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ paid: true, paid_reference: payRef || undefined }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Mark failed");
      setMsg(`Payout marked paid${payRef ? ` (ref: ${payRef})` : ""}.`);
      setPayRef("");
      setShowPayId(null);
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Mark failed");
    } finally {
      setMarkingPaid(false);
    }
  }

  async function deletePayout(payoutId: string) {
    if (!confirm("Delete this payout snapshot? This won't refund any money — only removes the record.")) return;
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      const res = await fetch(`/api/admin/payouts/${payoutId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Delete failed");
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Delete failed");
    }
  }

  if (loading) return <div className="text-center py-12 text-gray-400">Loading...</div>;
  if (error || !data) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm flex items-start gap-2">
        <AlertCircle className="w-4 h-4 mt-0.5" />
        <span>{error || "No data"}</span>
      </div>
    );
  }

  const { partner, stats, referrals, payouts } = data;

  return (
    <div className="space-y-6">
      <Link href="/admin/partners" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900">
        <ArrowLeft className="w-4 h-4" /> All partners
      </Link>

      <div>
        <h1 className="text-2xl font-bold text-gray-900">{partner.name}</h1>
        <p className="text-sm text-gray-500 mt-1">
          <span className="font-mono">{partner.code}</span> · {partner.email}{partner.phone ? ` · ${partner.phone}` : ""}
          {partner.user_id ? <span className="ml-2"><Badge color="green">Linked to Tilify user</Badge></span>
            : <span className="ml-2"><Badge color="amber">Not linked yet</Badge></span>}
        </p>
      </div>

      {msg && (
        <div className="bg-blue-50 border border-blue-200 text-blue-800 px-4 py-3 rounded-lg text-sm">{msg}</div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="Active refs" value={stats.activeReferrals.toString()} sub={`${stats.totalReferrals} total`} />
        <Stat label="Their MRR" value={fmtR(stats.totalMrrZar)} sub="Across active" />
        <Stat label="Monthly commission" value={fmtR(stats.estimatedMonthlyCommissionZar)} sub={`${partner.commission_pct}% of MRR`} />
        <Stat label="Pending payout" value={fmtR(stats.totalCommissionPendingZar)} sub={`${fmtR(stats.totalCommissionPaidZar)} paid`} />
      </div>

      {/* Edit details */}
      <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-4">
        <h2 className="text-lg font-semibold text-gray-900">Partner details</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
            <select value={eStatus} onChange={(e) => setEStatus(e.target.value as Partner["status"])}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500">
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="terminated">Terminated</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Commission %</label>
            <input type="number" min="0" max="100" step="0.5" value={ePct} onChange={(e) => setEPct(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
            <input type="text" value={eNotes} onChange={(e) => setENotes(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500" />
          </div>
        </div>
        <Button onClick={saveEdit} loading={savingEdit}>
          <Save className="w-4 h-4 mr-1" /> Save changes
        </Button>
      </div>

      {/* Referrals table */}
      <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="font-semibold text-gray-900">Referred shops</h2>
          <span className="text-sm text-gray-500">{referrals.length}</span>
        </div>
        {referrals.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-gray-400">No referrals yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-5 py-3 font-medium text-gray-500">Shop</th>
                  <th className="text-left px-5 py-3 font-medium text-gray-500">Plan</th>
                  <th className="text-left px-5 py-3 font-medium text-gray-500">Sub status</th>
                  <th className="text-left px-5 py-3 font-medium text-gray-500">Ref status</th>
                  <th className="text-right px-5 py-3 font-medium text-gray-500">MRR</th>
                  <th className="text-left px-5 py-3 font-medium text-gray-500">Referred</th>
                  <th className="text-left px-5 py-3 font-medium text-gray-500">Converted</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {referrals.map((r) => (
                  <tr key={r.id}>
                    <td className="px-5 py-3 font-medium text-gray-900">{r.orgName}</td>
                    <td className="px-5 py-3 text-gray-600 capitalize">{r.plan || "—"}</td>
                    <td className="px-5 py-3 text-gray-600">{r.subscriptionStatus || "—"}</td>
                    <td className="px-5 py-3">
                      <Badge color={r.status === "active" ? "green" : r.status === "trialing" ? "blue" : "red"}>{r.status}</Badge>
                    </td>
                    <td className="px-5 py-3 text-right text-gray-900">{r.mrrZar > 0 ? fmtR(r.mrrZar) : "—"}</td>
                    <td className="px-5 py-3 text-gray-500">{fmtDate(r.referredAt)}</td>
                    <td className="px-5 py-3 text-gray-500">{fmtDate(r.convertedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Generate payout */}
      <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-4">
        <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
          <DollarSign className="w-5 h-5 text-green-600" /> Generate payout
        </h2>
        <p className="text-sm text-gray-500">
          Snapshots active referrals over the period and computes {partner.commission_pct}% commission.
          Creates a Pending payout you can mark Paid below once you&apos;ve actually wired the money.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-1">
              <Calendar className="w-3 h-3" /> Period start
            </label>
            <input type="date" value={pStart} onChange={(e) => setPStart(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-1">
              <Calendar className="w-3 h-3" /> Period end
            </label>
            <input type="date" value={pEnd} onChange={(e) => setPEnd(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes (optional)</label>
            <input type="text" value={pNotes} onChange={(e) => setPNotes(e.target.value)}
              placeholder="e.g. June 2026 cycle" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500" />
          </div>
        </div>
        <Button onClick={generatePayout} loading={generating}>Generate</Button>
      </div>

      {/* Payout history */}
      <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="font-semibold text-gray-900">Payout history</h2>
          <span className="text-sm text-gray-500">{payouts.length}</span>
        </div>
        {payouts.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-gray-400">No payouts yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-5 py-3 font-medium text-gray-500">Period</th>
                  <th className="text-right px-5 py-3 font-medium text-gray-500">Refs</th>
                  <th className="text-right px-5 py-3 font-medium text-gray-500">MRR</th>
                  <th className="text-right px-5 py-3 font-medium text-gray-500">Commission</th>
                  <th className="text-left px-5 py-3 font-medium text-gray-500">Status</th>
                  <th className="text-right px-5 py-3 font-medium text-gray-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {payouts.map((p) => (
                  <tr key={p.id}>
                    <td className="px-5 py-3 text-gray-700">
                      {fmtDate(p.period_start)} → {fmtDate(p.period_end)}
                    </td>
                    <td className="px-5 py-3 text-right text-gray-600">{p.total_referrals_active}</td>
                    <td className="px-5 py-3 text-right text-gray-600">{fmtR(p.total_mrr_zar)}</td>
                    <td className="px-5 py-3 text-right font-semibold text-gray-900">{fmtR(p.commission_amount_zar)}</td>
                    <td className="px-5 py-3">
                      {p.paid_at ? (
                        <div>
                          <Badge color="green">Paid {fmtDate(p.paid_at)}</Badge>
                          {p.paid_reference && <p className="text-xs text-gray-500 font-mono mt-1">{p.paid_reference}</p>}
                        </div>
                      ) : (
                        <Badge color="amber">Pending</Badge>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right">
                      {!p.paid_at && (
                        showPayId === p.id ? (
                          <div className="flex items-center gap-2 justify-end">
                            <input type="text" value={payRef} onChange={(e) => setPayRef(e.target.value)}
                              placeholder="Bank ref"
                              className="w-32 border border-gray-300 rounded px-2 py-1 text-xs" />
                            <button onClick={() => markPaid(p.id)} disabled={markingPaid}
                              className="text-xs px-2 py-1 bg-green-600 text-white rounded hover:bg-green-700">
                              <Check className="w-3 h-3 inline mr-0.5" /> Confirm
                            </button>
                            <button onClick={() => setShowPayId(null)}
                              className="text-xs text-gray-500 hover:text-gray-900">Cancel</button>
                          </div>
                        ) : (
                          <button onClick={() => { setShowPayId(p.id); setPayRef(""); }}
                            className="text-xs text-green-700 hover:underline">Mark paid</button>
                        )
                      )}
                      <button onClick={() => deletePayout(p.id)}
                        className="ml-2 text-xs text-gray-400 hover:text-red-600" title="Delete">
                        <Trash2 className="w-3.5 h-3.5 inline" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-4">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-lg font-bold text-gray-900">{value}</p>
      <p className="text-xs text-gray-400">{sub}</p>
    </div>
  );
}
