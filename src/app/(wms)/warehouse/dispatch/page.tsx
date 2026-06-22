"use client";
import { useEffect, useState, useCallback } from "react";
import { db } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Truck,
  Plus,
  Trash2,
  Search,
  Send,
  History,
  Package,
  CheckCircle,
  Clock,
  ArrowRight,
} from "lucide-react";

interface WmsCatalogItem {
  id: number;
  sku: string;
  item_name: string;
  pack_size: number;
}

interface WmsInventoryRow {
  wms_item_id: number;
  physical_qty: number;
}

interface DispatchLine {
  id: string;
  wmsItemId: number;
  itemName: string;
  sku: string;
  qty: number;
  available: number;
}

interface PastDispatch {
  id: number;
  destination_type: string;
  destination_id: string;
  status: string;
  notes: string | null;
  created_by: string | null;
  created_at: string;
}

type DestinationType = "Internal Shop" | "External Client" | "Wholesale";

export default function WmsDispatchPage() {
  const { name: userName } = useAuth();

  // Data
  const [catalogItems, setCatalogItems] = useState<WmsCatalogItem[]>([]);
  const [inventoryMap, setInventoryMap] = useState<Map<number, number>>(new Map());
  const [history, setHistory] = useState<PastDispatch[]>([]);

  // Form
  const [destinationType, setDestinationType] = useState<DestinationType>("Internal Shop");
  const [destinationId, setDestinationId] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DispatchLine[]>([]);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  // UI
  const [tab, setTab] = useState<"new" | "history">("new");
  const [showPicker, setShowPicker] = useState(false);
  const [search, setSearch] = useState("");

  const loadData = useCallback(async () => {
    const [{ data: catalog }, { data: inventory }, { data: dispatches }] =
      await Promise.all([
        db.from("wms_catalog").select("id, sku, item_name, pack_size").order("item_name"),
        db.from("wms_inventory").select("wms_item_id, physical_qty"),
        db
          .from("wms_dispatches")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(50),
      ]);

    setCatalogItems((catalog || []) as any[]);

    const invMap = new Map<number, number>();
    ((inventory || []) as any[]).forEach((row: any) => {
      invMap.set(row.wms_item_id, row.physical_qty);
    });
    setInventoryMap(invMap);

    setHistory((dispatches || []) as any[]);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  function addLine(item: WmsCatalogItem) {
    if (lines.some((l: DispatchLine) => l.wmsItemId === item.id)) {
      setShowPicker(false);
      return;
    }

    const available = inventoryMap.get(item.id) ?? 0;

    setLines((prev: DispatchLine[]) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        wmsItemId: item.id,
        itemName: item.item_name,
        sku: item.sku,
        qty: 1,
        available,
      },
    ]);
    setShowPicker(false);
  }

  function updateLineQty(id: string, qty: number) {
    setLines((prev: DispatchLine[]) =>
      prev.map((l: DispatchLine) => (l.id === id ? { ...l, qty } : l))
    );
  }

  function removeLine(id: string) {
    setLines((prev: DispatchLine[]) =>
      prev.filter((l: DispatchLine) => l.id !== id)
    );
  }

  const hasOverage = lines.some(
    (l: DispatchLine) => l.qty > l.available
  );

  async function handleDispatch() {
    if (lines.length === 0 || !destinationId.trim() || hasOverage) return;
    setSaving(true);
    setSuccess(false);

    try {
      const items = lines.map((l: DispatchLine) => ({
        wms_item_id: l.wmsItemId,
        qty: l.qty,
      }));

      if (destinationType === "Internal Shop") {
        // Use the POS integration RPC
        const { error } = await db.rpc("process_tilify_dispatch", {
          p_org_id: null, // RLS scoped
          p_destination_id: destinationId.trim(),
          p_items: items,
          p_notes: notes.trim() || null,
          p_created_by: userName || null,
        });

        if (error) throw error;
      } else {
        // Standalone dispatch: create header + items + deduct stock manually
        const { data: dispatch, error: dispErr } = await db
          .from("wms_dispatches")
          .insert({
            destination_type: destinationType,
            destination_id: destinationId.trim(),
            status: "Dispatched",
            notes: notes.trim() || null,
            created_by: userName || null,
          })
          .select("id")
          .single();

        if (dispErr) throw dispErr;

        const dispatchId = (dispatch as any).id;

        // Insert line items
        const lineInserts = lines.map((l: DispatchLine) => ({
          dispatch_id: dispatchId,
          wms_item_id: l.wmsItemId,
          qty_sent: l.qty,
        }));

        const { error: lineErr } = await db
          .from("wms_dispatch_items")
          .insert(lineInserts);

        if (lineErr) throw lineErr;

        // Deduct from WMS inventory
        for (const l of lines) {
          const currentQty = inventoryMap.get(l.wmsItemId) ?? 0;
          await db
            .from("wms_inventory")
            .update({
              physical_qty: currentQty - l.qty,
              updated_at: new Date().toISOString(),
            })
            .eq("wms_item_id", l.wmsItemId);
        }
      }

      setSuccess(true);
      setLines([]);
      setDestinationId("");
      setNotes("");
      await loadData();
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: any) {
      console.error("Dispatch error:", err);
      alert("Dispatch failed: " + (err.message || "Unknown error"));
    } finally {
      setSaving(false);
    }
  }

  async function updateDispatchStatus(id: number, newStatus: string) {
    await db.from("wms_dispatches").update({ status: newStatus }).eq("id", id);
    await loadData();
  }

  const pickerItems = catalogItems.filter(
    (item: WmsCatalogItem) =>
      !search ||
      item.item_name.toLowerCase().includes(search.toLowerCase()) ||
      item.sku.toLowerCase().includes(search.toLowerCase())
  );

  const statusColor = (status: string) => {
    if (status === "Received") return "green";
    if (status === "Dispatched") return "blue";
    return "amber";
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Truck className="w-7 h-7 text-green-600" />
            Warehouse Dispatch
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Send stock to shops, clients, or wholesale customers
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-100 rounded-lg p-1 w-fit">
        <button
          onClick={() => setTab("new")}
          className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
            tab === "new"
              ? "bg-white text-gray-900 shadow-sm"
              : "text-gray-500 hover:text-gray-700"
          }`}
        >
          <Send className="w-4 h-4 inline mr-1" />
          New Dispatch
        </button>
        <button
          onClick={() => setTab("history")}
          className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
            tab === "history"
              ? "bg-white text-gray-900 shadow-sm"
              : "text-gray-500 hover:text-gray-700"
          }`}
        >
          <History className="w-4 h-4 inline mr-1" />
          History
        </button>
      </div>

      {/* Success */}
      {success && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-sm text-green-700">
          <CheckCircle className="w-4 h-4 inline mr-1" />
          Dispatch created successfully!
          {destinationType === "Internal Shop" &&
            " Retail stock has been updated automatically."}
        </div>
      )}

      {tab === "new" ? (
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
          {/* Destination */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Destination Type
              </label>
              <select
                value={destinationType}
                onChange={(e: any) =>
                  setDestinationType(e.target.value as DestinationType)
                }
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="Internal Shop">Internal Shop (Tilify POS)</option>
                <option value="External Client">External Client</option>
                <option value="Wholesale">Wholesale</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {destinationType === "Internal Shop"
                  ? "Shop Name"
                  : destinationType === "External Client"
                  ? "Client Name"
                  : "Wholesale Customer"}
              </label>
              <Input
                value={destinationId}
                onChange={(e: any) => setDestinationId(e.target.value)}
                placeholder={
                  destinationType === "Internal Shop"
                    ? "e.g. Main Tuck Shop"
                    : "Customer or business name"
                }
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Notes
              </label>
              <Input
                value={notes}
                onChange={(e: any) => setNotes(e.target.value)}
                placeholder="Optional"
              />
            </div>
          </div>

          {destinationType === "Internal Shop" && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-700">
              <strong>POS Integration:</strong> Dispatching to an Internal Shop
              will automatically update the retail product stock in Tilify by
              matching warehouse SKU to product inventory ID.
            </div>
          )}

          {/* Line Items */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-700">
                Items to Dispatch
              </h3>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setSearch("");
                  setShowPicker(true);
                }}
              >
                <Plus className="w-4 h-4 mr-1" />
                Add Item
              </Button>
            </div>

            {lines.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-6">
                No items added. Click &quot;Add Item&quot; to begin.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 bg-gray-50">
                      <th className="text-left px-3 py-2 font-medium text-gray-600">
                        Item
                      </th>
                      <th className="text-left px-3 py-2 font-medium text-gray-600">
                        SKU
                      </th>
                      <th className="text-right px-3 py-2 font-medium text-gray-600">
                        Available
                      </th>
                      <th className="text-right px-3 py-2 font-medium text-gray-600">
                        Qty to Send
                      </th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {lines.map((line: DispatchLine) => {
                      const over = line.qty > line.available;
                      return (
                        <tr
                          key={line.id}
                          className={over ? "bg-red-50/50" : ""}
                        >
                          <td className="px-3 py-2 font-medium text-gray-900">
                            {line.itemName}
                          </td>
                          <td className="px-3 py-2 font-mono text-xs text-gray-500">
                            {line.sku}
                          </td>
                          <td className="px-3 py-2 text-right text-gray-500">
                            {line.available}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <input
                              type="number"
                              min="1"
                              max={line.available}
                              value={line.qty}
                              onChange={(e: any) =>
                                updateLineQty(
                                  line.id,
                                  parseInt(e.target.value) || 1
                                )
                              }
                              className={`w-20 text-right border rounded px-2 py-1 text-sm ${
                                over
                                  ? "border-red-400 text-red-600"
                                  : "border-gray-300"
                              }`}
                            />
                            {over && (
                              <p className="text-xs text-red-500 mt-1">
                                Exceeds available
                              </p>
                            )}
                          </td>
                          <td className="px-3 py-2 text-center">
                            <button
                              onClick={() => removeLine(line.id)}
                              className="text-gray-400 hover:text-red-500 transition-colors"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Submit */}
          <div className="flex justify-end">
            <Button
              onClick={handleDispatch}
              disabled={
                saving ||
                lines.length === 0 ||
                !destinationId.trim() ||
                hasOverage
              }
            >
              <Send className="w-4 h-4 mr-1" />
              {saving ? "Processing..." : "Create Dispatch"}
            </Button>
          </div>
        </div>
      ) : (
        /* History Tab */
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          {history.length === 0 ? (
            <div className="text-center py-12">
              <Package className="w-12 h-12 mx-auto text-gray-300 mb-3" />
              <p className="text-gray-500">No dispatches yet</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50">
                    <th className="text-left px-4 py-3 font-medium text-gray-600">
                      Date
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">
                      Type
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">
                      Destination
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">
                      Status
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">
                      Created By
                    </th>
                    <th className="text-center px-4 py-3 font-medium text-gray-600">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {history.map((d: PastDispatch) => (
                    <tr key={d.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-gray-500">
                        {formatDate(d.created_at)}
                      </td>
                      <td className="px-4 py-3 text-gray-900">
                        {d.destination_type}
                      </td>
                      <td className="px-4 py-3 text-gray-900">
                        {d.destination_id}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={statusColor(d.status) as any}>
                          {d.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-gray-500">
                        {d.created_by || "—"}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {d.status === "Pending" && (
                          <button
                            onClick={() =>
                              updateDispatchStatus(d.id, "Dispatched")
                            }
                            className="text-xs text-blue-600 hover:underline mr-2"
                          >
                            Mark Dispatched
                          </button>
                        )}
                        {d.status === "Dispatched" && (
                          <button
                            onClick={() =>
                              updateDispatchStatus(d.id, "Received")
                            }
                            className="text-xs text-green-600 hover:underline"
                          >
                            Mark Received
                          </button>
                        )}
                        {d.status === "Received" && (
                          <span className="text-xs text-gray-400">
                            Complete
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Item Picker Modal */}
      {showPicker && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-lg w-full max-h-[70vh] flex flex-col">
            <div className="p-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900 mb-3">
                Select Item to Dispatch
              </h3>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <Input
                  placeholder="Search items..."
                  value={search}
                  onChange={(e: any) => setSearch(e.target.value)}
                  className="pl-10"
                  autoFocus
                />
              </div>
            </div>
            <div className="overflow-y-auto flex-1 p-2">
              {pickerItems.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-6">
                  No items found
                </p>
              ) : (
                pickerItems.map((item: WmsCatalogItem) => {
                  const avail = inventoryMap.get(item.id) ?? 0;
                  return (
                    <button
                      key={item.id}
                      onClick={() => addLine(item)}
                      disabled={avail === 0}
                      className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors flex items-center justify-between ${
                        avail === 0
                          ? "opacity-40 cursor-not-allowed"
                          : "hover:bg-green-50"
                      }`}
                    >
                      <div>
                        <p className="font-medium text-gray-900 text-sm">
                          {item.item_name}
                        </p>
                        <p className="text-xs text-gray-500">
                          SKU: {item.sku} · Available: {avail}
                        </p>
                      </div>
                      {avail > 0 && <Plus className="w-4 h-4 text-green-600" />}
                    </button>
                  );
                })
              )}
            </div>
            <div className="p-3 border-t border-gray-200">
              <Button
                variant="secondary"
                className="w-full"
                onClick={() => setShowPicker(false)}
              >
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
