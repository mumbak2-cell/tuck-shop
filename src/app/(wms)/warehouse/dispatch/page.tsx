"use client";
import { useEffect, useState, useCallback } from "react";
import { db } from "@/lib/supabase";
import { fetchAllPaged } from "@/lib/fetch-all";
import { useAuth } from "@/lib/auth-context";
import { useOrg, type LocationRow } from "@/lib/org-context";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { TruncatedText } from "@/components/ui/truncate";
import { Avatar } from "@/components/ui/timeline";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { dispatchStatusColor } from "@/lib/wms-status";
import { ItemPickerModal, type WmsCatalogPickerItem } from "@/components/wms/item-picker-modal";
import { LocationPicker, type WmsLocationOption } from "@/components/wms/location-picker";
import { useToast } from "@/components/ui/toast";
import { BarcodeScanInput } from "@/components/wms/barcode-scan-input";
import {
  Truck,
  Plus,
  Trash2,
  Send,
  History,
  Package,
  CheckCircle,
  Clock,
  ArrowRight,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

interface WmsCatalogItem {
  id: number;
  sku: string;
  item_name: string;
  pack_size: number;
  barcode: string | null;
  product_id: string | null;
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
  productId: string | null;
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

interface DispatchDetailItem {
  id: number;
  wms_item_id: number;
  item_name: string;
  sku: string;
  qty_sent: number;
  picked_qty: number | null;
  packed_qty: number | null;
}

type DestinationType = "Internal Shop" | "External Client" | "Wholesale";

export default function WmsDispatchPage() {
  const { name: userName } = useAuth();
  const { locations } = useOrg();
  const toast = useToast();

  // Data
  const [catalogItems, setCatalogItems] = useState<WmsCatalogItem[]>([]);
  const [inventoryMap, setInventoryMap] = useState<Map<number, number>>(new Map());
  const [history, setHistory] = useState<PastDispatch[]>([]);
  // WMS bins for the pick/pack/ship source-bin picker. Named distinctly from
  // useOrg()'s `locations` (shop branches) below — same word, different table.
  const [wmsLocations, setWmsLocations] = useState<WmsLocationOption[]>([]);

  // Form
  const [flowMode, setFlowMode] = useState<"instant" | "ppship">("instant");
  const [destinationType, setDestinationType] = useState<DestinationType>("Internal Shop");
  const [destinationId, setDestinationId] = useState("");
  const [destinationLocationId, setDestinationLocationId] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DispatchLine[]>([]);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  // UI
  const [tab, setTab] = useState<"new" | "history">("new");
  const [showPicker, setShowPicker] = useState(false);
  const [scanValue, setScanValue] = useState("");

  // Inline expand for history
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [detailCache, setDetailCache] = useState<Map<number, DispatchDetailItem[]>>(new Map());
  const [detailLoading, setDetailLoading] = useState(false);

  // Pick/pack/ship action panel drafts. Only one history row is ever expanded
  // at a time, so these are scoped to the currently-expanded dispatch and
  // reset on every toggleExpand.
  const [pickDraft, setPickDraft] = useState<Map<number, { picked_qty: number; source_location_id: string | null }>>(new Map());
  const [packDraft, setPackDraft] = useState<Map<number, number>>(new Map());
  const [carrierRef, setCarrierRef] = useState("");
  const [panelSaving, setPanelSaving] = useState(false);

  const loadData = useCallback(async () => {
    const [catalog, inventory, { data: dispatches }, { data: wmsLocs, error: locErr }] =
      await Promise.all([
        fetchAllPaged<WmsCatalogItem>(() => db.from("wms_catalog").select("id, sku, item_name, pack_size, barcode, product_id").order("item_name")),
        fetchAllPaged<WmsInventoryRow>(() => db.from("wms_inventory").select("wms_item_id, physical_qty")),
        db
          .from("wms_dispatches")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(50),
        db.from("wms_locations").select("id, code, label, kind, active").order("code"),
      ]);

    setCatalogItems(catalog as any[]);

    const invMap = new Map<number, number>();
    (inventory as any[]).forEach((row: any) => {
      invMap.set(row.wms_item_id, row.physical_qty);
    });
    setInventoryMap(invMap);

    setHistory((dispatches || []) as any[]);

    if (locErr) {
      toast.error("Failed to load locations", { hint: locErr.message });
      setWmsLocations([]);
    } else {
      setWmsLocations((wmsLocs || []) as WmsLocationOption[]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Shared item-loading logic for both the initial expand and post-action
  // panel refreshes (picking/packing/shipping change picked_qty/packed_qty,
  // so the cached row needs re-fetching, not just a status flip).
  async function fetchDispatchItems(dispatchId: number): Promise<DispatchDetailItem[]> {
    const { data: items } = await db
      .from("wms_dispatch_items")
      .select("id, wms_item_id, qty_sent, picked_qty, packed_qty, wms_catalog(item_name, sku)")
      .eq("dispatch_id", dispatchId);

    const parsed: DispatchDetailItem[] = ((items || []) as any[]).map((row: any) => ({
      id: row.id,
      wms_item_id: row.wms_item_id,
      qty_sent: row.qty_sent,
      picked_qty: row.picked_qty,
      packed_qty: row.packed_qty,
      item_name: row.wms_catalog?.item_name || "Unknown",
      sku: row.wms_catalog?.sku || "",
    }));

    setDetailCache((prev: Map<number, DispatchDetailItem[]>) => {
      const next = new Map(prev);
      next.set(dispatchId, parsed);
      return next;
    });
    return parsed;
  }

  // Seeds the pick/pack draft maps from freshly-loaded items. Takes status
  // explicitly (rather than reading it off `history`) because callers use
  // this right after an RPC transitions the dispatch, before `history` has
  // been reloaded — reading `history` here would use the pre-transition status.
  function initPanelDrafts(items: DispatchDetailItem[], status: string) {
    if (status === "Draft") {
      const next = new Map<number, { picked_qty: number; source_location_id: string | null }>();
      items.forEach((it: DispatchDetailItem) => {
        next.set(it.id, { picked_qty: it.qty_sent, source_location_id: mainBinId });
      });
      setPickDraft(next);
      setPackDraft(new Map());
    } else if (status === "Picked") {
      const next = new Map<number, number>();
      items.forEach((it: DispatchDetailItem) => {
        next.set(it.id, it.picked_qty ?? it.qty_sent);
      });
      setPackDraft(next);
      setPickDraft(new Map());
    } else {
      setPickDraft(new Map());
      setPackDraft(new Map());
    }
  }

  async function toggleExpand(dispatchId: number, status: string) {
    if (expandedId === dispatchId) {
      setExpandedId(null);
      return;
    }

    setExpandedId(dispatchId);
    setCarrierRef("");

    // Check cache
    if (detailCache.has(dispatchId)) {
      initPanelDrafts(detailCache.get(dispatchId)!, status);
      return;
    }

    setDetailLoading(true);
    const parsed = await fetchDispatchItems(dispatchId);
    setDetailLoading(false);
    initPanelDrafts(parsed, status);
  }

  function updatePickDraftQty(itemId: number, qty: number) {
    setPickDraft((prev) => {
      const next = new Map(prev);
      const cur = next.get(itemId);
      next.set(itemId, { picked_qty: qty, source_location_id: cur?.source_location_id ?? mainBinId });
      return next;
    });
  }

  function updatePickDraftLocation(itemId: number, locId: string) {
    setPickDraft((prev) => {
      const next = new Map(prev);
      const cur = next.get(itemId);
      next.set(itemId, { picked_qty: cur?.picked_qty ?? 0, source_location_id: locId });
      return next;
    });
  }

  function updatePackDraftQty(itemId: number, qty: number) {
    setPackDraft((prev) => {
      const next = new Map(prev);
      next.set(itemId, qty);
      return next;
    });
  }

  function freshIdempotencyKey(): string | null {
    return typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : null;
  }

  function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
    );
  }

  async function handleSendToPicking(dispatch: PastDispatch, items: DispatchDetailItem[]) {
    setPanelSaving(true);
    try {
      const picks = items.map((it: DispatchDetailItem) => {
        const draft = pickDraft.get(it.id);
        return {
          dispatch_item_id: it.id,
          picked_qty: draft?.picked_qty ?? it.qty_sent,
          from_location_id: draft?.source_location_id ?? mainBinId,
        };
      });
      const { error } = await db.rpc("pick_wms_dispatch", {
        p_dispatch_id: dispatch.id,
        p_picks: picks,
        p_actor: userName || null,
        p_idempotency_key: freshIdempotencyKey(),
      });
      if (error) throw error;
      toast.success("Picked — ready to pack");
      const refreshed = await fetchDispatchItems(dispatch.id);
      initPanelDrafts(refreshed, "Picked");
      await loadData();
    } catch (err: any) {
      console.error("Pick error:", err);
      const isFreeze = /frozen by count session/i.test(err.message || "");
      toast.error(
        isFreeze ? "Cannot dispatch: a stock count is frozen for one of these items" : "Failed to send to picking",
        { hint: err.message }
      );
    } finally {
      setPanelSaving(false);
    }
  }

  async function handleVerifyPack(dispatch: PastDispatch, items: DispatchDetailItem[]) {
    setPanelSaving(true);
    try {
      const verifies = items.map((it: DispatchDetailItem) => ({
        dispatch_item_id: it.id,
        packed_qty: packDraft.get(it.id) ?? (it.picked_qty ?? it.qty_sent),
      }));
      const { error } = await db.rpc("pack_wms_dispatch", {
        p_dispatch_id: dispatch.id,
        p_verifies: verifies,
        p_actor: userName || null,
        p_idempotency_key: freshIdempotencyKey(),
      });
      if (error) throw error;
      toast.success("Packed — ready to ship");
      const refreshed = await fetchDispatchItems(dispatch.id);
      initPanelDrafts(refreshed, "Packed");
      await loadData();
    } catch (err: any) {
      console.error("Pack error:", err);
      const isMismatch = err.code === "22023";
      toast.error(
        isMismatch ? "Pack count must match picked count" : "Failed to verify pack",
        { hint: err.message }
      );
    } finally {
      setPanelSaving(false);
    }
  }

  async function handleShip(dispatch: PastDispatch) {
    setPanelSaving(true);
    try {
      const { error } = await db.rpc("ship_wms_dispatch", {
        p_dispatch_id: dispatch.id,
        p_carrier_ref: carrierRef.trim() || null,
        p_actor: userName || null,
        p_idempotency_key: freshIdempotencyKey(),
      });
      if (error) throw error;
      toast.success("Shipped");
      setCarrierRef("");
      await loadData();
    } catch (err: any) {
      console.error("Ship error:", err);
      toast.error("Failed to ship dispatch", { hint: err.message });
    } finally {
      setPanelSaving(false);
    }
  }

  function printPackingSlip(dispatch: PastDispatch, items: DispatchDetailItem[]) {
    const printWindow = window.open("", "_blank", "width=400,height=600");
    if (!printWindow) return;
    const rows = items
      .map(
        (it: DispatchDetailItem) =>
          "<tr><td style=\"padding:4px 8px;border-bottom:1px solid #eee\">" + escapeHtml(it.item_name) + "</td>" +
          "<td style=\"padding:4px 8px;border-bottom:1px solid #eee;font-family:monospace\">" + escapeHtml(it.sku) + "</td>" +
          "<td style=\"padding:4px 8px;border-bottom:1px solid #eee;text-align:right\">" + it.qty_sent + "</td></tr>"
      )
      .join("");
    printWindow.document.write(
      "<!DOCTYPE html><html><head><title>Packing Slip</title>" +
      "<style>body{font-family:Arial,sans-serif;padding:16px}table{width:100%;border-collapse:collapse}" +
      "th{text-align:left;padding:4px 8px;border-bottom:2px solid #333}@page{margin:12mm}</style>" +
      "</head><body>" +
      "<h2>Packing Slip — Dispatch #" + dispatch.id + "</h2>" +
      "<p>Destination: " + escapeHtml(dispatch.destination_type) + " — " + escapeHtml(dispatch.destination_id) + "</p>" +
      (dispatch.notes ? "<p>Notes: " + escapeHtml(dispatch.notes) + "</p>" : "") +
      "<table><thead><tr><th>Item</th><th>SKU</th><th style=\"text-align:right\">Qty</th></tr></thead>" +
      "<tbody>" + rows + "</tbody></table>" +
      "</body></html>"
    );
    printWindow.document.close();
    setTimeout(() => {
      printWindow.print();
      printWindow.close();
    }, 300);
  }

  function addLine(item: Pick<WmsCatalogItem, "id" | "item_name" | "sku">) {
    if (lines.some((l: DispatchLine) => l.wmsItemId === item.id)) {
      setShowPicker(false);
      return;
    }

    const available = inventoryMap.get(item.id) ?? 0;
    const productId = catalogItems.find((c: WmsCatalogItem) => c.id === item.id)?.product_id ?? null;

    setLines((prev: DispatchLine[]) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        wmsItemId: item.id,
        itemName: item.item_name,
        sku: item.sku,
        qty: 1,
        available,
        productId,
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

  // Default source bin for picking. Null when the org has no bin coded MAIN —
  // the Draft panel warns and disables Send to picking in that case.
  const mainBinId = wmsLocations.find((l: WmsLocationOption) => l.code === "MAIN")?.id ?? null;

  const destinationReady =
    destinationType === "Internal Shop"
      ? !!destinationLocationId
      : !!destinationId.trim();

  async function handleDispatch() {
    if (lines.length === 0 || !destinationReady || hasOverage) return;
    setSaving(true);
    setSuccess(false);

    try {
      const items = lines.map((l: DispatchLine) => ({
        wms_item_id: l.wmsItemId,
        qty: l.qty,
      }));

      const idempotencyKey =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : null;

      if (flowMode === "instant") {
        // One atomic RPC for every destination type. For Internal Shop it also
        // credits the destination location's retail stock (product_stock) via
        // add_product_stock_at_location; external/wholesale only deducts
        // warehouse stock. Header, line items and stock movements commit
        // together, and the subscription gate is enforced server-side.
        const { error } = await db.rpc("create_wms_dispatch", {
          p_destination_type: destinationType,
          p_destination_location_id:
            destinationType === "Internal Shop" ? destinationLocationId : null,
          p_destination_name:
            destinationType === "Internal Shop" ? null : destinationId.trim(),
          p_items: items,
          p_notes: notes.trim() || null,
          p_created_by: userName || null,
          p_idempotency_key: idempotencyKey,
        });

        if (error) throw error;
        const unlinked = lines.filter((l: DispatchLine) => !l.productId);
        if (destinationType === "Internal Shop" && unlinked.length > 0) {
          toast.error(
            `Dispatch created — ${unlinked.length} item(s) not credited to shop stock`,
            { hint: unlinked.map((l: DispatchLine) => l.itemName).join(", ") }
          );
        } else {
          toast.success("Dispatch created");
        }
      } else {
        // Draft flow: inserts at status Draft with no stock deduction. Picking,
        // packing and shipping happen as separate steps from the History tab.
        const { error } = await db.rpc("create_wms_dispatch_draft", {
          p_destination_type: destinationType,
          p_destination_location_id:
            destinationType === "Internal Shop" ? destinationLocationId : null,
          p_destination_name:
            destinationType === "Internal Shop" ? null : destinationId.trim(),
          p_items: items,
          p_notes: notes.trim() || null,
          p_created_by: userName || null,
          p_idempotency_key: idempotencyKey,
        });

        if (error) throw error;
        const unlinked = lines.filter((l: DispatchLine) => !l.productId);
        if (destinationType === "Internal Shop" && unlinked.length > 0) {
          toast.error(
            `Dispatch drafted — ${unlinked.length} item(s) won't credit shop stock when shipped`,
            { hint: unlinked.map((l: DispatchLine) => l.itemName).join(", ") }
          );
        } else {
          toast.success("Dispatch drafted — go to picking");
        }
      }

      setSuccess(true);
      setLines([]);
      setDestinationId("");
      setDestinationLocationId("");
      setNotes("");
      setDetailCache(new Map());
      await loadData();
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: any) {
      console.error("Dispatch error:", err);
      const isFreeze = /frozen by count session/i.test(err.message || "");
      toast.error(
        isFreeze ? "Cannot dispatch: a stock count is frozen for one of these items" : "Dispatch failed",
        { hint: err.message }
      );
    } finally {
      setSaving(false);
    }
  }

  async function updateDispatchStatus(id: number, newStatus: string) {
    const idempotencyKey =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : null;
    const { error } = await db.rpc("set_wms_dispatch_status", {
      p_dispatch_id: id,
      p_next_status: newStatus,
      p_actor: userName || null,
      p_idempotency_key: idempotencyKey,
    });
    if (error) {
      const illegal = /Illegal dispatch transition/i.test(error.message || "");
      toast.error(
        illegal ? "That status change is not allowed" : "Failed to update dispatch",
        { hint: error.message }
      );
      return;
    }
    await loadData();
  }

  const pickerItems: WmsCatalogPickerItem[] = catalogItems.map((item: WmsCatalogItem) => ({
    id: item.id,
    sku: item.sku,
    item_name: item.item_name,
    category: null,
    barcode: item.barcode,
    physical_qty: inventoryMap.get(item.id) ?? 0,
  }));

  const statusColor = dispatchStatusColor;

  // Stage-specific action panel appended below the existing read-only detail
  // table for Draft/Picked/Packed/Shipped dispatches. Older statuses
  // (Pending/Dispatched/Received/Cancelled) render nothing extra here.
  function renderActionPanel(d: PastDispatch, items: DispatchDetailItem[]) {
    if (d.status === "Draft") {
      return (
        <div className="ml-6 mt-4 border-t border-gray-200 pt-4">
          <h4 className="text-sm font-semibold text-gray-700 mb-2">Ready to pick</h4>
          {!mainBinId && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-700 mb-3">
              No MAIN bin found for this org. Add a location with code &quot;MAIN&quot; before picking.
            </div>
          )}
          <table className="w-full text-xs mb-3">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="text-left py-1.5 pr-4 font-medium text-gray-500">Item</th>
                <th className="text-left py-1.5 pr-4 font-medium text-gray-500">Source bin</th>
                <th className="text-right py-1.5 font-medium text-gray-500">Picked qty</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map((it: DispatchDetailItem) => {
                const draft = pickDraft.get(it.id);
                return (
                  <tr key={it.id}>
                    <td className="py-1.5 pr-4 text-gray-900">
                      {it.item_name} <span className="text-gray-400">(sent {it.qty_sent})</span>
                    </td>
                    <td className="py-1.5 pr-4" style={{ maxWidth: 220 }}>
                      <LocationPicker
                        value={draft?.source_location_id ?? mainBinId}
                        onChange={(id: string) => updatePickDraftLocation(it.id, id)}
                        locations={wmsLocations}
                        size="sm"
                      />
                    </td>
                    <td className="py-1.5 text-right">
                      <input
                        type="number"
                        min="0"
                        value={draft?.picked_qty ?? it.qty_sent}
                        onChange={(e: any) => updatePickDraftQty(it.id, parseInt(e.target.value) || 0)}
                        className="w-20 text-right border border-gray-300 rounded px-2 py-1 text-xs"
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <Button size="sm" onClick={() => handleSendToPicking(d, items)} disabled={panelSaving || !mainBinId}>
            Send to picking
          </Button>
        </div>
      );
    }

    if (d.status === "Picked") {
      return (
        <div className="ml-6 mt-4 border-t border-gray-200 pt-4">
          <h4 className="text-sm font-semibold text-gray-700 mb-2">Verify pack</h4>
          <table className="w-full text-xs mb-3">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="text-left py-1.5 pr-4 font-medium text-gray-500">Item</th>
                <th className="text-right py-1.5 pr-4 font-medium text-gray-500">Picked qty</th>
                <th className="text-right py-1.5 font-medium text-gray-500">Packed qty</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map((it: DispatchDetailItem) => (
                <tr key={it.id}>
                  <td className="py-1.5 pr-4 text-gray-900">{it.item_name}</td>
                  <td className="py-1.5 pr-4 text-right text-gray-500">{it.picked_qty ?? it.qty_sent}</td>
                  <td className="py-1.5 text-right">
                    <input
                      type="number"
                      min="0"
                      value={packDraft.get(it.id) ?? (it.picked_qty ?? it.qty_sent)}
                      onChange={(e: any) => updatePackDraftQty(it.id, parseInt(e.target.value) || 0)}
                      className="w-20 text-right border border-gray-300 rounded px-2 py-1 text-xs"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Button size="sm" onClick={() => handleVerifyPack(d, items)} disabled={panelSaving}>
            Verify pack
          </Button>
        </div>
      );
    }

    if (d.status === "Packed") {
      return (
        <div className="ml-6 mt-4 border-t border-gray-200 pt-4">
          <h4 className="text-sm font-semibold text-gray-700 mb-2">Ship</h4>
          <div className="mb-3 max-w-xs">
            <Input
              value={carrierRef}
              onChange={(e: any) => setCarrierRef(e.target.value)}
              placeholder="Waybill / tracking (optional)"
            />
          </div>
          <Button size="sm" onClick={() => handleShip(d)} disabled={panelSaving}>
            Ship
          </Button>
        </div>
      );
    }

    if (d.status === "Shipped") {
      return (
        <div className="ml-6 mt-4 border-t border-gray-200 pt-4 flex items-center gap-2">
          <Button size="sm" onClick={() => updateDispatchStatus(d.id, "Received")}>
            Mark received
          </Button>
          <Button size="sm" variant="secondary" onClick={() => printPackingSlip(d, items)}>
            Print packing slip
          </Button>
        </div>
      );
    }

    return null;
  }

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
          className={"px-4 py-2 rounded-md text-sm font-medium transition-colors " + (
            tab === "new"
              ? "bg-white text-gray-900 shadow-sm"
              : "text-gray-500 hover:text-gray-700"
          )}
        >
          <Send className="w-4 h-4 inline mr-1" />
          New Dispatch
        </button>
        <button
          onClick={() => setTab("history")}
          className={"px-4 py-2 rounded-md text-sm font-medium transition-colors " + (
            tab === "history"
              ? "bg-white text-gray-900 shadow-sm"
              : "text-gray-500 hover:text-gray-700"
          )}
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
          {/* Flow mode */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Dispatch Flow
            </label>
            <div className="flex gap-1 bg-gray-100 rounded-lg p-1 w-fit">
              <button
                type="button"
                onClick={() => setFlowMode("instant")}
                className={"px-4 py-2 rounded-md text-sm font-medium transition-colors " + (
                  flowMode === "instant"
                    ? "bg-white text-gray-900 shadow-sm"
                    : "text-gray-500 hover:text-gray-700"
                )}
              >
                Instant
              </button>
              <button
                type="button"
                onClick={() => setFlowMode("ppship")}
                className={"px-4 py-2 rounded-md text-sm font-medium transition-colors " + (
                  flowMode === "ppship"
                    ? "bg-white text-gray-900 shadow-sm"
                    : "text-gray-500 hover:text-gray-700"
                )}
              >
                Pick / Pack / Ship
              </button>
            </div>
          </div>

          {/* Destination */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Destination Type
              </label>
              <select
                value={destinationType}
                onChange={(e: any) => {
                  setDestinationType(e.target.value as DestinationType);
                  setDestinationId("");
                  setDestinationLocationId("");
                }}
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
                  ? "Destination Shop"
                  : destinationType === "External Client"
                  ? "Client Name"
                  : "Wholesale Customer"}
              </label>
              {destinationType === "Internal Shop" ? (
                <select
                  value={destinationLocationId}
                  onChange={(e: any) => setDestinationLocationId(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                >
                  <option value="">Select a shop...</option>
                  {locations
                    .filter((l: LocationRow) => l.active)
                    .map((l: LocationRow) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                </select>
              ) : (
                <Input
                  value={destinationId}
                  onChange={(e: any) => setDestinationId(e.target.value)}
                  placeholder="Customer or business name"
                />
              )}
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
                onClick={() => setShowPicker(true)}
              >
                <Plus className="w-4 h-4 mr-1" />
                Add Item
              </Button>
            </div>

            <BarcodeScanInput
              value={scanValue}
              onChange={setScanValue}
              onScan={(code) => {
                const found = catalogItems.find((c: WmsCatalogItem) => c.barcode === code);
                if (!found) {
                  toast.error(`No item with barcode ${code}`);
                  setScanValue("");
                  return;
                }
                addLine(found);
                setScanValue("");
              }}
              placeholder="Scan or type barcode to add item"
            />

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
                              className={"w-20 text-right border rounded px-2 py-1 text-sm " + (
                                over
                                  ? "border-red-400 text-red-600"
                                  : "border-gray-300"
                              )}
                            />
                            {over && (
                              <p className="text-xs text-red-500 mt-1">
                                Exceeds available
                              </p>
                            )}
                          </td>
                          <td className="px-3 py-2 text-center">
                            <Tooltip label="Remove line">
                              <button
                                onClick={() => removeLine(line.id)}
                                aria-label="Remove line"
                                className="text-gray-400 hover:text-red-500 transition-colors"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </Tooltip>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {destinationType === "Internal Shop" && lines.some((l: DispatchLine) => !l.productId) && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <p className="font-medium">Some items are not linked to shop products</p>
              <p className="mt-1 text-amber-600">
                These items will leave the warehouse but will NOT appear in shop stock:
              </p>
              <ul className="mt-1 list-disc pl-5 text-amber-700">
                {lines.filter((l: DispatchLine) => !l.productId).map((l: DispatchLine) => (
                  <li key={l.id}>{l.itemName} ({l.sku})</li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-amber-500">
                Link them in the warehouse catalog or create matching products first.
              </p>
            </div>
          )}

          {/* Submit */}
          <div className="flex justify-end">
            <Button
              onClick={handleDispatch}
              disabled={
                saving ||
                lines.length === 0 ||
                !destinationReady ||
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
                    <th className="w-8 px-2 py-3"></th>
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
                  {history.map((d: PastDispatch) => {
                    const isExpanded = expandedId === d.id;
                    const detailItems = detailCache.get(d.id);
                    return (
                      <>
                        <tr
                          key={d.id}
                          className={"cursor-pointer transition-colors " + (isExpanded ? "bg-green-50/50" : "hover:bg-gray-50")}
                          onClick={() => toggleExpand(d.id, d.status)}
                        >
                          <td className="px-2 py-3 text-gray-400">
                            {isExpanded ? (
                              <ChevronDown className="w-4 h-4" />
                            ) : (
                              <ChevronRight className="w-4 h-4" />
                            )}
                          </td>
                          <td className="px-4 py-3 text-gray-500">
                            {formatDate(d.created_at)}
                          </td>
                          {/* Destination type is a three-value enum, so it reads
                              as a chip. Neutral — no type is better or worse. */}
                          <td className="px-4 py-3">
                            <Badge variant="gray">{d.destination_type}</Badge>
                          </td>
                          <td className="px-4 py-3 text-gray-900 max-w-[14rem]">
                            <TruncatedText>{d.destination_id}</TruncatedText>
                          </td>
                          <td className="px-4 py-3">
                            <Badge variant={statusColor(d.status) as any}>
                              {d.status}
                            </Badge>
                          </td>
                          {/* The avatar answers "who dispatched this" faster than
                              re-reading the name on every row. */}
                          <td className="px-4 py-3 text-gray-500">
                            {d.created_by ? (
                              <span className="inline-flex items-center gap-2">
                                <Avatar name={d.created_by} className="h-6 w-6 text-[10px]" />
                                <span className="truncate">{d.created_by}</span>
                              </span>
                            ) : "—"}
                          </td>
                          <td className="px-4 py-3 text-center" onClick={(e: any) => e.stopPropagation()}>
                            {d.status === "Pending" && (
                              <button
                                onClick={() =>
                                  updateDispatchStatus(d.id, "Dispatched")
                                }
                                className="text-sm px-3 py-2 min-h-[44px] text-blue-600 hover:underline mr-2"
                              >
                                Mark Dispatched
                              </button>
                            )}
                            {d.status === "Dispatched" && (
                              <button
                                onClick={() =>
                                  updateDispatchStatus(d.id, "Received")
                                }
                                className="text-sm px-3 py-2 min-h-[44px] text-green-600 hover:underline"
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
                        {isExpanded && (
                          <tr key={"detail-" + d.id}>
                            <td colSpan={7} className="bg-gray-50/80 px-4 py-3">
                              {detailLoading && !detailItems ? (
                                <p className="text-xs text-gray-400 py-2">Loading items...</p>
                              ) : !detailItems || detailItems.length === 0 ? (
                                <p className="text-xs text-gray-400 py-2">No line items found.</p>
                              ) : (
                                <div className="ml-6">
                                  {d.notes && (
                                    <p className="text-xs text-gray-500 mb-2">
                                      <span className="font-medium">Notes:</span> {d.notes}
                                    </p>
                                  )}
                                  <table className="w-full text-xs">
                                    <thead>
                                      <tr className="border-b border-gray-200">
                                        <th className="text-left py-1.5 pr-4 font-medium text-gray-500">Item</th>
                                        <th className="text-left py-1.5 pr-4 font-medium text-gray-500">SKU</th>
                                        <th className="text-right py-1.5 font-medium text-gray-500">Qty Sent</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-100">
                                      {detailItems.map((item: DispatchDetailItem, idx: number) => (
                                        <tr key={idx}>
                                          <td className="py-1.5 pr-4 text-gray-900">{item.item_name}</td>
                                          <td className="py-1.5 pr-4 font-mono text-gray-500">{item.sku}</td>
                                          <td className="py-1.5 text-right font-medium text-gray-900">{item.qty_sent}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                    <tfoot>
                                      <tr className="border-t border-gray-200">
                                        <td colSpan={2} className="py-1.5 text-right font-medium text-gray-600">Total units:</td>
                                        <td className="py-1.5 text-right font-bold text-gray-900">
                                          {detailItems.reduce((sum: number, item: DispatchDetailItem) => sum + item.qty_sent, 0)}
                                        </td>
                                      </tr>
                                    </tfoot>
                                  </table>
                                </div>
                              )}
                              {detailItems && detailItems.length > 0 &&
                                renderActionPanel(d, detailItems)}
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
      )}

      <ItemPickerModal
        open={showPicker}
        onClose={() => setShowPicker(false)}
        onPick={addLine}
        items={pickerItems}
        title="Select Item to Dispatch"
      />
    </div>
  );
}
