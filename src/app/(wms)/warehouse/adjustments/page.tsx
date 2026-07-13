"use client";
import { useState, useEffect, useCallback } from "react";
import { db } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";
import { TruncatedText } from "@/components/ui/truncate";
import { Timeline, TimelineGroup, TimelineItem, Avatar } from "@/components/ui/timeline";
import {
  Wrench,
  Plus,
  Search,
  ArrowDown,
  ArrowUp,
  Package,
} from "lucide-react";

const REASONS = ["Breakage", "Expired", "Theft", "Correction", "Other"] as const;
type Reason = (typeof REASONS)[number];

interface WmsCatalogItem {
  id: number;
  sku: string;
  item_name: string;
}

interface WmsInventoryRow {
  wms_item_id: number;
  physical_qty: number;
}

interface WmsAdjustment {
  id: number;
  adjustment_date: string;
  wms_item_id: number;
  reason: string;
  adjustment_qty: number;
  notes: string | null;
  recorded_by: string | null;
  created_at: string;
}

interface AdjustmentDisplay extends WmsAdjustment {
  item_name: string;
  sku: string;
}

export default function WmsAdjustmentsPage() {
  const { name: userName } = useAuth();
  const [adjustments, setAdjustments] = useState<AdjustmentDisplay[]>([]);
  const [catalogItems, setCatalogItems] = useState<WmsCatalogItem[]>([]);
  const [inventoryMap, setInventoryMap] = useState<Map<number, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState("");

  // Form state
  const [selectedItem, setSelectedItem] = useState("");
  const [reason, setReason] = useState<Reason>("Breakage");
  const [direction, setDirection] = useState<"decrease" | "increase">("decrease");
  const [quantity, setQuantity] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);

    const [{ data: catalog }, { data: inventory }, { data: adjustmentRows }] =
      await Promise.all([
        db.from("wms_catalog").select("id, sku, item_name").order("item_name"),
        db.from("wms_inventory").select("wms_item_id, physical_qty"),
        db
          .from("wms_adjustments")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(100),
      ]);

    const items: WmsCatalogItem[] = (catalog || []) as any[];
    setCatalogItems(items);

    const invMap = new Map<number, number>();
    ((inventory || []) as any[]).forEach((row: any) => {
      invMap.set(row.wms_item_id, row.physical_qty);
    });
    setInventoryMap(invMap);

    // Enrich adjustments with item names
    const itemMap = new Map<number, WmsCatalogItem>();
    items.forEach((item: WmsCatalogItem) => itemMap.set(item.id, item));

    const enriched: AdjustmentDisplay[] = ((adjustmentRows || []) as any[]).map(
      (adj: any) => {
        const item = itemMap.get(adj.wms_item_id);
        return {
          ...adj,
          item_name: item?.item_name ?? "Unknown",
          sku: item?.sku ?? "",
        };
      }
    );

    setAdjustments(enriched);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  function openForm() {
    setSelectedItem("");
    setReason("Breakage");
    setDirection("decrease");
    setQuantity("");
    setNotes("");
    setShowForm(true);
  }

  async function handleSubmit() {
    const itemId = parseInt(selectedItem);
    const qty = parseInt(quantity);
    if (!itemId || !qty || qty <= 0) return;

    setSaving(true);
    try {
      const adjustmentQty = direction === "decrease" ? -qty : qty;

      // Single atomic RPC: logs the adjustment AND moves inventory in one
      // transaction, derives the org server-side, enforces the subscription
      // gate, and upserts so a missing inventory row can't swallow the move.
      const { error } = await db.rpc("record_wms_adjustment", {
        p_wms_item_id: itemId,
        p_adjustment_qty: adjustmentQty,
        p_reason: reason,
        p_notes: notes.trim() || null,
        p_recorded_by: userName || null,
      });

      if (error) throw error;

      setShowForm(false);
      await loadData();
    } catch (err: any) {
      console.error("Adjustment error:", err);
      alert("Failed to save adjustment: " + (err.message || "Unknown error"));
    } finally {
      setSaving(false);
    }
  }

  const selectedCurrentStock = selectedItem
    ? inventoryMap.get(parseInt(selectedItem)) ?? 0
    : 0;

  // Theft is the one reason that's genuinely alarming; breakage/expiry are
  // losses worth flagging. A correction is routine bookkeeping and was blue for
  // no reason — it's neutral now.
  const reasonColor = (r: string): string => {
    if (r === "Theft") return "red";
    if (r === "Breakage" || r === "Expired") return "amber";
    return "gray";
  };

  const filtered = adjustments.filter(
    (a: AdjustmentDisplay) =>
      !search ||
      a.item_name.toLowerCase().includes(search.toLowerCase()) ||
      a.sku.toLowerCase().includes(search.toLowerCase()) ||
      a.reason.toLowerCase().includes(search.toLowerCase())
  );

  // `adjustments` arrives newest-first, and filtering preserves that, so
  // grouping by day keeps the reverse-chronological reading order.
  const groupedAdjustments = (() => {
    const byDay = new Map<string, AdjustmentDisplay[]>();
    filtered.forEach((a) => {
      const day = (a.adjustment_date || a.created_at).split("T")[0];
      const rows = byDay.get(day) ?? [];
      rows.push(a);
      byDay.set(day, rows);
    });
    return [...byDay.entries()];
  })();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Wrench className="w-7 h-7 text-green-600" />
            Warehouse Adjustments
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Log breakage, theft, expired stock, and corrections
          </p>
        </div>
        <Button onClick={openForm}>
          <Plus className="w-4 h-4 mr-1" />
          New Adjustment
        </Button>
      </div>

      {/* Search */}
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <Input
          placeholder="Search by item, SKU, or reason..."
          value={search}
          onChange={(e: any) => setSearch(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* Adjustments List */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading...</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12">
          <Package className="w-12 h-12 mx-auto text-gray-300 mb-3" />
          <p className="text-gray-500">
            {adjustments.length === 0
              ? "No adjustments recorded yet."
              : "No adjustments match your search."}
          </p>
        </div>
      ) : (
        /* Same event log as the shop's Stock Adjustments, so it reads the same
           way: a timeline grouped by day, with the actor on the rail. */
        <div className="bg-gray-50 rounded-xl border border-gray-200 px-5 py-4">
          <Timeline>
            {groupedAdjustments.map(([day, rows]) => (
              <TimelineGroup key={day} label={formatDate(day)}>
                {rows.map((adj, i) => (
                  <TimelineItem
                    key={adj.id}
                    last={i === rows.length - 1}
                    marker={
                      <Tooltip label={adj.recorded_by || "Unknown user"}>
                        <Avatar name={adj.recorded_by} />
                      </Tooltip>
                    }
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-gray-900">{adj.item_name}</span>
                          <span className="text-xs font-mono text-gray-400">{adj.sku}</span>
                          <Badge variant={reasonColor(adj.reason) as any}>{adj.reason}</Badge>
                        </div>
                        {adj.notes && (
                          <div className="text-sm text-gray-600 mt-1 max-w-md">
                            <TruncatedText>{adj.notes}</TruncatedText>
                          </div>
                        )}
                        <p className="text-xs text-gray-400 mt-1">{adj.recorded_by || "Unknown"}</p>
                      </div>
                      {/* Only a removal is a loss worth colouring; an addition is
                          just a correction back up. */}
                      <span
                        className={`shrink-0 inline-flex items-center gap-1 text-lg font-bold tabular-nums ${
                          adj.adjustment_qty < 0 ? "text-red-600" : "text-gray-700"
                        }`}
                      >
                        {adj.adjustment_qty < 0 ? (
                          <ArrowDown className="w-4 h-4" />
                        ) : (
                          <ArrowUp className="w-4 h-4" />
                        )}
                        {adj.adjustment_qty < 0 ? "−" : "+"}{Math.abs(adj.adjustment_qty)}
                      </span>
                    </div>
                  </TimelineItem>
                ))}
              </TimelineGroup>
            ))}
          </Timeline>
        </div>
      )}

      {/* New Adjustment Modal */}
      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        title="New Stock Adjustment"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Item
            </label>
            <select
              value={selectedItem}
              onChange={(e: any) => setSelectedItem(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="">Select an item...</option>
              {catalogItems.map((item: WmsCatalogItem) => (
                <option key={item.id} value={String(item.id)}>
                  {item.item_name} ({item.sku})
                </option>
              ))}
            </select>
            {selectedItem && (
              <p className="text-xs text-gray-500 mt-1">
                Current stock: <strong>{selectedCurrentStock}</strong> units
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Reason
            </label>
            <select
              value={reason}
              onChange={(e: any) => setReason(e.target.value as Reason)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              {REASONS.map((r: string) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Direction
              </label>
              <select
                value={direction}
                onChange={(e: any) =>
                  setDirection(e.target.value as "decrease" | "increase")
                }
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="decrease">Remove stock</option>
                <option value="increase">Add stock</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Quantity
              </label>
              <Input
                type="number"
                min="1"
                value={quantity}
                onChange={(e: any) => setQuantity(e.target.value)}
                placeholder="0"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Notes (optional)
            </label>
            <Input
              value={notes}
              onChange={(e: any) => setNotes(e.target.value)}
              placeholder="Additional details..."
            />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={saving || !selectedItem || !quantity || parseInt(quantity) <= 0}
            >
              {saving ? "Saving..." : "Save Adjustment"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
