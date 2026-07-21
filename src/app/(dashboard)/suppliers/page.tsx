"use client";
// Supplier master list (migration 050). Owners/managers add, edit, deactivate
// and remove suppliers; the Receive Stock and WMS Purchase Order forms pick
// from this list. Mirrors the Locations page in shape and permissions.

import { useEffect, useState } from "react";
import { db } from "@/lib/supabase";
import { useOrg } from "@/lib/org-context";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { Truck, Plus, Pencil, Power, Trash2 } from "lucide-react";

interface Supplier {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
  active: boolean;
}

export default function SuppliersPage() {
  const { role } = useOrg();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Supplier | null>(null);
  const [formName, setFormName] = useState("");
  const [formPhone, setFormPhone] = useState("");
  const [formEmail, setFormEmail] = useState("");
  const [formNotes, setFormNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canManage = role === "owner" || role === "admin";

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    const { data } = await db
      .from("suppliers")
      .select("id, name, phone, email, notes, active")
      .order("active", { ascending: false })
      .order("name");
    setSuppliers((data as Supplier[]) || []);
    setLoading(false);
  }

  function openNew() {
    setEditing(null);
    setFormName("");
    setFormPhone("");
    setFormEmail("");
    setFormNotes("");
    setError(null);
    setShowForm(true);
  }

  function openEdit(s: Supplier) {
    setEditing(s);
    setFormName(s.name);
    setFormPhone(s.phone || "");
    setFormEmail(s.email || "");
    setFormNotes(s.notes || "");
    setError(null);
    setShowForm(true);
  }

  async function save() {
    const name = formName.trim();
    if (!name) return;
    setSaving(true);
    setError(null);
    const payload = {
      name,
      phone: formPhone.trim() || null,
      email: formEmail.trim() || null,
      notes: formNotes.trim() || null,
    };
    const res = editing
      ? await db.from("suppliers").update(payload).eq("id", editing.id)
      : await db.from("suppliers").insert(payload);
    setSaving(false);
    if (res.error) {
      // 23505 = the org already has a supplier with this name.
      setError(
        res.error.code === "23505"
          ? `You already have a supplier called “${name}”.`
          : res.error.message || "Could not save supplier"
      );
      return;
    }
    setShowForm(false);
    load();
  }

  async function toggleActive(s: Supplier) {
    await db.from("suppliers").update({ active: !s.active }).eq("id", s.id);
    load();
  }

  async function remove(s: Supplier) {
    if (
      !confirm(
        `Remove ${s.name} from your supplier list? Past deliveries keep their supplier name — only the list changes.`
      )
    )
      return;
    const { error: delErr } = await db.from("suppliers").delete().eq("id", s.id);
    if (delErr) {
      alert("Could not remove supplier: " + delErr.message);
      return;
    }
    load();
  }

  const inputClass =
    "w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500";

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Truck className="w-7 h-7 text-green-600" />
            Suppliers
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            The people you buy stock from. These appear when you receive stock.
          </p>
        </div>
        {canManage && (
          <Button onClick={openNew}>
            <Plus className="w-4 h-4 mr-2" /> Add supplier
          </Button>
        )}
      </div>

      {showForm && (
        <div className="bg-white border border-gray-200 rounded-xl p-5 mb-6 space-y-3">
          <h2 className="text-sm font-semibold text-gray-900">
            {editing ? `Edit ${editing.name}` : "New supplier"}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Name *</label>
              <input value={formName} onChange={(e) => setFormName(e.target.value)} className={inputClass} placeholder="e.g. Makro" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Phone</label>
              <input value={formPhone} onChange={(e) => setFormPhone(e.target.value)} className={inputClass} placeholder="e.g. 097 123 4567" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Email</label>
              <input value={formEmail} onChange={(e) => setFormEmail(e.target.value)} className={inputClass} placeholder="optional" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Notes</label>
              <input value={formNotes} onChange={(e) => setFormNotes(e.target.value)} className={inputClass} placeholder="e.g. delivers Tuesdays" />
            </div>
          </div>
          {error && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
          )}
          <div className="flex gap-3">
            <Button onClick={save} loading={saving} disabled={!formName.trim()}>
              {editing ? "Save changes" : "Add supplier"}
            </Button>
            <Button variant="secondary" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading…</div>
      ) : suppliers.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <Truck className="w-12 h-12 mx-auto mb-3 opacity-50" />
          <p>No suppliers yet.</p>
          <p className="text-sm mt-1">Add the shops and wholesalers you buy from.</p>
        </div>
      ) : (
        <div className="divide-y divide-gray-100 border border-gray-200 rounded-xl bg-white">
          {suppliers.map((s) => (
            <div key={s.id} className="flex items-center justify-between px-4 py-3">
              <div className="min-w-0">
                <p className={`text-sm font-medium truncate ${s.active ? "text-gray-900" : "text-gray-400"}`}>
                  {s.name}
                  {!s.active && <span className="ml-2 text-xs font-normal">(hidden)</span>}
                </p>
                <p className="text-xs text-gray-500 truncate">
                  {[s.phone, s.email, s.notes].filter(Boolean).join(" · ") || "No contact details"}
                </p>
              </div>
              {canManage && (
                <div className="flex items-center gap-1 shrink-0">
                  <Tooltip label="Edit">
                    <button onClick={() => openEdit(s)} aria-label={`Edit ${s.name}`} className="p-1.5 text-gray-400 hover:text-green-700 rounded">
                      <Pencil className="w-4 h-4" />
                    </button>
                  </Tooltip>
                  <Tooltip label={s.active ? "Hide from list" : "Show in list"}>
                    <button onClick={() => toggleActive(s)} aria-label={`Toggle ${s.name}`} className="p-1.5 text-gray-400 hover:text-amber-600 rounded">
                      <Power className="w-4 h-4" />
                    </button>
                  </Tooltip>
                  <Tooltip label="Remove">
                    <button onClick={() => remove(s)} aria-label={`Remove ${s.name}`} className="p-1.5 text-gray-400 hover:text-red-600 rounded">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </Tooltip>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
