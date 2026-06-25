"use client";
// Inter-branch stock transfers at /stock-transfers.
//
// Owners and admins move N units of one product from one shop to another.
// The transfer_stock RPC (migration 028) atomically decrements the source
// product_stock, increments the destination, and writes an audit row.
//
// Cashiers (role = 'member') see a permission notice and the recent list
// scoped to their location.

import { useEffect, useState, useCallback } from "react";
import { db } from "@/lib/supabase";
import { useOrg } from "@/lib/org-context";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowRightLeft, AlertCircle, Check, Package, MapPin, Send, Info,
} from "lucide-react";
import { formatZAR } from "@/lib/format";

interface Product {
  id: string;
  name: string;
  inventory_id: string;
  selling_price: number;
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

export default function StockTransfersPage() {
  const { role, locations, currentLocationId } = useOrg();
  const canTransfer = role === "owner" || role === "admin";
  const hasMultipleLocations = locations.length > 1;

  // Form state
  const [fromLocId, setFromLocId] = useState<string>("");
  const [toLocId, setToLocId] = useState<string>("");
  const [productId, setProductId] = useState<string>("");
  const [quantity, setQuantity] = useState<string>("");
  const [notes, setNotes] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Data
  const [products, setProducts] = useState<Product[]>([]);
  const [stockMap, setStockMap] = useState<Map<string, number>>(new Map());
  const [recent, setRecent] = useState<TransferRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Default From to user's current location, To to first other location
  useEffect(() => {
    if (!fromLocId && currentLocationId) setFromLocId(currentLocationId);
  }, [currentLocationId, fromLocId]);

  useEffect(() => {
    if (!toLocId && locations.length > 1 && fromLocId) {
      const other = locations.find((l) => l.id !== fromLocId);
      if (other) setToLocId(other.id);
    }
  }, [locations, fromLocId, toLocId]);

  // When From changes, reset product/qty
  useEffect(() => {
    setProductId("");
    setQuantity("");
  }, [fromLocId]);

  // Load products + stock at the source location
  const loadInventory = useCallback(async () => {
    if (!fromLocId) {
      setProducts([]);
      setStockMap(new Map());
      return;
    }
    const [{ data: prods }, { data: stock }] = await Promise.all([
      db.from("products").select("id, name, inventory_id, selling_price").eq("discontinued", false).order("name"),
      db.from("product_stock").select("product_id, quantity").eq("location_id", fromLocId),
    ]);
    setProducts((prods as Product[]) || []);
    const sm = new Map<string, number>();
    ((stock as { product_id: string; quantity: number }[]) || []).forEach((s) => sm.set(s.product_id, Number(s.quantity) || 0));
    setStockMap(sm);
  }, [fromLocId]);

  // Load recent transfers (last 20)
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
        id: r.id,
        product_id: r.product_id,
        product_name: prod?.name || "(deleted)",
        inventory_id: prod?.inventory_id || "",
        from_location_id: r.from_location_id,
        to_location_id: r.to_location_id,
        from_name: locNameById.get(r.from_location_id) || "—",
        to_name: locNameById.get(r.to_location_id) || "—",
        quantity: Number(r.quantity) || 0,
        notes: r.notes,
        transferred_by: r.transferred_by,
        transferred_at: r.transferred_at,
      };
    });
    setRecent(rows);
  }, [locations]);

  useEffect(() => {
    setLoading(true);
    Promise.all([loadInventory(), loadRecent()]).finally(() => setLoading(false));
  }, [loadInventory, loadRecent]);

  // Products visible in the dropdown: only ones with stock > 0 at source
  const availableProducts = products
    .map((p) => ({ ...p, available: stockMap.get(p.id) ?? 0 }))
    .filter((p) => p.available > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  const selectedAvailable = productId
    ? stockMap.get(productId) ?? 0
    : 0;

  async function handleTransfer(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const qty = parseInt(quantity, 10);
    if (!fromLocId || !toLocId || !productId || !qty || qty <= 0) {
      setError("Pick a product, source, destination, and a positive quantity.");
      return;
    }
    if (fromLocId === toLocId) {
      setError("Source and destination must differ.");
      return;
    }
    if (qty > selectedAvailable) {
      setError(`Only ${selectedAvailable} available at source.`);
      return;
    }

    setSubmitting(true);
    const { data, error: rpcErr } = await db.rpc("transfer_stock", {
      p_product_id: productId,
      p_from_location_id: fromLocId,
      p_to_location_id: toLocId,
      p_quantity: qty,
      p_notes: notes.trim() || null,
      p_transferred_by: null,
    });
    setSubmitting(false);

    if (rpcErr) {
      setError(rpcErr.message);
      return;
    }

    const pName = products.find((p) => p.id === productId)?.name || "stock";
    const fromName = locations.find((l) => l.id === fromLocId)?.name || "source";
    const toName = locations.find((l) => l.id === toLocId)?.name || "destination";
    setSuccess(`Moved ${qty} × ${pName} from ${fromName} to ${toName}.`);

    setProductId("");
    setQuantity("");
    setNotes("");
    await Promise.all([loadInventory(), loadRecent()]);
    setTimeout(() => setSuccess(null), 4000);
    void data;
  }

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

  return (
    <div className="max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <ArrowRightLeft className="w-7 h-7 text-green-600" /> Stock Transfers
        </h1>
        <p className="text-sm text-gray-500 mt-1">Move stock between your shops. Each transfer is recorded in the audit log below.</p>
      </div>

      {!canTransfer && (
        <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-xl px-5 py-4 mb-6 flex items-start gap-3">
          <Info className="w-5 h-5 mt-0.5 flex-shrink-0" />
          <div className="text-sm">
            <p className="font-semibold">Owners and admins only.</p>
            <p className="mt-1">
              Cashiers cannot initiate transfers. Ask your owner or admin to move the stock. The recent transfers below are read-only.
            </p>
          </div>
        </div>
      )}

      {canTransfer && (
        <form onSubmit={handleTransfer} className="bg-white border border-gray-200 rounded-2xl p-6 mb-6 space-y-4">
          <h2 className="text-lg font-semibold text-gray-900">New transfer</h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1 inline-flex items-center gap-1">
                <MapPin className="w-3.5 h-3.5" /> From location
              </label>
              <select value={fromLocId} onChange={(e) => setFromLocId(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500" required>
                <option value="">— pick source —</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1 inline-flex items-center gap-1">
                <MapPin className="w-3.5 h-3.5 text-green-600" /> To location
              </label>
              <select value={toLocId} onChange={(e) => setToLocId(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500" required>
                <option value="">— pick destination —</option>
                {locations.filter((l) => l.id !== fromLocId).map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1 inline-flex items-center gap-1">
                <Package className="w-3.5 h-3.5" /> Product
              </label>
              <select value={productId} onChange={(e) => setProductId(e.target.value)}
                disabled={!fromLocId || availableProducts.length === 0}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500 disabled:bg-gray-50 disabled:text-gray-400" required>
                <option value="">{!fromLocId ? "Pick a source first" : availableProducts.length === 0 ? "No products in stock at source" : "— pick product —"}</option>
                {availableProducts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.inventory_id}) · {p.available} on hand · {formatZAR(p.selling_price)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Quantity</label>
              <input type="number" inputMode="numeric" min="1" max={selectedAvailable || undefined}
                value={quantity} onChange={(e) => setQuantity(e.target.value)}
                disabled={!productId}
                placeholder={productId ? `max ${selectedAvailable}` : ""}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:border-green-500 focus:ring-1 focus:ring-green-500 disabled:bg-gray-50" required />
            </div>
          </div>

          <div>
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
          {success && (
            <div className="flex items-start gap-2 bg-green-50 border border-green-200 text-green-800 px-4 py-2 rounded-lg text-sm">
              <Check className="w-4 h-4 mt-0.5" /> <span>{success}</span>
            </div>
          )}

          <Button type="submit" loading={submitting}>
            <Send className="w-4 h-4 mr-1" /> Transfer
          </Button>
        </form>
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
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-5 py-3 font-medium text-gray-500">When</th>
                  <th className="text-left px-5 py-3 font-medium text-gray-500">Product</th>
                  <th className="text-right px-5 py-3 font-medium text-gray-500">Qty</th>
                  <th className="text-left px-5 py-3 font-medium text-gray-500">From → To</th>
                  <th className="text-left px-5 py-3 font-medium text-gray-500">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {recent.map((t) => (
                  <tr key={t.id}>
                    <td className="px-5 py-3 text-gray-700 whitespace-nowrap">
                      {new Date(t.transferred_at).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" })}
                    </td>
                    <td className="px-5 py-3">
                      <div className="font-medium text-gray-900">{t.product_name}</div>
                      <div className="text-xs text-gray-400 font-mono">{t.inventory_id}</div>
                    </td>
                    <td className="px-5 py-3 text-right font-semibold text-gray-900">{t.quantity}</td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2 text-xs">
                        <Badge color="amber">{t.from_name}</Badge>
                        <ArrowRightLeft className="w-3.5 h-3.5 text-gray-400" />
                        <Badge color="green">{t.to_name}</Badge>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-gray-600 max-w-xs truncate" title={t.notes || ""}>
                      {t.notes || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
