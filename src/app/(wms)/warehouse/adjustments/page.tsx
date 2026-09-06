"use client";
import { useState, useEffect, useCallback } from "react";
import { db } from "@/lib/supabase";
import { fetchAllPaged } from "@/lib/fetch-all";
import { useAuth, matchLocationPin } from "@/lib/auth-context";
import { useOrg } from "@/lib/org-context";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";
import { TruncatedText } from "@/components/ui/truncate";
import { Timeline, TimelineGroup, TimelineItem, Avatar } from "@/components/ui/timeline";
import { ItemPickerModal, type WmsCatalogPickerItem } from "@/components/wms/item-picker-modal";
import { useToast } from "@/components/ui/toast";
import {
  Wrench,
  Plus,
  Search,
  ArrowDown,
  ArrowUp,
  Package,
  X,
  AlertTriangle,
} from "lucide-react";

const REASONS = ["Breakage", "Expired", "Theft", "Correction", "Other"] as const;
type Reason = (typeof REASONS)[number];

interface WmsCatalogItem {
  id: number;
  sku: string;
  item_name: string;
  category: string | null;
  barcode: string | null;
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
  cost_price: number | null;
}

interface AdjustmentDisplay extends WmsAdjustment {
  item_name: string;
  sku: string;
}

interface BulkLine {
  key: string; // client-side id for React
  wms_item_id: number | null;
  item_name: string;
  sku: string;
  qty: number;
  cost_price: number | null;
}

