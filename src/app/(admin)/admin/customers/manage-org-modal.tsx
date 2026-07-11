"use client";
// Platform-admin editor for one org's subscription state. Four discrete
// actions, each saved on its own so every override maps to a clear audit
// entry: extend trial, change plan, change status, and a manual comp
// activation. Calls PATCH /api/admin/orgs/[id]; the parent reloads on save.

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { AlertCircle, ShieldCheck } from "lucide-react";

interface Org {
  id: string;
  name: string;
  plan: string;
  status: "trialing" | "active" | "past_due" | "cancelled";
  trialEndsAt: string;
  currentPeriodEnd: string | null;
}

/** ISO datetime -> YYYY-MM-DD for a <input type="date">. Empty string if null. */
function toDateInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : "";
}

async function token(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const t = data.session?.access_token;
  if (!t) throw new Error("Not signed in");
  return t;
}

const PLAN_OPTIONS = [
  { value: "starter", label: "Starter" },
  { value: "growth", label: "Growth" },
  { value: "pro", label: "Pro" },
];
const STATUS_OPTIONS = [
  { value: "trialing", label: "Trialing" },
  { value: "active", label: "Active" },
  { value: "past_due", label: "Past due" },
  { value: "cancelled", label: "Cancelled" },
];

export function ManageOrgModal({
  org,
  open,
  onClose,
  onSaved,
}: {
  org: Org;
  open: boolean;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [trialEnd, setTrialEnd] = useState(toDateInput(org.trialEndsAt));
  const [plan, setPlan] = useState(PLAN_OPTIONS.some((p) => p.value === org.plan) ? org.plan : "");
  const [status, setStatus] = useState<string>(org.status);
  const [compUntil, setCompUntil] = useState(toDateInput(org.currentPeriodEnd));

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function save(action: string, payload: Record<string, unknown>) {
    setBusy(action);
    setError(null);
    setOk(null);
    try {
      const res = await fetch(`/api/admin/orgs/${org.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${await token()}` },
        body: JSON.stringify({ ...payload, note: note.trim() || undefined }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setOk(json.unchanged ? "No change — values already match." : json.auditWarning || "Saved.");
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Manage ${org.name}`}>
      <div className="space-y-5">
        <p className="text-xs text-gray-500">
          These changes are applied directly and bypass the payment provider. Every change is logged
          against your admin account.
        </p>

        {error && (
          <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {ok && (
          <div className="bg-green-50 border border-green-200 text-green-800 px-3 py-2 rounded-lg text-sm">
            {ok}
          </div>
        )}

        {/* Shared reason — required by the API for a manual activation */}
        <Input
          label="Reason (recommended; required to activate manually)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. extended per WhatsApp agreement 11 Jul"
        />

        {/* Extend / set trial */}
        <div className="border-t border-gray-100 pt-4">
          <p className="text-sm font-medium text-gray-900 mb-2">Trial end date</p>
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <Input type="date" value={trialEnd} onChange={(e) => setTrialEnd(e.target.value)} />
            </div>
            <Button
              variant="secondary"
              loading={busy === "trial"}
              disabled={!trialEnd || !!busy}
              onClick={() => save("trial", { trialEndsAt: trialEnd })}
            >
              Save trial
            </Button>
          </div>
        </div>

        {/* Change plan */}
        <div className="border-t border-gray-100 pt-4">
          <p className="text-sm font-medium text-gray-900 mb-2">Plan tier</p>
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <Select
                options={PLAN_OPTIONS}
                placeholder="Select a plan…"
                value={plan}
                onChange={(e) => setPlan(e.target.value)}
              />
            </div>
            <Button
              variant="secondary"
              loading={busy === "plan"}
              disabled={!plan || !!busy}
              onClick={() => save("plan", { plan })}
            >
              Save plan
            </Button>
          </div>
          <p className="text-xs text-gray-400 mt-1">Changes seat & location limits immediately. Does not charge.</p>
        </div>

        {/* Change status */}
        <div className="border-t border-gray-100 pt-4">
          <p className="text-sm font-medium text-gray-900 mb-2">Subscription status</p>
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <Select options={STATUS_OPTIONS} value={status} onChange={(e) => setStatus(e.target.value)} />
            </div>
            <Button
              variant="secondary"
              loading={busy === "status"}
              disabled={!!busy}
              onClick={() => save("status", { status })}
            >
              Save status
            </Button>
          </div>
        </div>

        {/* Manual comp activation */}
        <div className="border-t border-gray-100 pt-4">
          <p className="text-sm font-medium text-gray-900 mb-2 flex items-center gap-1.5">
            <ShieldCheck className="w-4 h-4 text-amber-600" />
            Manual activation (comp / free access)
          </p>
          <p className="text-xs text-gray-500 mb-2">
            Sets status to <span className="font-medium">active</span> and the paid-through date below,
            granting access with no charge. Requires a reason above.
          </p>
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <Input
                label="Active until"
                type="date"
                value={compUntil}
                onChange={(e) => setCompUntil(e.target.value)}
              />
            </div>
            <Button
              variant="primary"
              loading={busy === "comp"}
              disabled={!compUntil || !!busy}
              onClick={() => save("comp", { status: "active", currentPeriodEnd: compUntil })}
            >
              Activate
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
