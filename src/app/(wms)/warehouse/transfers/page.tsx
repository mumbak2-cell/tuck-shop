"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { db } from "@/lib/supabase";
import { fetchAllPaged } from "@/lib/fetch-all";
import { useAuth } from "@/lib/auth-context";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { LocationPicker, type WmsLocationOption } from "@/components/wms/location-picker";
import { ItemPickerModal, type WmsCatalogPickerItem } from "@/components/wms/item-picker-modal";
import {
  ArrowLeftRight,
  Plus,
  Trash2,
  RefreshCw,
  Package,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

interface WmsCatalogItem {
  id: number;
  sku: string;
  item_name: string;
  category: string | null;
  barcode: string | null;
}

interface TransferLine {
  wms_item_id: number;
  item_name: string;
  sku: string;
  qty: number;
}

interface TransferHeader {
  id: number;
  source_location_id: string;
  dest_location_id: string;
  status: "In Transit" | "Received" | "Cancelled";
  notes: string | null;
  created_by: string | null;
  created_at: string;
  completed_at: string | null;
}

interface TransferItemRow {
  id: number;
  transfer_id: number;
  wms_item_id: number;
  qty: number;
  avg_cost: number | null;
  item_name?: string;
  sku?: string;
}

type TransferTab = "In Transit" | "Received" | "Cancelled";

// There's no shared transferStatusColor yet — inlined here per the same
// pattern as dispatchStatusColor / poStatusColor in wms-status.ts. If a
// second place needs this mapping, extract it there.
function transferStatusColor(s: string): "amber" | "green" | "red" | "gray" {
  if (s === "In Transit") return "amber";
  if (s === "Received") return "green";
  if (s === "Cancelled") return "red";
  return "gray";
}

export default function WarehouseTransfersPage() {
  const { name: userName } = useAuth();
  const toast = useToast();

  // Data
  const [locations, setLocations] = useState<WmsLocationOption[]>([]);
  const [catalogItems, setCatalogItems] = useState<WmsCatalogItem[]>([]);
  const [transfers, setTransfers] = useState<TransferHeader[]>([]);
  const [transferItems, setTransferItems] = useState<TransferItemRow[]>([]);

  // Create form
  const [sourceLocationId, setSourceLocationId] = useState("");
  const [destLocationId, setDestLocationId] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<TransferLine[]>([]);
  const [saving, setSaving] = useState(false);
  const [showPicker, setShowPicker] = useState(false);

  // History
  const [tab, setTab] = useState<TransferTab>("In Transit");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [cancelTargetId, setCancelTargetId] = useState<number | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [locs, catalog, { data: transfersData, error: transfersErr }] = await Promise.all([
        fetchAllPaged<WmsLocationOption>(() =>
          db.from("wms_locations").select("id, code, label, kind, active").order("code")
        ),
        fetchAllPaged<WmsCatalogItem>(() =>
          db.from("wms_catalog").select("id, sku, item_name, category, barcode").order("item_name")
        ),
        db.from("wms_transfers").select("*").order("created_at", { ascending: false }).limit(100),
      ]);
      if (transfersErr) throw transfersErr;

      setLocations(locs);
      setCatalogItems(catalog);
      const headers = (transfersData || []) as TransferHeader[];
      setTransfers(headers);

      const transferIds = headers.map((t: TransferHeader) => t.id);
      if (transferIds.length > 0) {
        const { data: itemsData, error: itemsErr } = await db
          .from("wms_transfer_items")
          .select("id, transfer_id, wms_item_id, qty, avg_cost")
          .in("transfer_id", transferIds);
        if (itemsErr) throw itemsErr;
        setTransferItems((itemsData || []) as TransferItemRow[]);
      } else {
        setTransferItems([]);
      }
    } catch (err: any) {
      toast.error("Failed to load transfers", { hint: err.message });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const catalogMap = useMemo(
    () => new Map(catalogItems.map((c: WmsCatalogItem) => [c.id, c])),
    [catalogItems]
  );
  const locationMap = useMemo(
    () => new Map(locations.map((l: WmsLocationOption) => [l.id, l])),
    [locations]
  );

  const itemsByTransfer = useMemo(() => {
    const map = new Map<number, TransferItemRow[]>();
    for (const row of transferItems) {
      const catalogItem = catalogMap.get(row.wms_item_id);
      const enriched: TransferItemRow = {
        ...row,
        item_name: catalogItem?.item_name,
        sku: catalogItem?.sku,
      };
      const arr = map.get(row.transfer_id) ?? [];
      arr.push(enriched);
      map.set(row.transfer_id, arr);
    }
    return map;
  }, [transferItems, catalogMap]);

  const counts = useMemo(() => {
    const c: Record<TransferTab, number> = { "In Transit": 0, Received: 0, Cancelled: 0 };
    for (const t of transfers) c[t.status]++;
    return c;
  }, [transfers]);

  const filteredTransfers = useMemo(
    () => transfers.filter((t: TransferHeader) => t.status === tab),
    [transfers, tab]
  );

  function locationCode(id: string): string {
    return locationMap.get(id)?.code ?? "—";
  }

  function addLine(item: WmsCatalogPickerItem) {
    if (lines.some((l: TransferLine) => l.wms_item_id === item.id)) {
      setShowPicker(false);
      return;
    }
    setLines((prev: TransferLine[]) => [
      ...prev,
      { wms_item_id: item.id, item_name: item.item_name, sku: item.sku, qty: 1 },
    ]);
    setShowPicker(false);
  }

  function updateLineQty(wmsItemId: number, qty: number) {
    setLines((prev: TransferLine[]) =>
      prev.map((l: TransferLine) => (l.wms_item_id === wmsItemId ? { ...l, qty } : l))
    );
  }

  function removeLine(wmsItemId: number) {
    setLines((prev: TransferLine[]) => prev.filter((l: TransferLine) => l.wms_item_id !== wmsItemId));
  }

  function resetForm() {
    setSourceLocationId("");
    setDestLocationId("");
    setNotes("");
    setLines([]);
  }

  const canSubmit =
    !!sourceLocationId &&
    !!destLocationId &&
    sourceLocationId !== destLocationId &&
    lines.length > 0 &&
    lines.some((l: TransferLine) => l.qty > 0);

  async function handleCreate() {
    if (!canSubmit) return;
    setSaving(true);
    try {
      const { error } = await db.rpc("create_wms_transfer", {
        p_source_location_id: sourceLocationId,
        p_dest_location_id: destLocationId,
        p_items: lines.map((l: TransferLine) => ({ wms_item_id: l.wms_item_id, qty: l.qty })),
        p_notes: notes || null,
        p_created_by: userName ?? null,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) {
        const isFreeze = /frozen by count session/i.test(error.message || "");
        toast.error(
          isFreeze
            ? "Cannot transfer: a stock count is frozen for one of these items"
            : "Failed to create transfer",
          { hint: error.message }
        );
        return;
      }
      toast.success("Transfer created — In Transit");
      resetForm();
      await loadData();
    } finally {
      setSaving(false);
    }
  }

  async function handleReceive(transferId: number) {
    const { error } = await db.rpc("receive_wms_transfer", {
      p_transfer_id: transferId,
      p_actor: userName ?? null,
      p_idempotency_key: crypto.randomUUID(),
    });
    if (error) {
      toast.error("Failed to receive", { hint: error.message });
      return;
    }
    toast.success("Transfer received");
    await loadData();
  }

  async function handleCancel(transferId: number) {
    const { error } = await db.rpc("cancel_wms_transfer", {
      p_transfer_id: transferId,
      p_actor: userName ?? null,
      p_idempotency_key: crypto.randomUUID(),
    });
    if (error) {
      toast.error("Failed to cancel", { hint: error.message });
      return;
    }
    toast.success("Transfer cancelled — stock returned to source");
    await loadData();
  }

  const pickerItems: WmsCatalogPickerItem[] = catalogItems.map((item: WmsCatalogItem) => ({
    id: item.id,
    sku: item.sku,
    item_name: item.item_name,
    category: item.category,
    barcode: item.barcode,
  }));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <ArrowLeftRight className="w-7 h-7 text-green-600" />
            Warehouse Transfers
          </h1>
          <p className="text-sm text-gray-500 mt-1">Move stock between bins.</p>
        </div>
        <Button variant="secondary" size="sm" onClick={loadData}>
          <RefreshCw className="w-4 h-4 mr-1" />
          Refresh
        </Button>
      </div>

      {/* Create transfer form */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Source bin</label>
            <LocationPicker
              value={sourceLocationId || null}
              onChange={setSourceLocationId}
              locations={locations}
              placeholder="Select source bin…"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Destination bin</label>
            <LocationPicker
              value={destLocationId || null}
              onChange={setDestLocationId}
              locations={locations}
              excludeIds={sourceLocationId ? [sourceLocationId] : undefined}
              placeholder="Select destination bin…"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
          <textarea
            value={notes}
            onChange={(e: any) => setNotes(e.target.value)}
            rows={2}
            placeholder="Optional"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-700">Items</h3>
            <Button variant="secondary" size="sm" onClick={() => setShowPicker(true)}>
              <Plus className="w-4 h-4 mr-1" />
              Add item
            </Button>
          </div>

          {lines.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-6">
              No items added. Click &quot;Add item&quot; to begin.
            </p>
          ) : (
            <div className="space-y-2">
              {lines.map((line: TransferLine) => (
                <div
                  key={line.wms_item_id}
                  className="flex items-center gap-3 bg-gray-50 rounded-lg px-3 py-2"
                >
                  <div className="flex-1 min-w-0">
                    <span className="font-medium text-gray-900">{line.item_name}</span>
                    <span className="text-gray-400 text-xs ml-2 font-mono">{line.sku}</span>
                  </div>
                  <input
                    type="number"
                    min="1"
                    value={line.qty}
                    onChange={(e: any) => updateLineQty(line.wms_item_id, parseInt(e.target.value) || 1)}
                    className="w-20 text-right border border-gray-300 rounded px-2 py-1 text-sm"
                  />
                  <Tooltip label="Remove line">
                    <button
                      onClick={() => removeLine(line.wms_item_id)}
                      aria-label="Remove line"
                      className="text-gray-400 hover:text-red-500 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </Tooltip>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={resetForm} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={saving || !canSubmit}>
            {saving ? "Creating..." : "Create transfer"}
          </Button>
        </div>
      </div>

      {/* History tabs */}
      <div className="flex gap-1 bg-gray-100 rounded-lg p-1 w-fit">
        {(["In Transit", "Received", "Cancelled"] as TransferTab[]).map((t: TransferTab) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              tab === t ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {t} ({counts[t]})
          </button>
        ))}
      </div>

      {/* Transfer list */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {filteredTransfers.length === 0 ? (
          <div className="text-center py-12">
            <Package className="w-12 h-12 mx-auto text-gray-300 mb-3" />
            <p className="text-gray-500">No {tab.toLowerCase()} transfers</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="w-8 px-2 py-3"></th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Date</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">
                    Source → Destination
                  </th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Items</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredTransfers.map((t: TransferHeader) => {
                  const isExpanded = expandedId === t.id;
                  const items = itemsByTransfer.get(t.id) ?? [];
                  const previewNames = items
                    .slice(0, 3)
                    .map((i: TransferItemRow) => i.item_name || "Unknown")
                    .join(", ");
                  return (
                    <>
                      <tr
                        key={t.id}
                        className={"cursor-pointer transition-colors " + (isExpanded ? "bg-green-50/50" : "hover:bg-gray-50")}
                        onClick={() => setExpandedId(isExpanded ? null : t.id)}
                      >
                        <td className="px-2 py-3 text-gray-400">
                          {isExpanded ? (
                            <ChevronDown className="w-4 h-4" />
                          ) : (
                            <ChevronRight className="w-4 h-4" />
                          )}
                        </td>
                        <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                          {formatDate(t.created_at)}
                        </td>
                        <td className="px-4 py-3 text-gray-900">
                          <span className="font-mono text-xs">{locationCode(t.source_location_id)}</span>
                          {" → "}
                          <span className="font-mono text-xs">{locationCode(t.dest_location_id)}</span>
                        </td>
                        <td className="px-4 py-3 text-gray-500">
                          <Tooltip label={previewNames || "No items"}>
                            <span>
                              {items.length} item{items.length === 1 ? "" : "s"}
                            </span>
                          </Tooltip>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={transferStatusColor(t.status)}>{t.status}</Badge>
                        </td>
                        <td className="px-4 py-3 text-center" onClick={(e: any) => e.stopPropagation()}>
                          {t.status === "In Transit" ? (
                            <div className="flex items-center justify-center gap-2">
                              <Button variant="primary" size="sm" onClick={() => handleReceive(t.id)}>
                                Receive
                              </Button>
                              <Button variant="danger" size="sm" onClick={() => setCancelTargetId(t.id)}>
                                Cancel
                              </Button>
                            </div>
                          ) : null}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr key={"detail-" + t.id}>
                          <td colSpan={6} className="bg-gray-50/80 px-4 py-3">
                            {items.length === 0 ? (
                              <p className="text-xs text-gray-400 py-2">No line items found.</p>
                            ) : (
                              <div className="ml-6">
                                {t.notes && (
                                  <p className="text-xs text-gray-500 mb-2">
                                    <span className="font-medium">Notes:</span> {t.notes}
                                  </p>
                                )}
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className="border-b border-gray-200">
                                      <th className="text-left py-1.5 pr-4 font-medium text-gray-500">Item</th>
                                      <th className="text-left py-1.5 pr-4 font-medium text-gray-500">SKU</th>
                                      <th className="text-right py-1.5 font-medium text-gray-500">Qty</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-gray-100">
                                    {items.map((item: TransferItemRow) => (
                                      <tr key={item.id}>
                                        <td className="py-1.5 pr-4 text-gray-900">
                                          {item.item_name || "Unknown"}
                                        </td>
                                        <td className="py-1.5 pr-4 font-mono text-gray-500">
                                          {item.sku || ""}
                                        </td>
                                        <td className="py-1.5 text-right font-medium text-gray-900">
                                          {item.qty}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
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

      <ItemPickerModal
        open={showPicker}
        onClose={() => setShowPicker(false)}
        onPick={addLine}
        items={pickerItems}
        excludeIds={lines.map((l: TransferLine) => l.wms_item_id)}
        title="Select item to transfer"
      />

      <Modal
        open={cancelTargetId !== null}
        onClose={() => setCancelTargetId(null)}
        title="Cancel this transfer?"
      >
        <p className="text-sm text-gray-600 mb-4">
          Stock will return to the source bin. This cannot be undone.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setCancelTargetId(null)}>
            Never mind
          </Button>
          <Button
            variant="danger"
            onClick={async () => {
              if (cancelTargetId !== null) {
                await handleCancel(cancelTargetId);
              }
              setCancelTargetId(null);
            }}
          >
            Cancel transfer
          </Button>
        </div>
      </Modal>
    </div>
  );
}
