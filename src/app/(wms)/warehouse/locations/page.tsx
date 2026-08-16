"use client";
import { useState, useEffect, useCallback } from "react";
import { db } from "@/lib/supabase";
import { fetchAllPaged } from "@/lib/fetch-all";
import { useOrg } from "@/lib/org-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import {
  MapPin,
  Plus,
  Pencil,
  Power,
  Lock,
  RefreshCw,
  Boxes,
} from "lucide-react";

interface WmsLocation {
  id: string;
  org_id: string;
  code: string;
  label: string;
  kind: string;
  capacity: number | null;
  active: boolean;
  created_at: string;
}

const KINDS = ["bin", "rack", "zone", "staging"] as const;

export default function WarehouseLocationsPage() {
  const { orgId } = useOrg();
  const toast = useToast();
  const [locations, setLocations] = useState<WmsLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Form state
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<string>("bin");
  const [capacity, setCapacity] = useState<string>("");
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    const rows = await fetchAllPaged<WmsLocation>(() =>
      db.from("wms_locations").select("*").order("code")
    );
    setLocations((rows || []) as any[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  function openCreate() {
    setEditingId(null);
    setCode("");
    setLabel("");
    setKind("bin");
    setCapacity("");
    setActive(true);
    setShowModal(true);
  }

  function openEdit(loc: WmsLocation) {
    setEditingId(loc.id);
    setCode(loc.code);
    setLabel(loc.label);
    setKind(loc.kind);
    setCapacity(loc.capacity !== null ? String(loc.capacity) : "");
    setActive(loc.active);
    setShowModal(true);
  }

  const isMain = code.toUpperCase() === "MAIN";

  async function handleSave() {
    const trimmedCode = code.trim().toUpperCase();
    const trimmedLabel = label.trim();
    if (!trimmedCode || !trimmedLabel) return;

    setSaving(true);
    try {
      const payload: any = {
        code: trimmedCode,
        label: trimmedLabel,
        kind,
        capacity: capacity === "" ? null : parseInt(capacity),
        active,
      };

      if (editingId) {
        const { error } = await db
          .from("wms_locations")
          .update(payload)
          .eq("id", editingId);
        if (error) throw error;
        toast.success("Location updated");
      } else {
        payload.org_id = orgId;
        const { error } = await db.from("wms_locations").insert(payload);
        if (error) {
          if (error.code === "23505") {
            toast.error("A location with this code already exists");
            return;
          }
          throw error;
        }
        toast.success("Location created");
      }

      setShowModal(false);
      await loadData();
    } catch (err: any) {
      toast.error("Failed to save location", { hint: err.message });
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(loc: WmsLocation) {
    if (loc.code === "MAIN") return;
    try {
      const { error } = await db
        .from("wms_locations")
        .update({ active: !loc.active })
        .eq("id", loc.id);
      if (error) throw error;
      toast.success(loc.active ? "Location deactivated" : "Location activated");
      await loadData();
    } catch (err: any) {
      toast.error("Failed to update status", { hint: err.message });
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <MapPin className="w-7 h-7 text-green-600" />
            Bin Management
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Create and manage warehouse bins, racks, and zones.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="w-4 h-4 mr-1" />
          New Location
        </Button>
      </div>

      {/* Table */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading...</div>
      ) : locations.length === 0 ? (
        <div className="text-center py-12">
          <Boxes className="w-12 h-12 mx-auto text-gray-300 mb-3" />
          <p className="text-gray-500">No locations yet.</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
              <tr>
                <th className="text-left px-4 py-3">Code</th>
                <th className="text-left px-4 py-3">Label</th>
                <th className="text-left px-4 py-3">Kind</th>
                <th className="text-left px-4 py-3">Capacity</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="text-right px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {locations.map((loc) => (
                <tr key={loc.id} className="border-t border-gray-100">
                  <td className="px-4 py-3 font-mono font-medium text-gray-900 flex items-center gap-1.5">
                    {loc.code === "MAIN" && <Lock className="w-3.5 h-3.5 text-gray-400" />}
                    {loc.code}
                  </td>
                  <td className="px-4 py-3 text-gray-700">{loc.label}</td>
                  <td className="px-4 py-3">
                    <Badge variant="gray">{loc.kind}</Badge>
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {loc.capacity !== null ? loc.capacity : "Unlimited"}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={loc.active ? "green" : "gray"}>
                      {loc.active ? "Active" : "Inactive"}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => openEdit(loc)}
                      >
                        <Pencil className="w-4 h-4" />
                      </Button>
                      {loc.code !== "MAIN" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => toggleActive(loc)}
                          className={loc.active ? "text-gray-500 hover:text-red-600" : "text-gray-500 hover:text-green-600"}
                        >
                          <Power className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create/Edit Modal */}
      <Modal
        open={showModal}
        onClose={() => setShowModal(false)}
        title={editingId ? "Edit Location" : "New Location"}
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Code
            </label>
            <Input
              value={code}
              onChange={(e: any) => setCode(e.target.value.toUpperCase())}
              placeholder="e.g. A-01-03"
              disabled={editingId !== null && isMain}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Label
            </label>
            <Input
              value={label}
              onChange={(e: any) => setLabel(e.target.value)}
              placeholder="Human-readable name"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Kind
            </label>
            <select
              value={kind}
              onChange={(e: any) => setKind(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Capacity (optional)
            </label>
            <Input
              type="number"
              min="1"
              value={capacity}
              onChange={(e: any) => setCapacity(e.target.value)}
              placeholder="Leave blank for unlimited"
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="loc-active"
              checked={active}
              onChange={(e: any) => setActive(e.target.checked)}
              disabled={editingId !== null && isMain}
              className="rounded border-gray-300"
            />
            <label htmlFor="loc-active" className="text-sm text-gray-700">
              Active
            </label>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={() => setShowModal(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving || !code.trim() || !label.trim()}
            >
              {saving ? "Saving..." : editingId ? "Update" : "Create"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
