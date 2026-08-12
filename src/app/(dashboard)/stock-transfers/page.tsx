"use client";
// Inter-branch stock transfers at /stock-transfers.
//
// Three-step flow:
//   1. Draft  — pick from/to locations, build a multi-item list, write notes
//   2. Review — modal shows the full list with an "Are you sure?" guard
//   3. Receipt — success screen with Print, PDF download, Email, WhatsApp share

import { useEffect, useState, useCallback, useRef } from "react";
import { db } from "@/lib/supabase";
import { useOrg } from "@/lib/org-context";
import { fetchAllPaged } from "@/lib/fetch-all";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Modal } from "@/components/ui/modal";
import { Tooltip } from "@/components/ui/tooltip";
import { TruncatedText } from "@/components/ui/truncate";
import { ActionMenu, MenuItem } from "@/components/ui/menu";
import { Timeline, TimelineGroup, TimelineItem } from "@/components/ui/timeline";
import {
  ArrowRightLeft, ArrowRight, AlertCircle, Check, Package, MapPin, Plus, Trash2, Send, Info,
  Printer, Mail, MessageCircle, FileDown, RotateCcw,
} from "lucide-react";
import { formatZAR } from "@/lib/format";
import { localToday, localYesterday, toLocalDateStr } from "@/lib/date-utils";
import { SearchableSelect } from "@/components/ui/searchable-select";

interface Product {
  id: string;
  name: string;
  inventory_id: string;
  selling_price: number;
}

interface DraftItem {
  productId: string;
  productName: string;
  inventoryId: string;
  quantity: number;
  availableAtSource: number;
  unitPrice: number;
}

interface TransferRow {
  id: string;
  product_id: string;
  product_name: string;
  inventory_id: string;
  from_location_id: string;
  to_location_id: string;
  from_name: string;
  to_name: string;
  quantity: number;
  notes: string | null;
  transferred_by: string | null;
  transferred_at: string;
}

interface SavedReceipt {
  fromName: string;
  toName: string;
  items: DraftItem[];
  notes: string;
  reference: string; // short id for the receipt
  savedAt: string;
}

