"use client";
// Partner self-service dashboard at /partner.
//
// Shows the partner their referral code + share link, aggregate stats
// (active referrals, MRR generated, commission paid/pending), the full
// list of referred orgs with their statuses, and payout history.
//
// Backed by /api/partners/me which joins through admin client.

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Handshake, Copy, Check, ExternalLink, AlertCircle, TrendingUp,
  Users, DollarSign, Clock, LogOut,
} from "lucide-react";

interface PartnerData {
  partner: {
    id: string;
    code: string;
    name: string;
    email: string;
    phone: string | null;
    commission_pct: number;
    status: "active" | "paused" | "terminated";
    created_at: string;
  } | null;
  stats: {
    totalReferrals: number;
    activeReferrals: number;
    trialingReferrals: number;
    churnedReferrals: number;
    totalMrrZar: number;
    estimatedMonthlyCommissionZar: number;
    totalCommissionPaidZar: number;
    totalCommissionPendingZar: number;
  };
  referrals: Array<{
    id: string;
    orgName: string;
    plan: string | null;
    subscriptionStatus: string | null;
    status: "trialing" | "active" | "churned";
    referredAt: string;
    convertedAt: string | null;
    mrrZar: number;
  }>;
  payouts: Array<{
    id: string;
    period_start: string;
    period_end: string;
    total_referrals_active: number;
    total_mrr_zar: number;
    commission_pct: number;
    commission_amount_zar: number;
    paid_at: string | null;
    paid_reference: string | null;
    notes: string | null;
    created_at: string;
  }>;
}

