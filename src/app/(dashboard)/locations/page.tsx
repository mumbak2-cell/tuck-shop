"use client";
import { useEffect, useState } from "react";
import { db } from "@/lib/supabase";
import { useOrg, type LocationRow } from "@/lib/org-context";
import { Button } from "@/components/ui/button";
import { Store, Plus, Pencil, Power, Trash2, Check, X } from "lucide-react";

export default function LocationsPage() {
  const { role, refresh, canSwitchLocation } = useOrg();
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<LocationRow | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState("");
  const [formAddress, setFormAddress] = useState("");
  const [formPhone, setFormPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canManage = role === "owner" || role === "admin";

  async function load() {
    setLoading(true);
    const { data } = await db
      .from("locations")
      .select("id, name, address, phone, sort_order, active")
      .order("sort_order")
      .order("name");
    setLocations((data as LocationRow[]) || []);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  function openNewForm() {
    setEditing(null);
    setFormName("");
    setFormAddress("");
    setFormPhone("");
    setError(null);
    setShowForm(true);
  }

  function openEditForm(loc: LocationRow) {
    setEditing(loc);
    setFormName(loc.name);
    setFormAddress(loc.address || "");
    setFormPhone(loc.phone || "");
    setError(null);
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditing(null);
    setError(null);
  }

  async function saveForm(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!formName.trim()) {
      setError("Please enter a location name.");
      return;
    }
    setSaving(true);

    const payload = {
      name: formName.trim(),
      address: formAddress.trim() || null,
      phone: formPhone.trim() || null,
    };

    let result;
    if (editing) {
      result = await db.from("locations").update(payload).eq("id", editing.id);
    } else {
      const maxOrder = locations.reduce((m, l) => Math.max(m, l.sort_order), 0);
      result = await db
        .from("locations")
        .insert({ ...payload, sort_order: maxOrder + 1 });
    }

    if (result.error) {
      setError(result.error.message);
      setSaving(false);
      return;
    }

    setSaving(false);
    closeForm();
    await load();
    await refresh();
  }

  async function toggleActive(loc: LocationRow) {
    const verb = loc.active ? "disable" : "enable";
    if (!confirm(`Are you sure you want to ${verb} "${loc.name}"?`)) return;
    const { error: err } = await db
      .from("locations")
      .update({ active: !loc.active })
      .eq("id", loc.id);
    if (err) {
      alert("Could not change status: " + err.message);
      return;
    }
    await load();
    await refresh();
  }

  async function remove(loc: LocationRow) {
    if (!confirm(`Delete "${loc.name}"? All sales, shifts, and customers tied to this location will be deleted as well. This cannot be undone.`)) return;
    const { error: err } = await db.from("locations").delete().eq("id", loc.id);
    if (err) {
      alert("Could not delete: " + err.message);
      return;
    }
    await load();
    await refresh();
  }

  if (loading) {
    return <div className="text-center py-12 text-gray-400">Loading...</div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Store className="w-7 h-7 text-green-600" />
            Locations
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Each shop in your business. Sales, shifts, customers, and expenses are tracked per
            location. The product catalogue and stock pool are shared across all locations.
          </p>
        </div>
        {canManage && (
          <Button onClick={openNewForm}>
            <Plus className="w-4 h-4 mr-2" /> Add Location
          </Button>
        )}
      </div>

      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr className="text-left text-xs font-medium text-gray-500 uppercase">
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Address</th>
              <th className="px-4 py-3">Phone</th>
              <th className="px-4 py-3">Status</th>
              {canManage && <th className="px-4 py-3 text-right">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {locations.length === 0 && (
              <tr>
                <td colSpan={canManage ? 5 : 4} className="px-4 py-8 text-center text-gray-400">
                  No locations yet.
                </td>
              </tr>
            )}
            {locations.map((loc) => (
              <tr key={loc.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-900">{loc.name}</td>
                <td className="px-4 py-3 text-gray-600">{loc.address || "—"}</td>
                <td className="px-4 py-3 text-gray-600">{loc.phone || "—"}</td>
                <td className="px-4 py-3">
                  {loc.active ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-50 text-green-700 rounded-full text-xs font-medium">
                      <Check className="w-3 h-3" /> Active
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full text-xs font-medium">
                      <X className="w-3 h-3" /> Disabled
                    </span>
                  )}
                </td>
                {canManage && (
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex gap-1">
                      <button
                        onClick={() => openEditForm(loc)}
                        className="p-1.5 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded"
                        title="Edit"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => toggleActive(loc)}
                        className="p-1.5 text-gray-500 hover:text-amber-700 hover:bg-amber-50 rounded"
                        title={loc.active ? "Disable" : "Enable"}
                      >
                        <Power className="w-4 h-4" />
                      </button>
                      {locations.length > 1 && (
                        <button
                          onClick={() => remove(loc)}
                          className="p-1.5 text-gray-500 hover:text-red-700 hover:bg-red-50 rounded"
                          title="Delete"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!canSwitchLocation && (
        <p className="text-xs text-gray-500 mt-4">
          You can see this page because you are signed in, but only owners and admins can add or edit
          locations.
        </p>
      )}

      {showForm && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-bold text-gray-900 mb-4">
              {editing ? "Edit Location" : "Add Location"}
            </h2>
            <form onSubmit={saveForm} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
                <input
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  required
                  placeholder="e.g. Lilongwe Main Branch"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Address</label>
                <input
                  type="text"
                  value={formAddress}
                  onChange={(e) => setFormAddress(e.target.value)}
                  placeholder="Optional"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
                <input
                  type="text"
                  value={formPhone}
                  onChange={(e) => setFormPhone(e.target.value)}
                  placeholder="Optional"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
                />
              </div>

              {error && (
                <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  {error}
                </div>
              )}

              <div className="flex justify-end gap-3 pt-2">
                <Button type="button" variant="secondary" onClick={closeForm}>
                  Cancel
                </Button>
                <Button type="submit" loading={saving}>
                  {editing ? "Save changes" : "Add location"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