export default function StockTransfersPage() {
  const { locations, currentLocationId, orgName, can } = useOrg();
  const canTransfer = can("manage_stock_transfers");
  const hasMultipleLocations = locations.length > 1;

  // Form state
  const [fromLocId, setFromLocId] = useState<string>("");
  const [toLocId, setToLocId] = useState<string>("");
  const [productId, setProductId] = useState<string>("");
  const [quantity, setQuantity] = useState<string>("");
  const [notes, setNotes] = useState<string>("");

  // Multi-item draft
  const [draft, setDraft] = useState<DraftItem[]>([]);

  // Confirmation + result
  const [showConfirm, setShowConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<SavedReceipt | null>(null);

  // Data
  const [products, setProducts] = useState<Product[]>([]);
  const [stockMap, setStockMap] = useState<Map<string, number>>(new Map());
  const [recent, setRecent] = useState<TransferRow[]>([]);
  const [loading, setLoading] = useState(true);

  const printableRef = useRef<HTMLDivElement>(null);

  // Defaults
  useEffect(() => {
    if (!fromLocId && currentLocationId) setFromLocId(currentLocationId);
  }, [currentLocationId, fromLocId]);
  useEffect(() => {
    if (!toLocId && locations.length > 1 && fromLocId) {
      const other = locations.find((l) => l.id !== fromLocId);
      if (other) setToLocId(other.id);
    }
  }, [locations, fromLocId, toLocId]);
  // Resetting when From changes clears the draft (transfers can't span sources)
  useEffect(() => {
    setProductId("");
    setQuantity("");
    setDraft([]);
  }, [fromLocId]);

  const loadInventory = useCallback(async () => {
    if (!fromLocId) {
      setProducts([]);
      setStockMap(new Map());
      return;
    }
    // Paginate via .range() — Supabase server-side max_rows (default 1000)
    // would otherwise truncate large catalogues. Operators with 1300+ SKUs
    // (Devine Bakes) need every product to appear in the transfer picker.
    const [prods, stock] = await Promise.all([
      fetchAllPaged<Product>(() =>
        db.from("products").select("id, name, inventory_id, selling_price").eq("discontinued", false).order("name")
      ),
      fetchAllPaged<{ product_id: string; quantity: number }>(() =>
        db.from("product_stock").select("product_id, quantity").eq("location_id", fromLocId)
      ),
    ]);
    setProducts(prods);
    const sm = new Map<string, number>();
    stock.forEach((s) => sm.set(s.product_id, Number(s.quantity) || 0));
    setStockMap(sm);
  }, [fromLocId]);

  const loadRecent = useCallback(async () => {
    const { data } = await db
      .from("stock_transfers")
      .select("id, product_id, from_location_id, to_location_id, quantity, notes, transferred_by, transferred_at, products(name, inventory_id)")
      .order("transferred_at", { ascending: false })
      .limit(20);

    const locNameById = new Map<string, string>(locations.map((l) => [l.id, l.name]));
    const rows: TransferRow[] = ((data as Array<{
      id: string; product_id: string; from_location_id: string; to_location_id: string;
      quantity: number; notes: string | null; transferred_by: string | null;
      transferred_at: string;
      products: { name: string; inventory_id: string } | { name: string; inventory_id: string }[] | null;
    }>) || []).map((r) => {
      const prod = Array.isArray(r.products) ? r.products[0] : r.products;
      return {
        id: r.id, product_id: r.product_id,
        product_name: prod?.name || "(deleted)",
        inventory_id: prod?.inventory_id || "",
        from_location_id: r.from_location_id, to_location_id: r.to_location_id,
        from_name: locNameById.get(r.from_location_id) || "—",
        to_name: locNameById.get(r.to_location_id) || "—",
        quantity: Number(r.quantity) || 0,
        notes: r.notes, transferred_by: r.transferred_by, transferred_at: r.transferred_at,
      };
    });
    setRecent(rows);
  }, [locations]);

  useEffect(() => {
    setLoading(true);
    Promise.all([loadInventory(), loadRecent()]).finally(() => setLoading(false));
  }, [loadInventory, loadRecent]);

  // Products visible in the picker: stock > 0 at source AND not already in the draft
  const draftProductIds = new Set(draft.map((d) => d.productId));
  const availableProducts = products
    .map((p) => ({ ...p, available: stockMap.get(p.id) ?? 0 }))
    .filter((p) => p.available > 0 && !draftProductIds.has(p.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  const selectedAvailable = productId ? (stockMap.get(productId) ?? 0) : 0;

  function handleAddItem() {
    setError(null);
    const qty = parseInt(quantity, 10);
    if (!productId || !qty || qty <= 0) {
      setError("Pick a product and a positive quantity.");
      return;
    }
    if (qty > selectedAvailable) {
      setError(`Only ${selectedAvailable} available at source.`);
      return;
    }
    const p = products.find((x) => x.id === productId);
    if (!p) {
      setError("Product not found.");
      return;
    }
    setDraft((d) => [
      ...d,
      {
        productId: p.id,
        productName: p.name,
        inventoryId: p.inventory_id,
        quantity: qty,
        availableAtSource: selectedAvailable,
        unitPrice: Number(p.selling_price) || 0,
      },
    ]);
    setProductId("");
    setQuantity("");
  }

  function handleRemoveItem(productIdToRemove: string) {
    setDraft((d) => d.filter((it) => it.productId !== productIdToRemove));
  }

  function handleEditQty(productIdToEdit: string, newQty: number) {
    setDraft((d) =>
      d.map((it) =>
        it.productId === productIdToEdit
          ? { ...it, quantity: Math.max(1, Math.min(it.availableAtSource, newQty)) }
          : it
      )
    );
  }

  function handleReview() {
    setError(null);
    if (!fromLocId || !toLocId) {
      setError("Pick both source and destination.");
      return;
    }
    if (fromLocId === toLocId) {
      setError("Source and destination must differ.");
      return;
    }
    if (draft.length === 0) {
      setError("Add at least one item to the transfer.");
      return;
    }
    setShowConfirm(true);
  }

  async function handleConfirm() {
    setSubmitting(true);
    setError(null);

    let allOk = true;
    const failures: string[] = [];

    // The RPC is single-item per call. Loop the draft; on the first failure
    // we surface it but continue to ensure the cashier knows what landed.
    for (const item of draft) {
      const { error: rpcErr } = await db.rpc("transfer_stock", {
        p_product_id: item.productId,
        p_from_location_id: fromLocId,
        p_to_location_id: toLocId,
        p_quantity: item.quantity,
        p_notes: notes.trim() || null,
        p_transferred_by: null,
      });
      if (rpcErr) {
        allOk = false;
        failures.push(`${item.productName}: ${rpcErr.message}`);
      }
    }
    setSubmitting(false);

    if (!allOk) {
      setError(`Some items failed: ${failures.join(" · ")}`);
      // Don't close the modal — let the operator decide. Successful items
      // already moved; failed ones did not.
      return;
    }

    // Build the receipt
    const fromName = locations.find((l) => l.id === fromLocId)?.name || "—";
    const toName = locations.find((l) => l.id === toLocId)?.name || "—";
    const reference = "TR-" + new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);

    setReceipt({
      fromName,
      toName,
      items: [...draft],
      notes: notes.trim(),
      reference,
      savedAt: new Date().toISOString(),
    });

    // Reset draft state for the next transfer
    setDraft([]);
    setNotes("");
    setShowConfirm(false);
    setProductId("");
    setQuantity("");

    await Promise.all([loadInventory(), loadRecent()]);
  }

  function handleNewTransfer() {
    setReceipt(null);
    setError(null);
  }

  // ---- Share / download helpers ----

  function receiptAsText(r: SavedReceipt): string {
    const lines: string[] = [];
    lines.push(`${orgName || "Tilify"} — Stock Transfer ${r.reference}`);
    lines.push(`Date: ${new Date(r.savedAt).toLocaleString("en-ZA")}`);
    lines.push(`From: ${r.fromName}`);
    lines.push(`To: ${r.toName}`);
    lines.push("");
    lines.push("Items:");
    r.items.forEach((it, i) => {
      lines.push(`${i + 1}. ${it.productName} (${it.inventoryId}) — ${it.quantity} units`);
    });
    lines.push("");
    if (r.notes) lines.push(`Notes: ${r.notes}`);
    lines.push("");
    const totalUnits = r.items.reduce((s, it) => s + it.quantity, 0);
    const totalValue = r.items.reduce((s, it) => s + it.unitPrice * it.quantity, 0);
    lines.push(`Total units moved: ${totalUnits}`);
    lines.push(`Approximate value at selling price: ${formatZAR(totalValue)}`);
    lines.push("");
    lines.push("Recorded by Tilify.");
    return lines.join("\n");
  }

  function shareWhatsApp() {
    if (!receipt) return;
    const text = encodeURIComponent(receiptAsText(receipt));
    window.open(`https://wa.me/?text=${text}`, "_blank");
  }
  function shareEmail() {
    if (!receipt) return;
    const subject = encodeURIComponent(`Stock Transfer ${receipt.reference} — ${receipt.fromName} → ${receipt.toName}`);
    const body = encodeURIComponent(receiptAsText(receipt));
    window.open(`mailto:?subject=${subject}&body=${body}`);
  }
  function printReceipt() {
    if (!printableRef.current) return;
    window.print();
  }

  // ---- Empty-state for single-location org ----

  if (!hasMultipleLocations) {
    return (
      <div className="max-w-3xl">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2 mb-2">
          <ArrowRightLeft className="w-7 h-7 text-green-600" /> Stock Transfers
        </h1>
        <div className="bg-blue-50 border border-blue-200 text-blue-900 rounded-xl px-5 py-4 mt-4 flex items-start gap-3">
          <Info className="w-5 h-5 mt-0.5 flex-shrink-0" />
          <div className="text-sm">
            <p className="font-semibold">You have only one shop right now.</p>
            <p className="mt-1">
              Stock transfers move inventory between two of your shops. Add a second location under <strong>Locations</strong> and this page will let you move products between them.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ---- Receipt screen (after a successful transfer) ----

  if (receipt) {
    const totalUnits = receipt.items.reduce((s, it) => s + it.quantity, 0);
    const totalValue = receipt.items.reduce((s, it) => s + it.unitPrice * it.quantity, 0);
    return (
      <div className="max-w-3xl">
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3 no-print">
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Check className="w-7 h-7 text-green-600" /> Transfer complete
          </h1>
          <Button onClick={handleNewTransfer} variant="secondary">
            <RotateCcw className="w-4 h-4 mr-2" /> New transfer
          </Button>
        </div>

        {/* Printable receipt */}
        <div ref={printableRef} className="bg-white border border-gray-200 rounded-2xl p-6 mb-6 print-section">
          <div className="flex items-start justify-between border-b border-gray-200 pb-4 mb-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-green-700">Stock Transfer</p>
              <h2 className="text-xl font-bold text-gray-900 mt-1">{orgName || "Tilify"}</h2>
            </div>
            <div className="text-right">
              <p className="text-xs text-gray-500">Reference</p>
              <p className="text-sm font-mono text-gray-900">{receipt.reference}</p>
              <p className="text-xs text-gray-500 mt-2">
                {new Date(receipt.savedAt).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" })}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 mb-6 text-sm">
            <div>
              <p className="text-xs font-medium uppercase text-gray-500">From</p>
              <p className="font-semibold text-gray-900 mt-1">{receipt.fromName}</p>
            </div>
            <div>
              <p className="text-xs font-medium uppercase text-gray-500">To</p>
              <p className="font-semibold text-gray-900 mt-1">{receipt.toName}</p>
            </div>
          </div>

          <table className="w-full text-sm mb-4">
            <thead className="border-b border-gray-200">
              <tr>
                <th className="text-left py-2 font-medium text-gray-500">#</th>
                <th className="text-left py-2 font-medium text-gray-500">Inventory ID</th>
                <th className="text-left py-2 font-medium text-gray-500">Product</th>
                <th className="text-right py-2 font-medium text-gray-500">Qty</th>
                <th className="text-right py-2 font-medium text-gray-500">Unit Price</th>
                <th className="text-right py-2 font-medium text-gray-500">Line Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {receipt.items.map((it, idx) => (
                <tr key={it.productId}>
                  <td className="py-2 text-gray-500">{idx + 1}</td>
                  <td className="py-2 font-mono text-xs text-gray-600">{it.inventoryId}</td>
                  <td className="py-2 font-medium text-gray-900">{it.productName}</td>
                  <td className="py-2 text-right font-semibold text-gray-900 tabular-nums">{it.quantity}</td>
                  <td className="py-2 text-right text-gray-600 tabular-nums">{formatZAR(it.unitPrice)}</td>
                  <td className="py-2 text-right text-gray-900 tabular-nums">{formatZAR(it.unitPrice * it.quantity)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t-2 border-gray-300">
              <tr>
                <td colSpan={3} className="py-2 font-semibold text-gray-900">Totals</td>
                <td className="py-2 text-right font-bold text-gray-900">{totalUnits}</td>
                <td />
                <td className="py-2 text-right font-bold text-gray-900">{formatZAR(totalValue)}</td>
              </tr>
            </tfoot>
          </table>

          {receipt.notes && (
            <div className="border-t border-gray-200 pt-3 text-sm">
              <p className="text-xs font-medium uppercase text-gray-500">Notes</p>
              <p className="text-gray-700 mt-1">{receipt.notes}</p>
            </div>
          )}

          <div className="border-t border-gray-200 pt-3 mt-4 text-xs text-gray-400 text-center">
            Recorded by Tilify — Inter-branch transfer audit
          </div>
        </div>

        {/* Print is what you do with a transfer receipt; sharing it is the
            exception, so the share routes sit behind the menu. "Save PDF" was a
            second button calling the same printReceipt() — it's now stated once,
            as the hint under Print that it always was. */}
        <div className="flex items-center gap-3 no-print">
          <Button onClick={printReceipt}>
            <Printer className="w-4 h-4 mr-2" /> Print
          </Button>
          <ActionMenu label="Share this receipt">
            {(close) => (
              <>
                <MenuItem icon={FileDown} onClick={() => { close(); printReceipt(); }}>
                  Save as PDF
                </MenuItem>
                <MenuItem icon={Mail} onClick={() => { close(); shareEmail(); }}>
                  Email
                </MenuItem>
                <MenuItem icon={MessageCircle} onClick={() => { close(); shareWhatsApp(); }}>
                  WhatsApp
                </MenuItem>
              </>
            )}
          </ActionMenu>
        </div>
        <p className="text-xs text-gray-500 mt-2 no-print">
          Tip: in the Print dialog, change destination to <strong>Save as PDF</strong> to download.
        </p>

        <style jsx global>{`
          @media print {
            .no-print { display: none !important; }
            .print-section { box-shadow: none !important; border: none !important; }
            body { background: white !important; }
          }
        `}</style>
      </div>
    );
  }

  // ---- Draft screen ----

  const totalDraftUnits = draft.reduce((s, it) => s + it.quantity, 0);
  const totalDraftValue = draft.reduce((s, it) => s + it.unitPrice * it.quantity, 0);

  // `recent` already arrives newest-first, so grouping by calendar day
  // preserves that order both across and within groups.
  const groupedRecent = (() => {
    const byDay = new Map<string, TransferRow[]>();
    recent.forEach((t) => {
      const day = toLocalDateStr(new Date(t.transferred_at));
      const rows = byDay.get(day) ?? [];
      rows.push(t);
      byDay.set(day, rows);
    });
    return [...byDay.entries()];
  })();

  return (
    <div className="max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <ArrowRightLeft className="w-7 h-7 text-green-600" /> Stock Transfers
        </h1>
        <p className="text-sm text-gray-500 mt-1">Build a list of items to move between your shops, review it, then confirm to transfer.</p>
      </div>

      {!canTransfer && (
        <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-xl px-5 py-4 mb-6 flex items-start gap-3">
          <Info className="w-5 h-5 mt-0.5 flex-shrink-0" />
          <div className="text-sm">
            <p className="font-semibold">Owners and admins only.</p>
            <p className="mt-1">Cashiers cannot initiate transfers. The recent transfers below are read-only.</p>
          </div>
        </div>
      )}

      {canTransfer && (
        <div className="bg-white border border-gray-200 rounded-2xl p-6 mb-6 space-y-4">
          <h2 className="text-lg font-semibold text-gray-900">New transfer</h2>

          {/* Locations */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1 inline-flex items-center gap-1">
                <MapPin className="w-3.5 h-3.5" /> From location
              </label>
              <select value={fromLocId} onChange={(e) => setFromLocId(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500">
                <option value="">— pick source —</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1 inline-flex items-center gap-1">
                <MapPin className="w-3.5 h-3.5 text-green-600" /> To location
              </label>
              <select value={toLocId} onChange={(e) => setToLocId(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500">
                <option value="">— pick destination —</option>
                {locations.filter((l) => l.id !== fromLocId).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
          </div>

          {/* Add item picker */}
          <div className="border-t border-gray-200 pt-4">
            <p className="text-sm font-medium text-gray-700 mb-2">Add items to the transfer</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-gray-500 mb-1 inline-flex items-center gap-1">
                  <Package className="w-3 h-3" /> Product
                </label>
                <SearchableSelect
                  value={productId}
                  onChange={setProductId}
                  disabled={!fromLocId || availableProducts.length === 0}
                  placeholder={
                    !fromLocId ? "Pick a source first"
                      : availableProducts.length === 0 ? (draft.length > 0 ? "All in-stock items already in the list" : "No products in stock at source")
                      : "Search products..."
                  }
                  emptyMessage="No matching products"
                  options={availableProducts.map((p) => ({
                    value: p.id,
                    label: p.name,
                    detail: `${p.inventory_id} · ${p.available} on hand · ${formatZAR(p.selling_price)}`,
                  }))}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Quantity</label>
                <div className="flex gap-2">
                  <input type="number" inputMode="numeric" min="1" max={selectedAvailable || undefined}
                    value={quantity} onChange={(e) => setQuantity(e.target.value)}
                    disabled={!productId}
                    placeholder={productId ? `max ${selectedAvailable}` : ""}
                    className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:border-green-500 focus:ring-1 focus:ring-green-500 disabled:bg-gray-50" />
                  <Button type="button" onClick={handleAddItem} disabled={!productId || !quantity}>
                    <Plus className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </div>
          </div>

          {/* Draft items list */}
          {draft.length > 0 && (
            <div className="border-t border-gray-200 pt-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-medium text-gray-700">Items in this transfer ({draft.length})</p>
                <span className="text-xs text-gray-500">
                  {totalDraftUnits} units · {formatZAR(totalDraftValue)}
                </span>
              </div>
              <div className="border border-gray-200 rounded-lg divide-y divide-gray-100">
                {draft.map((it) => (
                  <div key={it.productId} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{it.productName}</p>
                      <p className="text-xs text-gray-500">
                        <span className="font-mono">{it.inventoryId}</span> · {it.availableAtSource} on hand · {formatZAR(it.unitPrice)}/unit
                      </p>
                    </div>
                    <input type="number" inputMode="numeric" min="1" max={it.availableAtSource}
                      value={it.quantity}
                      onChange={(e) => handleEditQty(it.productId, parseInt(e.target.value, 10) || 1)}
                      className="w-20 text-right border border-gray-300 rounded-lg px-2 py-1 text-sm font-mono focus:border-green-500 focus:ring-1 focus:ring-green-500" />
                    <Tooltip label="Remove from transfer">
                      <button type="button" onClick={() => handleRemoveItem(it.productId)}
                        aria-label={`Remove ${it.productName} from transfer`}
                        className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </Tooltip>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Notes */}
          <div className="border-t border-gray-200 pt-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes (optional)</label>
            <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. weekly replenishment, urgent restock for promo"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500" />
          </div>

          {error && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded-lg text-sm">
              <AlertCircle className="w-4 h-4 mt-0.5" /> <span>{error}</span>
            </div>
          )}

          <div className="flex items-center justify-between">
            <p className="text-xs text-gray-500">
              {draft.length === 0 ? "Add at least one item to enable Review." : `Ready to review ${draft.length} item${draft.length !== 1 ? "s" : ""}.`}
            </p>
            <Button type="button" onClick={handleReview} disabled={draft.length === 0}>
              <Send className="w-4 h-4 mr-1" /> Review transfer
            </Button>
          </div>
        </div>
      )}

      {/* Recent transfers */}
      <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="font-semibold text-gray-900">Recent transfers</h2>
          <span className="text-sm text-gray-500">{recent.length}</span>
        </div>
        {loading ? (
          <div className="px-5 py-12 text-center text-sm text-gray-400">Loading...</div>
        ) : recent.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <ArrowRightLeft className="w-10 h-10 text-gray-300 mx-auto mb-3" />
            <p className="text-sm text-gray-500">No transfers yet.</p>
          </div>
        ) : (
          /* Recent transfers is an event stream, so it reads as a timeline: the
             day heading carries the date once instead of repeating a full
             datetime on every row, and each entry keeps just its time. */
          <div className="px-5 py-4 bg-gray-50">
            <Timeline>
              {groupedRecent.map(([day, rows]) => (
                <TimelineGroup key={day} label={formatDayLabel(day)}>
                  {rows.map((t, i) => (
                    <TimelineItem
                      key={t.id}
                      last={i === rows.length - 1}
                      marker={
                        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-gray-200 text-gray-500">
                          <ArrowRight className="w-4 h-4" />
                        </span>
                      }
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-2 min-w-0">
                            <span className="font-medium text-gray-900 min-w-0 max-w-[18rem]">
                              <TruncatedText>{t.product_name}</TruncatedText>
                            </span>
                            <span className="text-xs text-gray-400 font-mono shrink-0">{t.inventory_id}</span>
                          </div>
                          {/* Direction is carried by the arrow and the reading
                              order, so the branches don't need colour. Amber on
                              the source read as a warning it never was. */}
                          <div className="flex items-center gap-2 text-xs mt-1">
                            <Badge variant="gray">{t.from_name}</Badge>
                            <ArrowRight className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                            <Badge variant="gray">{t.to_name}</Badge>
                            <span className="text-gray-400">
                              {new Date(t.transferred_at).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" })}
                            </span>
                          </div>
                          {t.notes && (
                            <div className="text-xs text-gray-500 mt-1 max-w-md">
                              <TruncatedText>{t.notes}</TruncatedText>
                            </div>
                          )}
                        </div>
                        <p className="shrink-0 text-lg font-bold text-gray-900 tabular-nums">×{t.quantity}</p>
                      </div>
                    </TimelineItem>
                  ))}
                </TimelineGroup>
              ))}
            </Timeline>
          </div>
        )}
      </div>

      {/* Review modal — "Are you sure?" */}
      <Modal open={showConfirm} onClose={() => !submitting && setShowConfirm(false)} title="Review transfer" wide>
        <div className="space-y-4">
          {/* Neutral: "from" is not a warning. The amber/green pair implied a
              bad-to-good move. The labels and order carry the direction; the
              genuine warning in this modal is the "Are you sure?" panel below,
              which now has the only amber on the screen. */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
              <p className="text-xs font-medium uppercase text-gray-500">From</p>
              <p className="font-semibold text-gray-900 mt-0.5">
                {locations.find((l) => l.id === fromLocId)?.name || "—"}
              </p>
            </div>
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
              <p className="text-xs font-medium uppercase text-gray-500">To</p>
              <p className="font-semibold text-gray-900 mt-0.5">
                {locations.find((l) => l.id === toLocId)?.name || "—"}
              </p>
            </div>
          </div>

          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 text-xs font-medium text-gray-600 flex justify-between">
              <span>{draft.length} item{draft.length !== 1 ? "s" : ""} to move</span>
              <span>{totalDraftUnits} units · {formatZAR(totalDraftValue)}</span>
            </div>
            <div className="divide-y divide-gray-100 max-h-72 overflow-y-auto">
              {draft.map((it, idx) => (
                <div key={it.productId} className="px-4 py-2 flex items-center justify-between text-sm">
                  <div>
                    <span className="text-gray-400 text-xs font-mono mr-2">#{idx + 1}</span>
                    <span className="font-medium text-gray-900">{it.productName}</span>
                    <span className="text-xs text-gray-500 ml-2 font-mono">{it.inventoryId}</span>
                  </div>
                  <span className="font-semibold text-gray-900">×{it.quantity}</span>
                </div>
              ))}
            </div>
          </div>

          {notes && (
            <div className="bg-gray-50 rounded-lg p-3 text-sm">
              <p className="text-xs font-medium uppercase text-gray-500">Notes</p>
              <p className="text-gray-700 mt-1">{notes}</p>
            </div>
          )}

          <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-900 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <p>
              <strong>Are you sure?</strong> Confirming will move these items immediately and produce a transfer receipt you can print or share.
            </p>
          </div>

          {error && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded-lg text-sm">
              <AlertCircle className="w-4 h-4 mt-0.5" /> <span>{error}</span>
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <Button variant="secondary" onClick={() => setShowConfirm(false)} disabled={submitting} className="flex-1">
              Back
            </Button>
            <Button onClick={handleConfirm} loading={submitting} className="flex-1">
              <Check className="w-4 h-4 mr-1" /> Yes, confirm transfer
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/** Day heading for the transfer timeline — "Today"/"Yesterday" where it helps,
 *  an explicit date otherwise. */
function formatDayLabel(day: string): string {
  const today = localToday();
  const yesterday = localYesterday();

  if (day === today) return "Today";
  if (day === yesterday) return "Yesterday";
  return new Date(day + "T00:00:00").toLocaleDateString("en-ZA", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
