"use client";
import { useEffect, useState, useCallback } from "react";
import { db } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { formatZAR, formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  PackagePlus,
  Plus,
  Trash2,
  Search,
  Save,
  History,
  Package,
} from "lucide-react";

interface WmsCatalogItem {
  id: number;
  sku: string;
  item_name: string;
  category: string | null;
  pack_size: number;
}

interface ReceiptLine {
  id: string;
  wmsItemId: number;
  itemName: string;
  sku: string;
  packSize: number;
  packs: number;
  unitCost: number;
}

interface PastReceipt {
  id: number;
  receipt_date: string;
  supplier: string | null;
  notes: string | null;
  total_cost: number;
  recorded_by: string | null;
  created_at: string;
}

export default function WmsReceiveStockPage() {
  const { name: userName } = useAuth();
  const [catalogItems, setCatalogItems] = useState<WmsCatalogItem[]>([]);
  const [lines, setLines] = useState<ReceiptLine[]>([]);
  const [supplier, setSupplier] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [search, setSearch] = useState("");
  const [showPicker, setShowPicker] = useState(false);
  const [tab, setTab] = useState<"new" | "history">("new");
  const [history, setHistory] = useState<PastReceipt[]>([]);

  const loadData = useCallback(async () => {
    const [{ data: catalog }, { data: receipts }] = await Promise.all([
      db.from("wms_catalog").select("*").order("item_name"),
      db
        .from("wms_receipts")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50),
    ]);

    setCatalogItems((catalog || []) as any[]);
    setHistory((receipts || []) as any[]);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  function addLine(item: WmsCatalogItem) {
    if (lines.some((l: ReceiptLine) => l.wmsItemId === item.id)) {
      setShowPicker(false);
      return;
    }

    const newLine: ReceiptLine = {
      id: crypto.randomUUID(),
      wmsItemId: item.id,
      itemName: item.item_name,
      sku: item.sku,
      packSize: item.pack_size,
      packs: 1,
      unitCost: 0,
    };

    setLines((prev: ReceiptLine[]) => [...prev, newLine]);
    setShowPicker(false);
  }

  function updateLine(id: string, field: keyof ReceiptLine, value: any) {
    setLines((prev: ReceiptLine[]) =>
      prev.map((l: ReceiptLine) =>
        l.id === id ? { ...l, [field]: value } : l
      )
    );
  }

  function removeLine(id: string) {
    setLines((prev: ReceiptLine[]) =>
      prev.filter((l: ReceiptLine) => l.id !== id)
    );
  }

  async function handleSave() {
    if (lines.length === 0) return;
    setSaving(true);
    setSuccess(false);

    try {
      // H5 fix: single atomic RPC replaces the multi-step client-side flow.
      // Header insert, line items, and inventory updates all happen in one
      // database transaction — partial failure can no longer leave mismatched
      // header vs actual stock.
      const { error: rpcErr } = await db.rpc("receive_wms_stock", {
        p_supplier: supplier.trim(),
        p_notes: notes.trim(),
        p_recorded_by: userName || null,
        p_wms_item_ids: lines.map((l: ReceiptLine) => l.wmsItemId),
        p_packs: lines.map((l: ReceiptLine) => l.packs),
        p_pack_sizes: lines.map((l: ReceiptLine) => l.packSize),
        p_unit_costs: lines.map((l: ReceiptLine) => l.unitCost),
      });

      if (rpcErr) throw rpcErr;

      setSuccess(true);
      setLines([]);
      setSupplier("");
      setNotes("");
      await loadData();
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: any) {
      console.error("Error receiving stock:", err);
      alert("Failed to receive stock: " + (err.message || "Unknown error"));
    } finally {
      setSaving(false);
    }
  }

  const totalUnits = lines.reduce(
    (sum: number, l: ReceiptLine) => sum + l.packs * l.packSize,
    0
  );

  const totalCost = lines.reduce(
    (sum: number, l: ReceiptLine) => sum + l.packs * l.packSize * l.unitCost,
    0
  );

  const pickerItems = catalogItems.filter(
    (item: WmsCatalogItem) =>
      !search ||
      item.item_name.toLowerCase().includes(search.toLowerCase()) ||
      item.sku.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <PackagePlus className="w-7 h-7 text-green-600" />
          Receive Warehouse Stock
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Log bulk supplier deliveries to the warehouse
        </p>
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
          <PackagePlus className="w-4 h-4 inline mr-1" />
          New Receipt
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

      {/* Success message */}
      {success && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-sm text-green-700">
          Stock received successfully! Warehouse quantities updated.
        </div>
      )}

      {tab === "new" ? (
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
          {/* Supplier & Notes */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Supplier
              </label>
              <Input
                value={supplier}
                onChange={(e: any) => setSupplier(e.target.value)}
                placeholder="Supplier name"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Notes
              </label>
              <Input
                value={notes}
                onChange={(e: any) => setNotes(e.target.value)}
                placeholder="Optional delivery notes"
              />
            </div>
          </div>

          {/* Line Items */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-700">Line Items</h3>
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
                No items added yet. Click &quot;Add Item&quot; to select from the
                warehouse catalog.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 bg-gray-50">
                      <th className="text-left px-3 py-2 font-medium text-gray-600">Item</th>
                      <th className="text-left px-3 py-2 font-medium text-gray-600">SKU</th>
                      <th className="text-right px-3 py-2 font-medium text-gray-600">Pack Size</th>
                      <th className="text-right px-3 py-2 font-medium text-gray-600">Packs</th>
                      <th className="text-right px-3 py-2 font-medium text-gray-600">Total Units</th>
                      <th className="text-right px-3 py-2 font-medium text-gray-600">Unit Cost</th>
                      <th className="text-right px-3 py-2 font-medium text-gray-600">Line Total</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {lines.map((line: ReceiptLine) => (
                      <tr key={line.id}>
                        <td className="px-3 py-2 font-medium text-gray-900">
                          {line.itemName}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-gray-500">
                          {line.sku}
                        </td>
                        <td className="px-3 py-2 text-right text-gray-500">
                          {line.packSize}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <input
                            type="number"
                            min="1"
                            value={line.packs}
                            onChange={(e: any) =>
                              updateLine(line.id, "packs", parseInt(e.target.value) || 1)
                            }
                            className="w-16 text-right border border-gray-300 rounded px-2 py-1 text-sm"
                          />
                        </td>
                        <td className="px-3 py-2 text-right font-medium">
                          {line.packs * line.packSize}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={line.unitCost}
                            onChange={(e: any) =>
                              updateLine(line.id, "unitCost", parseFloat(e.target.value) || 0)
                            }
                            className="w-20 text-right border border-gray-300 rounded px-2 py-1 text-sm"
                          />
                        </td>
                        <td className="px-3 py-2 text-right font-medium">
                          {formatZAR(line.packs * line.packSize * line.unitCost)}
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
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-gray-200 bg-gray-50">
                      <td colSpan={4} className="px-3 py-2 text-right font-semibold text-gray-700">
                        Totals
                      </td>
                      <td className="px-3 py-2 text-right font-bold">{totalUnits}</td>
                      <td className="px-3 py-2"></td>
                      <td className="px-3 py-2 text-right font-bold">{formatZAR(totalCost)}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>

          {/* Save */}
          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={saving || lines.length === 0}>
              <Save className="w-4 h-4 mr-1" />
              {saving ? "Saving..." : "Receive Stock"}
            </Button>
          </div>
        </div>
      ) : (
        /* History Tab */
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          {history.length === 0 ? (
            <div className="text-center py-12">
              <Package className="w-12 h-12 mx-auto text-gray-300 mb-3" />
              <p className="text-gray-500">No receipts recorded yet</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50">
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Date</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Supplier</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Notes</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600">Total Cost</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Recorded By</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {history.map((r: PastReceipt) => (
                    <tr key={r.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-gray-500">
                        {formatDate(r.created_at)}
                      </td>
                      <td className="px-4 py-3 text-gray-900">
                        {r.supplier || "—"}
                      </td>
                      <td className="px-4 py-3 text-gray-500">
                        {r.notes || "—"}
                      </td>
                      <td className="px-4 py-3 text-right font-medium">
                        {formatZAR(r.total_cost)}
                      </td>
                      <td className="px-4 py-3 text-gray-500">
                        {r.recorded_by || "—"}
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
                Select Warehouse Item
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
                <p className="text-sm text-gray-400 text-center py-6">No items found</p>
              ) : (
                pickerItems.map((item: WmsCatalogItem) => (
                  <button
                    key={item.id}
                    onClick={() => addLine(item)}
                    className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-green-50 transition-colors flex items-center justify-between"
                  >
                    <div>
                      <p className="font-medium text-gray-900 text-sm">{item.item_name}</p>
                      <p className="text-xs text-gray-500">
                        SKU: {item.sku} · Pack: {item.pack_size}
                      </p>
                    </div>
                    <Plus className="w-4 h-4 text-green-600" />
                  </button>
                ))
              )}
            </div>
            <div className="p-3 border-t border-gray-200">
              <Button variant="secondary" className="w-full" onClick={() => setShowPicker(false)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
