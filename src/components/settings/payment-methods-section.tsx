"use client";
// Payment methods the till offers. Until now these were only created once by
// the /setup wizard with no way to change them afterwards, so a shop that
// started taking EFT (or stopped taking a card machine) was stuck.
//
// The `kind` drives POS behaviour, not just the icon: "cash" asks for the
// amount tendered and works out change, and "credit" requires picking the
// customer who owes. Everything else is recorded as a straight payment.

import { useEffect, useState } from "react";
import { db } from "@/lib/supabase";
import { useOrg } from "@/lib/org-context";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { CreditCard, Plus, Pencil, Power, Trash2 } from "lucide-react";
import type { PaymentKind } from "@/lib/payment-presets";

interface PaymentMethod {
  id: string;
  name: string;
  kind: PaymentKind;
  active: boolean;
  sort_order: number;
}

const KIND_LABEL: Record<PaymentKind, string> = {
  cash: "Cash — asks for amount tendered, works out change",
  card: "Card machine",
  mobile_money: "Mobile money",
  eft: "EFT / bank transfer",
  credit: "Credit account — customer pays later",
  other: "Other",
};

const KIND_SHORT: Record<PaymentKind, string> = {
  cash: "Cash",
  card: "Card",
  mobile_money: "Mobile money",
  eft: "EFT",
  credit: "Credit",
  other: "Other",
};

export function PaymentMethodsSection() {
  const { can } = useOrg();
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<PaymentMethod | null>(null);
  const [formName, setFormName] = useState("");
  const [formKind, setFormKind] = useState<PaymentKind>("cash");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    const { data } = await db
      .from("payment_methods")
      .select("id, name, kind, active, sort_order")
      .order("sort_order")
      .order("name");
    setMethods((data as PaymentMethod[]) || []);
    setLoading(false);
  }

  // Shop configuration — owners and managers, not cashiers.
  if (!can("manage_payment_methods")) return null;

  function openNew() {
    setEditing(null);
    setFormName("");
    setFormKind("cash");
    setError(null);
    setShowForm(true);
  }

  function openEdit(m: PaymentMethod) {
    setEditing(m);
    setFormName(m.name);
    setFormKind(m.kind);
    setError(null);
    setShowForm(true);
  }

  async function save() {
    const name = formName.trim();
    if (!name) return;
    setSaving(true);
    setError(null);
    const nextOrder = methods.length ? Math.max(...methods.map((m) => m.sort_order ?? 0)) + 1 : 0;
    const res = editing
      ? await db.from("payment_methods").update({ name, kind: formKind }).eq("id", editing.id)
      : await db.from("payment_methods").insert({ name, kind: formKind, sort_order: nextOrder });
    setSaving(false);
    if (res.error) {
      setError(res.error.message || "Could not save payment method");
      return;
    }
    setShowForm(false);
    load();
  }

  async function toggleActive(m: PaymentMethod) {
    const { error: err } = await db
      .from("payment_methods")
      .update({ active: !m.active })
      .eq("id", m.id);
    if (err) {
      setError(err.message);
      return;
    }
    load();
  }

  async function remove(m: PaymentMethod) {
    if (
      !confirm(
        `Remove "${m.name}" from the till? Past sales keep the name they were recorded with — only the button disappears.\n\nIf you might use it again, hide it instead.`
      )
    )
      return;
    const { error: err } = await db.from("payment_methods").delete().eq("id", m.id);
    if (err) {
      setError(err.message);
      return;
    }
    load();
  }

  const activeCount = methods.filter((m) => m.active).length;
  const inputClass =
    "w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500";

  return (
    <CollapsibleSection title="Payment Methods" icon={CreditCard}>
      <div className="flex items-start justify-between gap-4 mb-4">
        <p className="text-sm text-gray-500">
          The buttons your cashiers see at checkout. Hide one to take it off the till without losing
          its history.
        </p>
        <Button onClick={openNew}>
          <Plus className="w-4 h-4 mr-1.5" /> Add
        </Button>
      </div>

      {error && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">
          {error}
        </div>
      )}

      {activeCount === 0 && !loading && (
        <div className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-4">
          No active payment methods — cashiers won&apos;t be able to complete a sale until you add one.
        </div>
      )}

      {showForm && (
        <div className="border border-gray-200 rounded-lg p-4 mb-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Name *</label>
              <input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g. EFT, Airtel Money, Yoco"
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Type *</label>
              <select
                value={formKind}
                onChange={(e) => setFormKind(e.target.value as PaymentKind)}
                className={`${inputClass} bg-white`}
              >
                {(Object.keys(KIND_LABEL) as PaymentKind[]).map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="text-xs text-gray-500">
            The type changes how the till behaves — pick <span className="font-medium">Cash</span> for
            money in the drawer, or <span className="font-medium">Credit account</span> when the
            customer pays later.
          </p>
          <div className="flex gap-3">
            <Button onClick={save} loading={saving} disabled={!formName.trim()}>
              {editing ? "Save changes" : "Add method"}
            </Button>
            <Button variant="secondary" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-sm text-gray-400 py-4 text-center">Loading…</div>
      ) : methods.length === 0 ? (
        <div className="text-sm text-gray-400 py-4 text-center">No payment methods yet.</div>
      ) : (
        <div className="divide-y divide-gray-100 border border-gray-100 rounded-lg">
          {methods.map((m) => (
            <div key={m.id} className="flex items-center justify-between px-4 py-3">
              <div className="min-w-0">
                <p className={`text-sm font-medium truncate ${m.active ? "text-gray-900" : "text-gray-400"}`}>
                  {m.name}
                  {!m.active && <span className="ml-2 text-xs font-normal">(hidden)</span>}
                </p>
                <p className="text-xs text-gray-500">{KIND_SHORT[m.kind] ?? m.kind}</p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Tooltip label="Edit">
                  <button onClick={() => openEdit(m)} aria-label={`Edit ${m.name}`} className="p-1.5 text-gray-400 hover:text-green-700 rounded">
                    <Pencil className="w-4 h-4" />
                  </button>
                </Tooltip>
                <Tooltip label={m.active ? "Hide from till" : "Show on till"}>
                  <button onClick={() => toggleActive(m)} aria-label={`Toggle ${m.name}`} className="p-1.5 text-gray-400 hover:text-amber-600 rounded">
                    <Power className="w-4 h-4" />
                  </button>
                </Tooltip>
                <Tooltip label="Remove">
                  <button onClick={() => remove(m)} aria-label={`Remove ${m.name}`} className="p-1.5 text-gray-400 hover:text-red-600 rounded">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </Tooltip>
              </div>
            </div>
          ))}
        </div>
      )}
    </CollapsibleSection>
  );
}