function fmtR(amount: number): string {
  return `R${amount.toFixed(2)}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" });
}

export default function PartnerDashboard() {
  const [data, setData] = useState<PartnerData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        setError("not_signed_in");
        setLoading(false);
        return;
      }
      const res = await fetch("/api/partners/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const json = (await res.json()) as PartnerData;
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  function copyText(text: string, target: "code" | "link") {
    try {
      navigator.clipboard.writeText(text);
      if (target === "code") { setCopiedCode(true); setTimeout(() => setCopiedCode(false), 2000); }
      if (target === "link") { setCopiedLink(true); setTimeout(() => setCopiedLink(false), 2000); }
    } catch {
      // ignore
    }
  }

  if (loading) {
    return <div className="text-center py-12 text-gray-400">Loading...</div>;
  }

  if (error === "not_signed_in") {
    return (
      <div className="bg-white border border-gray-200 rounded-2xl p-8 max-w-md mx-auto text-center">
        <Handshake className="w-10 h-10 text-green-600 mx-auto mb-3" />
        <h1 className="text-xl font-bold text-gray-900 mb-2">Partner sign-in</h1>
        <p className="text-sm text-gray-500 mb-6">
          Sign in with the email MK Global registered for you as a Tilify partner.
        </p>
        <Link href="/login">
          <Button className="w-full">Sign in</Button>
        </Link>
        <p className="text-xs text-gray-400 mt-4">
          Not a partner yet?{" "}
          <Link href="/partner/apply" className="text-green-700 hover:underline">Apply here</Link>
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-xl p-4 max-w-lg mx-auto flex items-start gap-3">
        <AlertCircle className="w-5 h-5 text-red-600 mt-0.5" />
        <div className="text-sm text-red-700">
          <p className="font-semibold mb-1">Could not load partner data</p>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (data && !data.partner) {
    return (
      <div className="bg-white border border-gray-200 rounded-2xl p-8 max-w-md mx-auto text-center">
        <Handshake className="w-10 h-10 text-gray-400 mx-auto mb-3" />
        <h1 className="text-xl font-bold text-gray-900 mb-2">Not a partner yet</h1>
        <p className="text-sm text-gray-500 mb-6">
          This account isn&apos;t registered as a Tilify partner yet.
        </p>
        <Link href="/partner/apply">
          <Button className="w-full">Apply to become a partner</Button>
        </Link>
        <Link href="/dashboard">
          <Button variant="secondary" className="w-full mt-2">Back to shop dashboard</Button>
        </Link>
        <p className="text-xs text-gray-400 mt-4">
          Questions? <a href="mailto:partners@mkglobal.co.za" className="text-green-700 underline">partners@mkglobal.co.za</a>
        </p>
      </div>
    );
  }

  if (!data) return null;

  const { partner, stats, referrals, payouts } = data;
  if (!partner) return null;
  const siteUrl = typeof window !== "undefined" ? window.location.origin : "https://tilify.mkglobal.co.za";
  const shareUrl = `${siteUrl}/signup?ref=${partner.code}`;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Handshake className="w-7 h-7 text-green-600" />
            Partner dashboard
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {partner.name} · {partner.commission_pct}% recurring commission
            {partner.status !== "active" && (
              <Badge color="amber"><span className="ml-1">{partner.status}</span></Badge>
            )}
          </p>
        </div>
        <button
          onClick={async () => { await supabase.auth.signOut(); window.location.href = "/login"; }}
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900"
        >
          <LogOut className="w-4 h-4" /> Sign out
        </button>
      </div>

      {/* Code + share link */}
      <div className="bg-gradient-to-br from-green-50 to-emerald-50 border border-green-200 rounded-2xl p-6">
        <p className="text-xs font-medium text-green-800 uppercase tracking-wide mb-2">Your referral code</p>
        <div className="flex items-center gap-3 flex-wrap">
          <code className="text-3xl font-mono font-bold tracking-wider text-green-900 bg-white px-4 py-2 rounded-lg border border-green-200">
            {partner.code}
          </code>
          <button
            onClick={() => copyText(partner.code, "code")}
            className="inline-flex items-center gap-1 text-sm text-green-700 hover:text-green-900 font-medium"
          >
            {copiedCode ? <><Check className="w-4 h-4" /> Copied</> : <><Copy className="w-4 h-4" /> Copy code</>}
          </button>
        </div>

        <div className="mt-4 pt-4 border-t border-green-200">
          <p className="text-xs font-medium text-green-800 uppercase tracking-wide mb-2">Share link</p>
          <div className="flex items-center gap-3 flex-wrap">
            <code className="text-sm font-mono text-gray-700 bg-white px-3 py-2 rounded-lg border border-green-200 truncate max-w-md">
              {shareUrl}
            </code>
            <button
              onClick={() => copyText(shareUrl, "link")}
              className="inline-flex items-center gap-1 text-sm text-green-700 hover:text-green-900 font-medium"
            >
              {copiedLink ? <><Check className="w-4 h-4" /> Copied</> : <><Copy className="w-4 h-4" /> Copy link</>}
            </button>
          </div>
          <p className="text-xs text-green-700 mt-2">
            Send this link by WhatsApp or email. The Referral Code field on signup auto-fills with your code.
          </p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={Users}
          label="Active referrals"
          value={stats.activeReferrals.toString()}
          sub={`${stats.totalReferrals} total, ${stats.trialingReferrals} trialing`}
          color="bg-green-600"
        />
        <StatCard
          icon={TrendingUp}
          label="Their MRR"
          value={fmtR(stats.totalMrrZar)}
          sub="Sum of active subscriptions"
          color="bg-blue-600"
        />
        <StatCard
          icon={DollarSign}
          label="Your monthly commission"
          value={fmtR(stats.estimatedMonthlyCommissionZar)}
          sub={`${partner.commission_pct}% of MRR (estimate)`}
          color="bg-emerald-600"
        />
        <StatCard
          icon={Clock}
          label="Pending payout"
          value={fmtR(stats.totalCommissionPendingZar)}
          sub={`${fmtR(stats.totalCommissionPaidZar)} paid to date`}
          color="bg-amber-500"
        />
      </div>

      {/* Referrals list */}
      <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="font-semibold text-gray-900">Referred shops</h2>
          <span className="text-sm text-gray-500">{referrals.length}</span>
        </div>
        {referrals.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <ExternalLink className="w-10 h-10 text-gray-300 mx-auto mb-3" />
            <p className="text-sm text-gray-500">
              No referrals yet. Share your link or code to start earning.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-5 py-3 font-medium text-gray-500">Shop</th>
                  <th className="text-left px-5 py-3 font-medium text-gray-500">Plan</th>
                  <th className="text-left px-5 py-3 font-medium text-gray-500">Status</th>
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
                    <td className="px-5 py-3">
                      <Badge color={r.status === "active" ? "green" : r.status === "trialing" ? "blue" : "red"}>
                        {r.status}
                      </Badge>
                    </td>
                    <td className="px-5 py-3 text-right font-medium text-gray-900">
                      {r.mrrZar > 0 ? fmtR(r.mrrZar) : "—"}
                    </td>
                    <td className="px-5 py-3 text-gray-500">{fmtDate(r.referredAt)}</td>
                    <td className="px-5 py-3 text-gray-500">{fmtDate(r.convertedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Payouts */}
      <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="font-semibold text-gray-900">Payout history</h2>
          <span className="text-sm text-gray-500">{payouts.length}</span>
        </div>
        {payouts.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <DollarSign className="w-10 h-10 text-gray-300 mx-auto mb-3" />
            <p className="text-sm text-gray-500">
              No payouts processed yet. MK Global generates payouts monthly.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-5 py-3 font-medium text-gray-500">Period</th>
                  <th className="text-right px-5 py-3 font-medium text-gray-500">Active refs</th>
                  <th className="text-right px-5 py-3 font-medium text-gray-500">Their MRR</th>
                  <th className="text-right px-5 py-3 font-medium text-gray-500">Commission</th>
                  <th className="text-left px-5 py-3 font-medium text-gray-500">Paid</th>
                  <th className="text-left px-5 py-3 font-medium text-gray-500">Reference</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {payouts.map((p) => (
                  <tr key={p.id}>
                    <td className="px-5 py-3 text-gray-700">
                      {fmtDate(p.period_start)} → {fmtDate(p.period_end)}
                    </td>
                    <td className="px-5 py-3 text-right text-gray-600">{p.total_referrals_active}</td>
                    <td className="px-5 py-3 text-right text-gray-600">{fmtR(Number(p.total_mrr_zar))}</td>
                    <td className="px-5 py-3 text-right font-semibold text-gray-900">
                      {fmtR(Number(p.commission_amount_zar))}
                    </td>
                    <td className="px-5 py-3">
                      {p.paid_at ? (
                        <Badge color="green">Paid {fmtDate(p.paid_at)}</Badge>
                      ) : (
                        <Badge color="amber">Pending</Badge>
                      )}
                    </td>
                    <td className="px-5 py-3 text-gray-500 text-xs font-mono">{p.paid_reference || "—"}</td>
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

function StatCard({ icon: Icon, label, value, sub, color }: {
  icon: React.ElementType; label: string; value: string; sub: string; color: string;
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-4">
      <div className="flex items-center gap-3">
        <div className={`p-2.5 rounded-lg ${color}`}>
          <Icon className="w-5 h-5 text-white" />
        </div>
        <div className="min-w-0">
          <p className="text-xs text-gray-500">{label}</p>
          <p className="text-lg font-bold text-gray-900 truncate">{value}</p>
          <p className="text-xs text-gray-400 truncate">{sub}</p>
        </div>
      </div>
    </div>
  );
}
