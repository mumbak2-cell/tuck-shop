"use client";
// Admin customer list at /admin/customers.
//
// Every organisation on the platform, newest first, with owner email, seat
// and location usage against plan limits, plan, status, and trial countdown.
// Platform admins can override subscription state per row via "Manage"
// (PATCH /api/admin/orgs/[id]); every change is logged to admin_org_overrides.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Building2, AlertCircle, Users, Clock, CheckCircle2, Lock, SlidersHorizontal,
} from "lucide-react";
import { ManageOrgModal } from "./manage-org-modal";

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  owners: string[];
  memberCount: number;
  locationCount: number;
  maxUsers: number | null;
  maxLocations: number | null;
  plan: string;
  status: "trialing" | "active" | "past_due" | "cancelled";
  trialEndsAt: string;
  trialDaysLeft: number | null;
  currentPeriodEnd: string | null;
  writable: boolean;
  referralCode: string | null;
  createdAt: string;
}

const STATUS_COLOR: Record<OrgRow["status"], string> = {
  active: "green",
  trialing: "blue",
  past_due: "amber",
  cancelled: "red",
};

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-ZA", {
    day: "numeric", month: "short", year: "numeric",
  });
}

/** "3 of 5" against a plan limit, or just the count when the plan is unlimited. */
function fmtUsage(count: number, limit: number | null): string {
  return limit === null ? `${count}` : `${count} of ${limit}`;
}

function TrialCell({ org }: { org: OrgRow }) {
  if (org.trialDaysLeft === null) {
    return <span className="text-gray-400">—</span>;
  }
  if (org.trialDaysLeft <= 0) {
    return (
      <span className="text-red-700 font-medium">
        Expired {fmtDate(org.trialEndsAt)}
      </span>
    );
  }
  const urgent = org.trialDaysLeft <= 3;
  return (
    <span className={urgent ? "text-amber-700 font-medium" : "text-gray-700"}>
      {org.trialDaysLeft} {org.trialDaysLeft === 1 ? "day" : "days"} left
    </span>
  );
}

export default function AdminCustomersPage() {
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [managing, setManaging] = useState<OrgRow | null>(null);

  const load = useCallback(async () => {
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Not signed in");
      const res = await fetch("/api/admin/orgs", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setOrgs(json.orgs || []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const lockedOut = orgs.filter((o) => !o.writable);
  const onTrial = orgs.filter((o) => o.status === "trialing");
  const paying = orgs.filter((o) => o.status === "active");

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <Building2 className="w-7 h-7 text-green-600" />
          Customers
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Every shop on Tilify. Use Manage to extend a trial, change a plan, or set status — each change is logged.
        </p>
      </div>

      {error && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm mb-4">
          <AlertCircle className="w-4 h-4 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {lockedOut.length > 0 && (
        <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-lg text-sm mb-4">
          <Lock className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            {lockedOut.length === 1
              ? `${lockedOut[0].name} cannot record sales — its trial lapsed or its subscription is not active.`
              : `${lockedOut.length} shops cannot record sales — their trials lapsed or their subscriptions are not active.`}
          </span>
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="font-semibold text-gray-900">All customers</h2>
          <span className="text-sm text-gray-500">{orgs.length}</span>
        </div>
        {loading ? (
          <div className="px-5 py-12 text-center text-gray-400 text-sm">Loading...</div>
        ) : orgs.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <Building2 className="w-10 h-10 text-gray-300 mx-auto mb-3" />
            <p className="text-sm text-gray-500">No organisations yet.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-5 py-3 font-medium text-gray-500">Shop</th>
                  <th className="text-left px-5 py-3 font-medium text-gray-500">Plan</th>
                  <th className="text-left px-5 py-3 font-medium text-gray-500">Status</th>
                  <th className="text-left px-5 py-3 font-medium text-gray-500">Trial</th>
                  <th className="text-right px-5 py-3 font-medium text-gray-500">Users</th>
                  <th className="text-right px-5 py-3 font-medium text-gray-500">Locations</th>
                  <th className="text-left px-5 py-3 font-medium text-gray-500">Referral</th>
                  <th className="text-left px-5 py-3 font-medium text-gray-500">Joined</th>
                  <th className="text-right px-5 py-3 font-medium text-gray-500">Manage</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {orgs.map((o) => (
                  <tr key={o.id} className={`hover:bg-gray-50 ${o.writable ? "" : "bg-red-50/40"}`}>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-gray-900">{o.name}</span>
                        {!o.writable && (
                          <span title="Cannot record sales — writes blocked by RLS">
                            <Lock className="w-3.5 h-3.5 text-red-600" />
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500">
                        {o.owners.length > 0 ? o.owners.join(", ") : "No owner on record"}
                      </p>
                    </td>
                    <td className="px-5 py-3 text-gray-700 capitalize">{o.plan}</td>
                    <td className="px-5 py-3">
                      <Badge color={STATUS_COLOR[o.status]}>{o.status.replace("_", " ")}</Badge>
                    </td>
                    <td className="px-5 py-3"><TrialCell org={o} /></td>
                    <td className="px-5 py-3 text-right text-gray-700">
                      {fmtUsage(o.memberCount, o.maxUsers)}
                    </td>
                    <td className="px-5 py-3 text-right text-gray-700">
                      {fmtUsage(o.locationCount, o.maxLocations)}
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-gray-600">
                      {o.referralCode || "—"}
                    </td>
                    <td className="px-5 py-3 text-gray-500 whitespace-nowrap">{fmtDate(o.createdAt)}</td>
                    <td className="px-5 py-3 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setManaging(o)}
                        aria-label={`Manage ${o.name}`}
                      >
                        <SlidersHorizontal className="w-4 h-4 mr-1.5" />
                        Manage
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {orgs.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-6">
          <Stat icon={Building2} label="Shops" value={orgs.length.toString()} sub={`${orgs.reduce((s, o) => s + o.locationCount, 0)} locations`} color="bg-green-600" />
          <Stat icon={CheckCircle2} label="Paying" value={paying.length.toString()} sub="Active subscriptions" color="bg-blue-600" />
          <Stat icon={Clock} label="On trial" value={onTrial.length.toString()} sub={`${onTrial.filter((o) => (o.trialDaysLeft ?? 0) > 0).length} still within window`} color="bg-amber-500" />
          <Stat icon={Users} label="Users" value={orgs.reduce((s, o) => s + o.memberCount, 0).toString()} sub="Across all shops" color="bg-emerald-600" />
        </div>
      )}

      {managing && (
        <ManageOrgModal
          org={managing}
          open={true}
          onClose={() => setManaging(null)}
          onSaved={load}
        />
      )}
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
