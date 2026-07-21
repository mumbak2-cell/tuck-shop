"use client";
// Supplier picker used by Receive Stock and WMS Purchase Orders. Reads the
// org's suppliers list (migration 050) and hands back the chosen supplier's
// NAME, because those forms still store the name in their existing `supplier`
// text column. Includes an inline "add new" so nobody is blocked mid-delivery
// by a supplier that isn't on the list yet.

import { useEffect, useState } from "react";
import { db } from "@/lib/supabase";
import { Check, X } from "lucide-react";

interface SupplierRow {
  id: string;
  name: string;
}

const ADD_NEW = "__add_new__";

export function SupplierSelect({
  value,
  onChange,
  required = false,
  disabled = false,
}: {
  value: string;
  onChange: (name: string) => void;
  required?: boolean;
  disabled?: boolean;
}) {
  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    const { data } = await db
      .from("suppliers")
      .select("id, name")
      .eq("active", true)
      .order("name");
    setSuppliers((data as SupplierRow[]) || []);
    setLoading(false);
  }

  async function saveNew() {
    const name = newName.trim();
    if (!name) return;
    setSaving(true);
    setError(null);
    const { error: insErr } = await db.from("suppliers").insert({ name });
    setSaving(false);
    // 23505 = this supplier already exists for the org; just select it.
    if (insErr && insErr.code !== "23505") {
      setError(insErr.message || "Could not add supplier");
      return;
    }
    await load();
    onChange(name);
    setAdding(false);
    setNewName("");
  }

  // A legacy free-text value that predates the list must stay selectable,
  // otherwise editing an old record would silently blank its supplier.
  const known = suppliers.some((s) => s.name === value);
  const inputClass =
    "w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500";

  if (adding) {
    return (
      <div>
        <div className="flex gap-2">
          <input
            type="text"
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New supplier name"
            className={inputClass}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void saveNew();
              }
            }}
          />
          <button
            type="button"
            onClick={() => void saveNew()}
            disabled={saving || !newName.trim()}
            aria-label="Save supplier"
            className="px-3 rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
          >
            <Check className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              setAdding(false);
              setNewName("");
              setError(null);
            }}
            aria-label="Cancel"
            className="px-3 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
      </div>
    );
  }

  return (
    <select
      value={value}
      disabled={disabled || loading}
      required={required}
      onChange={(e) => {
        if (e.target.value === ADD_NEW) {
          setAdding(true);
          return;
        }
        onChange(e.target.value);
      }}
      className={`${inputClass} bg-white`}
    >
      <option value="">{loading ? "Loading…" : required ? "Select a supplier…" : "— None —"}</option>
      {value && !known && <option value={value}>{value}</option>}
      {suppliers.map((s) => (
        <option key={s.id} value={s.name}>
          {s.name}
        </option>
      ))}
      <option value={ADD_NEW}>+ Add new supplier…</option>
    </select>
  );
}
