"use client";
import { useEffect, useState, useCallback } from "react";
import { db } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { formatZAR, formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Modal } from "@/components/ui/modal";
import {
  FileText,
  Plus,
  Trash2,
  Search,
  Send,
  AlertTriangle,
  Package,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  ShoppingCart,
  PackagePlus,
  X,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface WmsCatalogItem {
  id: number;
  sku: string;
  item_name: string;
  pack_size: number;
}

interface ReorderAlert {
  id: number;
  item_name: string;
  sku: string;
  physical_qty: number;
  reorder_level: number;
  reorder_qty: number;
}

interface POHeader {
  id: number;
  po_number: string;
  supplier: string;
  status: string;
  notes: string | null;
  expected_date: string | null;
  created_by: string | null;
  created_at: string;
}

interface POLineItem {
  id: number;
  wms_item_id: number;
  item_name: string;
  sku: string;
  qty_ordered: number;
  qty_received: number;
  unit_cost: number;
  line_total: number;
}

interface NewPOLine {
  localId: string;
  wmsItemId: number;
  itemName: string;
  sku: string;
  qtyOrdered: number;
  unitCost: number;
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function WmsPurchaseOrdersPage() {
  const { name: userName } = useAuth();

  // Data
  const [catalogItems, setCatalogItems] = useState<WmsCatalogItem[]>([]);
  const [reorderAlerts, setReorderAlerts] = useState<ReorderAlert[]>([]);
  const [orders, setOrders] = useState<POHeader[]>([]);

  // Create PO form
  const [showCreate, setShowCreate] = useState(false);
  const [poSupplier, setPoSupplier] = useState("");
  const [poNotes, setPoNotes] = useState("");
  const [poExpectedDate, setPoExpectedDate] = useState("");
  const [poLines, setPoLines] = useState<NewPOLine[]>([]);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState("");

  // Item picker
  const [showPicker, setShowPicker] = useState(false);
  const [search, setSearch] = useState("");

  // Inline expand
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [detailCache, setDetailCache] = useState<Map<number, POLineItem[]>>(new Map());
  const [detailLoading, setDetailLoading] = useState(false);

  // Receive modal
  const [receivePoId, setReceivePoId] = useState<number | null>(null);
  const [receiveItems, setReceiveItems] = useState<POLineItem[]>([]);
  const [receiveQtys, setReceiveQtys] = useState<Map<number, number>>(new Map());
  const [receiving, setReceiving] = useState(false);

  const loadData = useCallback(async () => {
    const [{ data: catalog }, { data: inventory }, { data: pos }] =
      await Promise.all([
        db.from("wms_catalog").select("id, sku, item_name, pack_size").order("item_name"),
        db.from("wms_inventory").select("wms_item_id, physical_qty, reorder_level, reorder_qty"),
        db.from("wms_purchase_orders")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(50),
      ]);

    const catArr: any[] = (catalog || []) as any[];
    const invArr: any[] = (inventory || []) as any[];

    setCatalogItems(catArr as WmsCatalogItem[]);
    setOrders((pos || []) as any[]);

    // Build reorder alerts
    const invMap = new Map<number, any>();
    invArr.forEach((r: any) => invMap.set(r.wms_item_id, r));

    const alerts: ReorderAlert[] = [];
    catArr.forEach((c: any) => {
      const inv = invMap.get(c.id);
      if (inv && inv.physical_qty <= inv.reorder_level) {
        alerts.push({
          id: c.id,
          item_name: c.item_name,
          sku: c.sku,
          physical_qty: inv.physical_qty,
          reorder_level: inv.reorder_level,
          reorder_qty: inv.reorder_qty,
        });
      }
    });
    alerts.sort((a: ReorderAlert, b: ReorderAlert) => a.physical_qty - b.physical_qty);
    setReorderAlerts(alerts);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  /* ---- PO Number generation ---- */
  function generatePoNumber(): string {
    const now = new Date();
    const y = now.getFullYear().toString().slice(2);
    const m = (now.getMonth() + 1).toString().padStart(2, "0");
    const d = now.getDate().toString().padStart(2, "0");
    const seq = Math.floor(Math.random() * 900 + 100);
    return "PO-" + y + m + d + "-" + seq;
  }

  /* ---- Create from reorder alerts ---- */
  function createFromAlerts() {
    const newLines: NewPOLine[] = reorderAlerts.map((a: ReorderAlert) => ({
      localId: crypto.randomUUID(),
      wmsItemId: a.id,
      itemName: a.item_name,
      sku: a.sku,
      qtyOrdered: a.reorder_qty,
      unitCost: 0,
    }));
    setPoLines(newLines);
    setPoSupplier("");
    setPoNotes("Auto-generated from reorder alerts");
    setPoExpectedDate("");
    setShowCreate(true);
  }

  /* ---- Create blank PO ---- */
  function createBlankPO() {
    setPoLines([]);
    setPoSupplier("");
    setPoNotes("");
    setPoExpectedDate("");
    setShowCreate(true);
  }

  /* ---- Add item to PO ---- */
  function addPOLine(item: WmsCatalogItem) {
    if (poLines.some((l: NewPOLine) => l.wmsItemId === item.id)) {
      setShowPicker(false);
      return;
    }
    setPoLines((prev: NewPOLine[]) => [
      ...prev,
      {
        localId: crypto.randomUUID(),
        wmsItemId: item.id,
        itemName: item.item_name,
        sku: item.sku,
        qtyOrdered: 1,
        unitCost: 0,
      },
    ]);
    setShowPicker(false);
  }

  function updatePOLine(localId: string, field: string, value: number) {
    setPoLines((prev: NewPOLine[]) =>
      prev.map((l: NewPOLine) =>
        l.localId === localId ? { ...l, [field]: value } : l
      )
    );
  }

  function removePOLine(localId: string) {
    setPoLines((prev: NewPOLine[]) =>
      prev.filter((l: NewPOLine) => l.localId !== localId)
    );
  }

  /* ---- Save PO ---- */
  async function savePO() {
    if (poLines.length === 0 || !poSupplier.trim()) return;
    setSaving(true);

    try {
      const poNum = generatePoNumber();

      const { data: po, error: poErr } = await db
        .from("wms_purchase_orders")
        .insert({
          po_number: poNum,
          supplier: poSupplier.trim(),
          status: "Draft",
          notes: poNotes.trim() || null,
          expected_date: poExpectedDate || null,
          created_by: userName || null,
        })
        .select("id")
        .single();

      if (poErr) throw poErr;
      const poId = (po as any).id;

      const lineInserts = poLines.map((l: NewPOLine) => ({
        po_id: poId,
        wms_item_id: l.wmsItemId,
        qty_ordered: l.qtyOrdered,
        unit_cost: l.unitCost,
      }));

      const { error: lineErr } = await db
        .from("wms_po_items")
        .insert(lineInserts);

      if (lineErr) throw lineErr;

      setSuccess("PO " + poNum + " created successfully");
      setShowCreate(false);
      setPoLines([]);
      await loadData();
      setTimeout(() => setSuccess(""), 3000);
    } catch (err: any) {
      console.error("PO creation error:", err);
      alert("Failed to create PO: " + (err.message || "Unknown error"));
    } finally {
      setSaving(false);
    }
  }

  /* ---- Update PO status ---- */
  async function updatePOStatus(id: number, newStatus: string) {
    await db.from("wms_purchase_orders")
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq("id", id);
    await loadData();
    // Clear detail cache for this PO
    setDetailCache((prev: Map<number, POLineItem[]>) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }

  /* ---- Expand PO details ---- */
  async function toggleExpand(poId: number) {
    if (expandedId === poId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(poId);

    if (detailCache.has(poId)) return;

    setDetailLoading(true);
    const { data: items } = await db
      .from("wms_po_items")
      .select("id, wms_item_id, qty_ordered, qty_received, unit_cost, line_total, wms_catalog(item_name, sku)")
      .eq("po_id", poId);

    const parsed: POLineItem[] = ((items || []) as any[]).map((row: any) => ({
      id: row.id,
      wms_item_id: row.wms_item_id,
      item_name: row.wms_catalog?.item_name || "Unknown",
      sku: row.wms_catalog?.sku || "",
      qty_ordered: row.qty_ordered,
      qty_received: row.qty_received,
      unit_cost: Number(row.unit_cost),
      line_total: Number(row.line_total),
    }));

    setDetailCache((prev: Map<number, POLineItem[]>) => {
      const next = new Map(prev);
      next.set(poId, parsed);
      return next;
    });
    setDetailLoading(false);
  }

  /* ---- Open receive modal ---- */
  function openReceiveModal(poId: number) {
    const items = detailCache.get(poId) || [];
    setReceivePoId(poId);
    setReceiveItems(items);
    const qtyMap = new Map<number, number>();
    items.forEach((item: POLineItem) => {
      const remaining = item.qty_ordered - item.qty_received;
      qtyMap.set(item.id, Math.max(remaining, 0));
    });
    setReceiveQtys(qtyMap);
  }

  function updateReceiveQty(itemId: number, qty: number) {
    setReceiveQtys((prev: Map<number, number>) => {
      const next = new Map(prev);
      next.set(itemId, qty);
      return next;
    });
  }

  /* ---- Process receive ---- */
  async function processReceive() {
    if (receivePoId === null) return;
    setReceiving(true);

    try {
      const po = orders.find((o: POHeader) => o.id === receivePoId);
      if (!po) throw new Error("PO not found");

      // Filter items with qty > 0
      const toReceive = receiveItems.filter((item: POLineItem) => {
        const qty = receiveQtys.get(item.id) || 0;
        return qty > 0;
      });

      if (toReceive.length === 0) {
        alert("No items to receive");
        setReceiving(false);
        return;
      }

      // 1. Create a receipt header
      const totalCost = toReceive.reduce((sum: number, item: POLineItem) => {
        const qty = receiveQtys.get(item.id) || 0;
        return sum + qty * item.unit_cost;
      }, 0);

      const { data: receipt, error: recErr } = await db
        .from("wms_receipts")
        .insert({
          receipt_date: new Date().toISOString().split("T")[0],
          supplier: po.supplier,
          notes: "Received against " + po.po_number,
          total_cost: totalCost,
          recorded_by: userName || null,
        })
        .select("id")
        .single();

      if (recErr) throw recErr;
      const receiptId = (receipt as any).id;

      // 2. Insert receipt line items and update inventory
      for (const item of toReceive) {
        const qty = receiveQtys.get(item.id) || 0;

        // Receipt line item
        await db.from("wms_receipt_items").insert({
          receipt_id: receiptId,
          wms_item_id: item.wms_item_id,
          packs: qty,
          pack_size: 1,
          total_units: qty,
          unit_cost: item.unit_cost,
          line_total: qty * item.unit_cost,
        });

        // Update inventory
        const { data: inv } = await db
          .from("wms_inventory")
          .select("physical_qty")
          .eq("wms_item_id", item.wms_item_id)
          .single();

        const currentQty = (inv as any)?.physical_qty ?? 0;

        await db
          .from("wms_inventory")
          .update({
            physical_qty: currentQty + qty,
            updated_at: new Date().toISOString(),
          })
          .eq("wms_item_id", item.wms_item_id);

        // Update PO item qty_received
        await db
          .from("wms_po_items")
          .update({ qty_received: item.qty_received + qty })
          .eq("id", item.id);
      }

      // 3. Update PO status
      // Check if all items are fully received
      const { data: updatedItems } = await db
        .from("wms_po_items")
        .select("qty_ordered, qty_received")
        .eq("po_id", receivePoId);

      const allReceived = ((updatedItems || []) as any[]).every(
        (i: any) => i.qty_received >= i.qty_ordered
      );

      await updatePOStatus(
        receivePoId,
        allReceived ? "Received" : "Partially Received"
      );

      // Clear caches and reload
      setDetailCache(new Map());
      setReceivePoId(null);
      setSuccess("Stock received against " + po.po_number);
      await loadData();
      setTimeout(() => setSuccess(""), 3000);
    } catch (err: any) {
      console.error("Receive error:", err);
      alert("Receive failed: " + (err.message || "Unknown error"));
    } finally {
      setReceiving(false);
    }
  }

  /* ---- Picker filter ---- */
  const pickerItems = catalogItems.filter(
    (item: WmsCatalogItem) =>
      !search ||
      item.item_name.toLowerCase().includes(search.toLowerCase()) ||
      item.sku.toLowerCase().includes(search.toLowerCase())
  );

  const statusColor = (status: string): "gray" | "blue" | "yellow" | "green" | "red" => {
    if (status === "Draft") return "gray";
    if (status === "Sent") return "blue";
    if (status === "Partially Received") return "yellow";
    if (status === "Received") return "green";
    if (status === "Cancelled") return "red";
    return "gray";
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <FileText className="w-7 h-7 text-green-600" />
            Purchase Orders
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Create and track purchase orders for warehouse stock
          </p>
        </div>
        <div className="flex gap-2">
          {reorderAlerts.length > 0 && (
            <Button variant="secondary" onClick={createFromAlerts}>
              <AlertTriangle className="w-4 h-4 mr-1" />
              PO from Alerts ({reorderAlerts.length})
            </Button>
          )}
          <Button onClick={createBlankPO}>
            <Plus className="w-4 h-4 mr-1" />
            New PO
          </Button>
        </div>
      </div>

      {/* Success banner */}
      {success && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-sm text-green-700">
          <CheckCircle className="w-4 h-4 inline mr-1" />
          {success}
        </div>
      )}

      {/* Reorder alerts summary */}
      {reorderAlerts.length > 0 && !showCreate && (
        <div className="bg-orange-50 border border-orange-200 rounded-xl p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-orange-600" />
              <span className="text-sm font-medium text-orange-900">
                {reorderAlerts.length} item{reorderAlerts.length !== 1 ? "s" : ""} at or below reorder level
              </span>
            </div>
            <button
              onClick={createFromAlerts}
              className="text-xs text-orange-700 hover:underline font-medium"
            >
              Create PO for all &rarr;
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {reorderAlerts.slice(0, 5).map((a: ReorderAlert) => (
              <span key={a.id} className="text-xs bg-orange-100 text-orange-800 px-2 py-1 rounded">
                {a.item_name} ({a.physical_qty}/{a.reorder_level})
              </span>
            ))}
            {reorderAlerts.length > 5 && (
              <span className="text-xs text-orange-600">+{reorderAlerts.length - 5} more</span>
            )}
          </div>
        </div>
      )}

      {/* Create PO form */}
      {showCreate && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">New Purchase Order</h2>
            <button onClick={() => setShowCreate(false)} className="text-gray-400 hover:text-gray-600">
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Supplier *</label>
              <Input
                value={poSupplier}
                onChange={(e: any) => setPoSupplier(e.target.value)}
                placeholder="Supplier name"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Expected Date</label>
              <Input
                type="date"
                value={poExpectedDate}
                onChange={(e: any) => setPoExpectedDate(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
              <Input
                value={poNotes}
                onChange={(e: any) => setPoNotes(e.target.value)}
                placeholder="Optional"
              />
            </div>
          </div>

          {/* PO Line items */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-700">Order Items</h3>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => { setSearch(""); setShowPicker(true); }}
              >
                <Plus className="w-4 h-4 mr-1" />
                Add Item
              </Button>
            </div>

            {poLines.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-6">
                No items added. Click &quot;Add Item&quot; or create from reorder alerts.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 bg-gray-50">
                      <th className="text-left px-3 py-2 font-medium text-gray-600">Item</th>
                      <th className="text-left px-3 py-2 font-medium text-gray-600">SKU</th>
                      <th className="text-right px-3 py-2 font-medium text-gray-600">Qty</th>
                      <th className="text-right px-3 py-2 font-medium text-gray-600">Unit Cost</th>
                      <th className="text-right px-3 py-2 font-medium text-gray-600">Line Total</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {poLines.map((line: NewPOLine) => (
                      <tr key={line.localId}>
                        <td className="px-3 py-2 font-medium text-gray-900">{line.itemName}</td>
                        <td className="px-3 py-2 font-mono text-xs text-gray-500">{line.sku}</td>
                        <td className="px-3 py-2 text-right">
                          <input
                            type="number"
                            min="1"
                            value={line.qtyOrdered}
                            onChange={(e: any) => updatePOLine(line.localId, "qtyOrdered", parseInt(e.target.value) || 1)}
                            className="w-20 text-right border border-gray-300 rounded px-2 py-1 text-sm"
                          />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={line.unitCost}
                            onChange={(e: any) => updatePOLine(line.localId, "unitCost", parseFloat(e.target.value) || 0)}
                            className="w-24 text-right border border-gray-300 rounded px-2 py-1 text-sm"
                          />
                        </td>
                        <td className="px-3 py-2 text-right text-gray-700">
                          {formatZAR(line.qtyOrdered * line.unitCost)}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <button onClick={() => removePOLine(line.localId)} className="text-gray-400 hover:text-red-500">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-gray-200 bg-gray-50">
                      <td colSpan={4} className="px-3 py-2 text-right font-medium text-gray-700">Total:</td>
                      <td className="px-3 py-2 text-right font-bold text-gray-900">
                        {formatZAR(poLines.reduce((sum: number, l: NewPOLine) => sum + l.qtyOrdered * l.unitCost, 0))}
                      </td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={savePO} disabled={saving || poLines.length === 0 || !poSupplier.trim()}>
              <FileText className="w-4 h-4 mr-1" />
              {saving ? "Saving..." : "Create PO"}
            </Button>
          </div>
        </div>
      )}

      {/* PO List */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-200 bg-gray-50">
          <h2 className="text-sm font-semibold text-gray-700">Purchase Orders</h2>
        </div>

        {orders.length === 0 ? (
          <div className="text-center py-12">
            <Package className="w-12 h-12 mx-auto text-gray-300 mb-3" />
            <p className="text-gray-500">No purchase orders yet</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="w-8 px-2 py-3"></th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">PO #</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Supplier</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Expected</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Created</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {orders.map((po: POHeader) => {
                  const isExpanded = expandedId === po.id;
                  const detailItems = detailCache.get(po.id);
                  return (
                    <>
                      <tr
                        key={po.id}
                        className={"cursor-pointer transition-colors " + (isExpanded ? "bg-green-50/50" : "hover:bg-gray-50")}
                        onClick={() => toggleExpand(po.id)}
                      >
                        <td className="px-2 py-3 text-gray-400">
                          {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        </td>
                        <td className="px-4 py-3 font-mono text-sm font-medium text-gray-900">{po.po_number}</td>
                        <td className="px-4 py-3 text-gray-900">{po.supplier}</td>
                        <td className="px-4 py-3">
                          <Badge color={statusColor(po.status)}>{po.status}</Badge>
                        </td>
                        <td className="px-4 py-3 text-gray-500">
                          {po.expected_date ? formatDate(po.expected_date) : "—"}
                        </td>
                        <td className="px-4 py-3 text-gray-500">{formatDate(po.created_at)}</td>
                        <td className="px-4 py-3 text-center" onClick={(e: any) => e.stopPropagation()}>
                          {po.status === "Draft" && (
                            <>
                              <button
                                onClick={() => updatePOStatus(po.id, "Sent")}
                                className="text-xs text-blue-600 hover:underline mr-2"
                              >
                                Mark Sent
                              </button>
                              <button
                                onClick={() => updatePOStatus(po.id, "Cancelled")}
                                className="text-xs text-red-600 hover:underline"
                              >
                                Cancel
                              </button>
                            </>
                          )}
                          {(po.status === "Sent" || po.status === "Partially Received") && (
                            <button
                              onClick={() => {
                                if (!detailCache.has(po.id)) {
                                  toggleExpand(po.id).then(() => openReceiveModal(po.id));
                                } else {
                                  openReceiveModal(po.id);
                                }
                              }}
                              className="text-xs text-green-600 hover:underline"
                            >
                              <PackagePlus className="w-3 h-3 inline mr-0.5" />
                              Receive Stock
                            </button>
                          )}
                          {po.status === "Received" && (
                            <span className="text-xs text-gray-400">Complete</span>
                          )}
                          {po.status === "Cancelled" && (
                            <span className="text-xs text-gray-400">Cancelled</span>
                          )}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr key={"detail-" + po.id}>
                          <td colSpan={7} className="bg-gray-50/80 px-4 py-3">
                            {detailLoading && !detailItems ? (
                              <p className="text-xs text-gray-400 py-2">Loading items...</p>
                            ) : !detailItems || detailItems.length === 0 ? (
                              <p className="text-xs text-gray-400 py-2">No line items found.</p>
                            ) : (
                              <div className="ml-6">
                                {po.notes && (
                                  <p className="text-xs text-gray-500 mb-2">
                                    <span className="font-medium">Notes:</span> {po.notes}
                                  </p>
                                )}
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className="border-b border-gray-200">
                                      <th className="text-left py-1.5 pr-4 font-medium text-gray-500">Item</th>
                                      <th className="text-left py-1.5 pr-4 font-medium text-gray-500">SKU</th>
                                      <th className="text-right py-1.5 pr-4 font-medium text-gray-500">Ordered</th>
                                      <th className="text-right py-1.5 pr-4 font-medium text-gray-500">Received</th>
                                      <th className="text-right py-1.5 pr-4 font-medium text-gray-500">Unit Cost</th>
                                      <th className="text-right py-1.5 font-medium text-gray-500">Line Total</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-gray-100">
                                    {detailItems.map((item: POLineItem) => (
                                      <tr key={item.id}>
                                        <td className="py-1.5 pr-4 text-gray-900">{item.item_name}</td>
                                        <td className="py-1.5 pr-4 font-mono text-gray-500">{item.sku}</td>
                                        <td className="py-1.5 pr-4 text-right text-gray-900">{item.qty_ordered}</td>
                                        <td className="py-1.5 pr-4 text-right">
                                          <span className={item.qty_received >= item.qty_ordered ? "text-green-600 font-medium" : "text-orange-600"}>
                                            {item.qty_received}
                                          </span>
                                        </td>
                                        <td className="py-1.5 pr-4 text-right text-gray-700">{formatZAR(item.unit_cost)}</td>
                                        <td className="py-1.5 text-right font-medium text-gray-900">{formatZAR(item.line_total)}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                  <tfoot>
                                    <tr className="border-t border-gray-200">
                                      <td colSpan={5} className="py-1.5 text-right font-medium text-gray-600">Total:</td>
                                      <td className="py-1.5 text-right font-bold text-gray-900">
                                        {formatZAR(detailItems.reduce((sum: number, i: POLineItem) => sum + i.line_total, 0))}
                                      </td>
                                    </tr>
                                  </tfoot>
                                </table>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Item Picker Modal */}
      {showPicker && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-lg w-full max-h-[70vh] flex flex-col">
            <div className="p-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900 mb-3">Add Item to PO</h3>
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
                    onClick={() => addPOLine(item)}
                    className="w-full text-left px-3 py-2.5 rounded-lg transition-colors flex items-center justify-between hover:bg-green-50"
                  >
                    <div>
                      <p className="font-medium text-gray-900 text-sm">{item.item_name}</p>
                      <p className="text-xs text-gray-500">SKU: {item.sku}</p>
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

      {/* Receive Stock Modal */}
      {receivePoId !== null && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[80vh] flex flex-col">
            <div className="p-4 border-b border-gray-200 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">
                Receive Stock
              </h3>
              <button onClick={() => setReceivePoId(null)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="overflow-y-auto flex-1 p-4">
              <p className="text-sm text-gray-500 mb-4">
                Enter the quantities received for each item. This will create a receipt and update warehouse inventory.
              </p>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50">
                    <th className="text-left px-3 py-2 font-medium text-gray-600">Item</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Ordered</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Already Rcvd</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Remaining</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Receive Now</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {receiveItems.map((item: POLineItem) => {
                    const remaining = item.qty_ordered - item.qty_received;
                    const receiveQty = receiveQtys.get(item.id) || 0;
                    return (
                      <tr key={item.id}>
                        <td className="px-3 py-2">
                          <p className="font-medium text-gray-900">{item.item_name}</p>
                          <p className="text-xs text-gray-500">{item.sku}</p>
                        </td>
                        <td className="px-3 py-2 text-right text-gray-700">{item.qty_ordered}</td>
                        <td className="px-3 py-2 text-right text-gray-500">{item.qty_received}</td>
                        <td className="px-3 py-2 text-right text-gray-700">{remaining}</td>
                        <td className="px-3 py-2 text-right">
                          <input
                            type="number"
                            min="0"
                            max={remaining}
                            value={receiveQty}
                            onChange={(e: any) => updateReceiveQty(item.id, parseInt(e.target.value) || 0)}
                            className={"w-20 text-right border rounded px-2 py-1 text-sm " + (
                              receiveQty > remaining ? "border-red-400 text-red-600" : "border-gray-300"
                            )}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="p-4 border-t border-gray-200 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setReceivePoId(null)}>Cancel</Button>
              <Button onClick={processReceive} disabled={receiving}>
                <PackagePlus className="w-4 h-4 mr-1" />
                {receiving ? "Processing..." : "Receive Stock"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