export default function WmsAdjustmentsPage() {
  const { name: userName } = useAuth();
  const { orgId, session, currentLocationId } = useOrg();
  const toast = useToast();
  const [adjustments, setAdjustments] = useState<AdjustmentDisplay[]>([]);
  const [catalogItems, setCatalogItems] = useState<WmsCatalogItem[]>([]);
  const [inventoryMap, setInventoryMap] = useState<Map<number, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState("");

  // Form state
  const [selectedItem, setSelectedItem] = useState("");
  const [selectedItemDetail, setSelectedItemDetail] = useState<WmsCatalogPickerItem | null>(null);
  const [itemPickerOpen, setItemPickerOpen] = useState(false);
  const [reason, setReason] = useState<Reason>("Breakage");
  const [direction, setDirection] = useState<"decrease" | "increase">("decrease");
  const [quantity, setQuantity] = useState("");
  const [costPrice, setCostPrice] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  // Bulk mode
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkLines, setBulkLines] = useState<BulkLine[]>([]);
  const [bulkReason, setBulkReason] = useState<Reason>("Correction");
  const [bulkDirection, setBulkDirection] = useState<"add" | "remove">("remove");
  const [bulkNotes, setBulkNotes] = useState("");
  const [bulkLineErrors, setBulkLineErrors] = useState<Record<string, boolean>>({});
  const [bulkSaving, setBulkSaving] = useState(false);
  // Shared by the per-row "Item" button and the "Add line" button: "new" means
  // the pick appends a line, a line's own `key` means the pick replaces its item.
  const [linePickerFor, setLinePickerFor] = useState<string | "new" | null>(null);

  // Approval threshold (migration 094) — org-configured ZAR value above which
  // an adjustment's line value requires an approver PIN. Shared by single and
  // bulk mode.
  const [threshold, setThreshold] = useState<number | null>(null);
  const [approvalPin, setApprovalPin] = useState("");
  const [approvalPinError, setApprovalPinError] = useState(false);

  // Reversal modal
  const [reverseTarget, setReverseTarget] = useState<AdjustmentDisplay | null>(null);
  const [reversing, setReversing] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);

    const [catalog, inventory, { data: adjustmentRows }] =
      await Promise.all([
        fetchAllPaged<WmsCatalogItem>(() => db.from("wms_catalog").select("id, sku, item_name, category, barcode").order("item_name")),
        fetchAllPaged<WmsInventoryRow>(() => db.from("wms_inventory").select("wms_item_id, physical_qty")),
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

  useEffect(() => {
    if (!orgId) return;
    (async () => {
      const { data } = await db
        .from("wms_org_settings")
        .select("adjustment_approval_threshold")
        .eq("org_id", orgId)
        .maybeSingle();
      setThreshold((data as any)?.adjustment_approval_threshold ?? null);
    })();
  }, [orgId]);

  // The PIN compare happens server-side through the match_location_pin RPC
  // (via matchLocationPin from auth-context): it never returns the stored PIN
  // value to the client, re-checks org membership so the admin_pin row stays
  // unreadable to cashiers (migration 100), and is rate-limited by migration
  // 110's brute-force throttle. Only an 'admin' match clears this gate.
  async function verifyAdminPin(pin: string): Promise<boolean> {
    if (!pin) return false;
    return (await matchLocationPin(currentLocationId, pin)) === "admin";
  }

  function openForm() {
    setSelectedItem("");
    setSelectedItemDetail(null);
    setReason("Breakage");
    setDirection("decrease");
    setQuantity("");
    setCostPrice(null);
    setNotes("");
    setApprovalPin("");
    setApprovalPinError(false);
    setBulkMode(false);
    setShowForm(true);
  }

  function resetBulkForm() {
    setBulkLines([]);
    setBulkReason("Correction");
    setBulkDirection("remove");
    setBulkNotes("");
    setBulkLineErrors({});
    setApprovalPin("");
    setApprovalPinError(false);
  }

  function openBulkForm() {
    resetBulkForm();
    setBulkMode(true);
    setShowForm(true);
  }

  function handleLinePick(item: WmsCatalogPickerItem) {
    if (linePickerFor === "new") {
      setBulkLines((lines) => [
        ...lines,
        { key: crypto.randomUUID(), wms_item_id: item.id, item_name: item.item_name, sku: item.sku, qty: 1, cost_price: null },
      ]);
    } else if (linePickerFor) {
      const key = linePickerFor;
      setBulkLines((lines) =>
        lines.map((l) => (l.key === key ? { ...l, wms_item_id: item.id, item_name: item.item_name, sku: item.sku } : l))
      );
      setBulkLineErrors((errs) => {
        if (!errs[key]) return errs;
        const next = { ...errs };
        delete next[key];
        return next;
      });
    }
    setLinePickerFor(null);
  }

  function removeBulkLine(key: string) {
    setBulkLines((lines) => lines.filter((l) => l.key !== key));
    setBulkLineErrors((errs) => {
      if (!errs[key]) return errs;
      const next = { ...errs };
      delete next[key];
      return next;
    });
  }

  function updateBulkLine(key: string, patch: Partial<BulkLine>) {
    setBulkLines((lines) => lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
    setBulkLineErrors((errs) => {
      if (!errs[key]) return errs;
      const next = { ...errs };
      delete next[key];
      return next;
    });
  }

  function validateBulk(): boolean {
    if (bulkLines.length === 0) {
      toast.error("Add at least one line");
      return false;
    }
    const errors: Record<string, boolean> = {};
    bulkLines.forEach((l) => {
      if (!l.wms_item_id || !l.qty || l.qty <= 0) {
        errors[l.key] = true;
      }
    });
    setBulkLineErrors(errors);
    if (Object.keys(errors).length > 0) {
      toast.error("Fix highlighted lines before submitting");
      return false;
    }
    return true;
  }

  async function handleSubmit() {
    const itemId = parseInt(selectedItem);
    const qty = parseInt(quantity);
    if (!itemId || !qty || qty <= 0) return;

    const lineValue = Math.abs(qty) * (costPrice ?? 0);
    const exceedsThreshold = threshold !== null && lineValue > threshold;
    let approverId: string | null = null;
    if (exceedsThreshold) {
      const pinOk = await verifyAdminPin(approvalPin);
      if (!pinOk) {
        setApprovalPinError(true);
        toast.error("Admin PIN incorrect");
        return;
      }
      approverId = session?.user.id ?? null;
    }

    setSaving(true);
    try {
      const adjustmentQty = direction === "decrease" ? -qty : qty;
      const idempotencyKey =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : null;

      // Single atomic RPC: logs the adjustment AND moves inventory in one
      // transaction, derives the org server-side, enforces the subscription
      // gate, and upserts so a missing inventory row can't swallow the move.
      const { error } = await db.rpc("record_wms_adjustment", {
        p_wms_item_id: itemId,
        p_adjustment_qty: adjustmentQty,
        p_reason: reason,
        p_notes: notes.trim() || null,
        p_recorded_by: userName || null,
        p_cost_price: costPrice,
        p_idempotency_key: idempotencyKey,
        p_location_id: null,
        p_approver_user_id: exceedsThreshold ? approverId : null,
      });

      if (error) {
        const isFreeze = /frozen by count session/i.test(error.message || "");
        toast.error(
          isFreeze ? "Cannot adjust: a stock count is frozen for this item" : "Failed to save adjustment",
          { hint: error.message }
        );
        return;
      }

      setShowForm(false);
      setApprovalPin("");
      setApprovalPinError(false);
      await loadData();
      toast.success("Adjustment recorded");
    } catch (err: any) {
      console.error("Adjustment error:", err);
      toast.error("Failed to save adjustment", { hint: err.message });
    } finally {
      setSaving(false);
    }
  }

  async function handleBulkSubmit() {
    if (!validateBulk()) return;

    const anyOverThreshold =
      threshold !== null &&
      bulkLines.some((l) => Math.abs(l.qty) * (l.cost_price ?? 0) > threshold);

    let approverId: string | null = null;
    if (anyOverThreshold) {
      const pinOk = await verifyAdminPin(approvalPin);
      if (!pinOk) {
        setApprovalPinError(true);
        toast.error("Admin PIN incorrect");
        return;
      }
      approverId = session?.user.id ?? null;
    }

    setBulkSaving(true);
    try {
      let successes = 0;
      const failures: { line: number; message: string }[] = [];

      for (let i = 0; i < bulkLines.length; i++) {
        const line = bulkLines[i];
        const signedQty = bulkDirection === "add" ? line.qty : -line.qty;
        const lineExceedsThreshold =
          threshold !== null && Math.abs(line.qty) * (line.cost_price ?? 0) > threshold;

        const { error } = await db.rpc("record_wms_adjustment", {
          p_wms_item_id: line.wms_item_id,
          p_adjustment_qty: signedQty,
          p_reason: bulkReason,
          p_notes: bulkNotes.trim() || null,
          p_recorded_by: userName || null,
          p_cost_price: line.cost_price,
          p_idempotency_key: crypto.randomUUID(),
          p_location_id: null, // MAIN default
          p_approver_user_id: lineExceedsThreshold ? approverId : null,
        });

        if (error) {
          failures.push({ line: i + 1, message: error.message });
        } else {
          successes++;
        }
      }

      if (failures.length === 0) {
        toast.success(`Recorded ${successes} adjustments`);
        resetBulkForm();
        setBulkMode(false);
        setShowForm(false);
        await loadData();
      } else {
        toast.error(`Recorded ${successes} of ${bulkLines.length} — ${failures.length} failed`, {
          hint: failures.map((f) => `Line ${f.line}: ${f.message}`).join(" · "),
        });
        await loadData();
      }
    } finally {
      setBulkSaving(false);
    }
  }

  async function handleConfirmReverse() {
    if (!reverseTarget) return;
    setReversing(true);
    try {
      const { error } = await db.rpc("record_wms_adjustment", {
        p_wms_item_id: reverseTarget.wms_item_id,
        p_adjustment_qty: -reverseTarget.adjustment_qty,
        p_reason: "Correction",
        p_notes: `Reversal of #${reverseTarget.id} — original: ${reverseTarget.reason}`,
        p_recorded_by: userName || null,
        p_cost_price: reverseTarget.cost_price ?? null,
        p_idempotency_key: crypto.randomUUID(),
        p_location_id: null,
        p_approver_user_id: null,
      });

      if (error) {
        const isApproval = /Approval required/i.test(error.message || "");
        toast.error(
          isApproval
            ? "This reversal exceeds the approval threshold — use New Adjustment or Bulk adjust to approve it"
            : "Failed to reverse adjustment",
          { hint: error.message }
        );
        return;
      }

      setReverseTarget(null);
      toast.success("Adjustment reversed");
      await loadData();
    } catch (err: any) {
      console.error("Reversal error:", err);
      toast.error("Failed to reverse adjustment", { hint: err.message });
    } finally {
      setReversing(false);
    }
  }

  const selectedCurrentStock = selectedItem
    ? inventoryMap.get(parseInt(selectedItem)) ?? 0
    : 0;

  const singleLineValue = quantity ? Math.abs(parseInt(quantity) || 0) * (costPrice ?? 0) : 0;
  const singleOverThreshold = threshold !== null && singleLineValue > threshold;

  const bulkTotalValue = bulkLines.reduce((sum, l) => sum + l.qty * (l.cost_price ?? 0), 0);
  const bulkWorstLineValue = bulkLines.reduce(
    (max, l) => Math.max(max, Math.abs(l.qty) * (l.cost_price ?? 0)),
    0
  );
  const bulkAnyOverThreshold = threshold !== null && bulkWorstLineValue > threshold;

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
        <div className="flex gap-2">
          <Button variant="secondary" onClick={openBulkForm}>
            Bulk adjust
          </Button>
          <Button onClick={openForm}>
            <Plus className="w-4 h-4 mr-1" />
            New Adjustment
          </Button>
        </div>
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
                        <Button
                          size="sm"
                          variant="ghost"
                          className="px-2 py-1 mt-1 text-xs text-gray-400 hover:text-red-600"
                          onClick={() => setReverseTarget(adj)}
                        >
                          Reverse
                        </Button>
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

      {/* New Adjustment / Bulk adjust Modal */}
      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        title={bulkMode ? "Bulk Stock Adjustment" : "New Stock Adjustment"}
        wide={bulkMode}
      >
        {!bulkMode ? (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Item
            </label>
            <button
              type="button"
              onClick={() => setItemPickerOpen(true)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-left bg-white hover:bg-gray-50"
            >
              {selectedItemDetail
                ? `${selectedItemDetail.item_name} — ${selectedItemDetail.sku}`
                : "Select an item..."}
            </button>

            <ItemPickerModal
              open={itemPickerOpen}
              onClose={() => setItemPickerOpen(false)}
              onPick={(item) => {
                setSelectedItem(String(item.id));
                setSelectedItemDetail(item);
                setItemPickerOpen(false);
              }}
              items={catalogItems.map((c: WmsCatalogItem) => ({
                id: c.id,
                sku: c.sku,
                item_name: c.item_name,
                category: c.category,
                barcode: c.barcode ?? null,
              }))}
              title="Select item to adjust"
            />
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
              Cost per unit (optional)
            </label>
            <Input
              type="number"
              step={0.01}
              min={0}
              className="w-32"
              value={costPrice ?? ""}
              onChange={(e: any) =>
                setCostPrice(e.target.value === "" ? null : parseFloat(e.target.value))
              }
              placeholder="0.00"
            />
            <p className="text-xs text-gray-500 mt-1">
              Leave blank if unknown; used for shrinkage reporting on P&L.
            </p>
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

          {singleOverThreshold && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2">
              <p className="text-sm text-amber-800 flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                Approval required — R{singleLineValue.toFixed(2)} exceeds R{(threshold ?? 0).toFixed(2)}. Enter admin PIN to approve.
              </p>
              <input
                type="password"
                inputMode="numeric"
                maxLength={8}
                value={approvalPin}
                onChange={(e: any) => {
                  setApprovalPin(e.target.value);
                  setApprovalPinError(false);
                }}
                placeholder="Admin PIN"
                className={`mt-2 w-40 rounded-lg border px-3 py-2 text-sm ${
                  approvalPinError ? "border-red-500" : "border-gray-300"
                }`}
              />
            </div>
          )}

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
        ) : (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Reason
            </label>
            <select
              value={bulkReason}
              onChange={(e: any) => setBulkReason(e.target.value as Reason)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              {REASONS.map((r: string) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Direction
            </label>
            <select
              value={bulkDirection}
              onChange={(e: any) => setBulkDirection(e.target.value as "add" | "remove")}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="remove">Remove stock</option>
              <option value="add">Add stock</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Notes (optional)
            </label>
            <textarea
              rows={2}
              value={bulkNotes}
              onChange={(e: any) => setBulkNotes(e.target.value)}
              placeholder="Applied to every line..."
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Lines
            </label>
            <div className="border border-gray-200 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                  <tr>
                    <th className="text-left px-3 py-2">Item</th>
                    <th className="text-right px-3 py-2 w-20">Qty</th>
                    <th className="text-right px-3 py-2 w-28">Cost/unit</th>
                    <th className="text-right px-3 py-2 w-28">Value</th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody>
                  {bulkLines.map((line) => (
                    <tr key={line.key} className="border-t border-gray-100">
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => setLinePickerFor(line.key)}
                          className={`w-full text-left rounded-lg border px-2 py-1.5 text-sm bg-white hover:bg-gray-50 ${
                            bulkLineErrors[line.key] && !line.wms_item_id ? "border-red-500" : "border-gray-300"
                          }`}
                        >
                          {line.wms_item_id ? `${line.sku} — ${line.item_name}` : "Select item..."}
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min={1}
                          value={line.qty}
                          onChange={(e: any) =>
                            updateBulkLine(line.key, { qty: parseInt(e.target.value) || 0 })
                          }
                          className={`w-full rounded-lg border px-2 py-1.5 text-sm text-right ${
                            bulkLineErrors[line.key] && line.qty <= 0 ? "border-red-500" : "border-gray-300"
                          }`}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min={0}
                          step={0.01}
                          value={line.cost_price ?? ""}
                          onChange={(e: any) =>
                            updateBulkLine(line.key, {
                              cost_price: e.target.value === "" ? null : parseFloat(e.target.value),
                            })
                          }
                          className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm text-right"
                          placeholder="0.00"
                        />
                      </td>
                      <td className="px-3 py-2 text-right text-gray-500 tabular-nums">
                        R{(line.qty * (line.cost_price ?? 0)).toFixed(2)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => removeBulkLine(line.key)}
                          aria-label="Remove line"
                          className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-red-600"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {bulkLines.length === 0 && (
                <p className="text-center text-sm text-gray-400 py-6">No lines yet.</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => setLinePickerFor("new")}
              className="mt-2 text-sm text-green-700 hover:text-green-800 font-medium"
            >
              + Add line
            </button>

            <ItemPickerModal
              open={linePickerFor !== null}
              onClose={() => setLinePickerFor(null)}
              onPick={handleLinePick}
              items={catalogItems.map((c: WmsCatalogItem) => ({
                id: c.id,
                sku: c.sku,
                item_name: c.item_name,
                category: c.category,
                barcode: c.barcode ?? null,
              }))}
              title="Select item"
            />
          </div>

          <p className="text-sm text-gray-600">
            {bulkLines.length} line{bulkLines.length === 1 ? "" : "s"} · Total value R{bulkTotalValue.toFixed(2)}
          </p>

          {bulkAnyOverThreshold && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2">
              <p className="text-sm text-amber-800 flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                Approval required — R{bulkWorstLineValue.toFixed(2)} exceeds R{(threshold ?? 0).toFixed(2)}. Enter admin PIN to approve.
              </p>
              <input
                type="password"
                inputMode="numeric"
                maxLength={8}
                value={approvalPin}
                onChange={(e: any) => {
                  setApprovalPin(e.target.value);
                  setApprovalPinError(false);
                }}
                placeholder="Admin PIN"
                className={`mt-2 w-40 rounded-lg border px-3 py-2 text-sm ${
                  approvalPinError ? "border-red-500" : "border-gray-300"
                }`}
              />
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <Button
              variant="secondary"
              onClick={() => {
                resetBulkForm();
                setBulkMode(false);
                setShowForm(false);
              }}
            >
              Cancel
            </Button>
            <Button onClick={handleBulkSubmit} disabled={bulkSaving}>
              {bulkSaving ? "Saving..." : "Submit all"}
            </Button>
          </div>
        </div>
        )}
      </Modal>

      {/* Reverse Adjustment Modal */}
      <Modal
        open={reverseTarget !== null}
        onClose={() => setReverseTarget(null)}
        title={`Reverse adjustment #${reverseTarget?.id ?? ""}`}
      >
        {reverseTarget && (
          <div className="space-y-4">
            <div className="text-sm text-gray-700 space-y-2">
              <p>
                <span className="text-gray-500">Original:</span>{" "}
                <Badge variant={reasonColor(reverseTarget.reason) as any}>{reverseTarget.reason}</Badge>{" "}
                {reverseTarget.adjustment_qty > 0 ? "+" : ""}
                {reverseTarget.adjustment_qty}
                {reverseTarget.cost_price != null ? ` · R${reverseTarget.cost_price.toFixed(2)}/unit` : ""}
              </p>
              <p>
                <span className="text-gray-500">Reversal that will be created:</span>{" "}
                <Badge variant="gray">Correction</Badge>{" "}
                {-reverseTarget.adjustment_qty > 0 ? "+" : ""}
                {-reverseTarget.adjustment_qty}
              </p>
              <p className="text-xs text-gray-500">
                notes: &quot;Reversal of #{reverseTarget.id} — {reverseTarget.reason}&quot;
              </p>
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <Button variant="secondary" onClick={() => setReverseTarget(null)}>
                Cancel
              </Button>
              <Button onClick={handleConfirmReverse} disabled={reversing}>
                {reversing ? "Reversing..." : "Confirm"}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
