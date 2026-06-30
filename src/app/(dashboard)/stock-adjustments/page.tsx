"use client";
import { useState, useEffect } from "react";
import { db } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useOrg } from "@/lib/org-context";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Badge } from "@/components/ui/badge";
import type { Product } from "@/types/database";
import { Wrench, Plus, Search, ArrowDown, ArrowUp, Package, Store } from "lucide-react";

const REASONS = ["Breakage", "Expired", "Theft", "Damaged", "Samples", "Correction", "Other"] as const;

interface Adjustment {
  id: string;
  adjustment_date: string;
  product_id: string;
  reason: string;
  quantity: number;
  direction: string;
  notes: string | null;
  adjusted_by: string | null;
  stock_before: number;
  stock_after: number;
  created_at: string;
  location_id: string | null;
  product_name?: string;
  inventory_id?: string;
  location_name?: string;
}

export default function StockAdjustmentsPage() {
  const { name: userName } = useAuth();
  const { locations, currentLocationId, currentLocationName, canSwitchLocation } = useOrg();
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  /** quantity at each (product_id, location_id) so the form can show the
   * right "current stock" depending on which location is selected. */
  const [perLocationStock, setPerLocationStock] = useState<Record<string, Record<string, number>>>({});
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  // Form state
  const [formLocationId, setFormLocationId] = useState<string | null>(currentLocationId);
  const [selectedProduct, setSelectedProduct] = useState("");
  const [reason, setReason] = useState<string>("Breakage");
  const [direction, setDirection] = useState<"decrease" | "increase">("decrease");
  const [quantity, setQuantity] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [productSearch, setProductSearch] = useState("");

  useEffect(() => {
    loadData();
  }, []);

  // Keep the form's location in sync with the sidebar switcher each time
  // the form opens, so the operator does not have to re-pick.
  useEffect(() => {
    if (showForm && currentLocationId && !formLocationId) {
      setFormLocationId(currentLocationId);
    }
  }, [showForm, currentLocationId, formLocationId]);

  async function loadData() {
    setLoading(true);
    const [{ data: adj }, { data: prods }, { data: stockRows }] = await Promise.all([
      db
        .from("stock_adjustments")
        .select("*, products(name, inventory_id), locations(name)")
        .order("created_at", { ascending: false })
        .limit(50),
      db
        .from("products")
        .select("*")
        .eq("discontinued", false)
        .order("name"),
      db
        .from("product_stock")
        .select("product_id, location_id, quantity"),
    ]);

    const adjustmentList: Adjustment[] = ((adj || []) as any[]).map((a: any) => ({
      ...a,
      product_name: a.products?.name || "Unknown",
      inventory_id: a.products?.inventory_id || "",
      location_name: a.locations?.name || null,
    }));
    setAdjustments(adjustmentList);
    setProducts(prods || []);

    // Pivot product_stock into product_id -> location_id -> quantity
    const pls: Record<string, Record<string, number>> = {};
    ((stockRows || []) as { product_id: string; location_id: string; quantity: number }[]).forEach((r) => {
      if (!pls[r.product_id]) pls[r.product_id] = {};
      pls[r.product_id][r.location_id] = r.quantity;
    });
    setPerLocationStock(pls);

    setLoading(false);
  }

  function resetForm() {
    setSelectedProduct("");
    setReason("Breakage");
    setDirection("decrease");
    setQuantity("");
    setNotes("");
    setProductSearch("");
    setFormLocationId(currentLocationId);
  }

  function stockAt(productId: string, locationId: string | null): number {
    if (!locationId) return 0;
    return perLocationStock[productId]?.[locationId] ?? 0;
  }

  async function handleSave() {
    if (!formLocationId) {
      alert("Please pick a location.");
      return;
    }
    if (!selectedProduct || !quantity || parseInt(quantity) <= 0) {
      alert("Select a product and enter a valid quantity.");
      return;
    }

    setSaving(true);

    const qty = parseInt(quantity);
    const stockBefore = stockAt(selectedProduct, formLocationId);
    const stockAfter = direction === "decrease"
      ? Math.max(stockBefore - qty, 0)
      : stockBefore + qty;

    // 1. Record the adjustment with location_id
    const { error: adjErr } = await db.from("stock_adjustments").insert({
      adjustment_date: new Date().toISOString().split("T")[0],
      product_id: selectedProduct,
      reason,
      quantity: qty,
      direction,
      notes: notes.trim() || null,
      adjusted_by: userName,
      stock_before: stockBefore,
      stock_after: stockAfter,
      location_id: formLocationId,
    });

    if (adjErr) {
      alert("Error saving adjustment: " + adjErr.message);
      setSaving(false);
      return;
    }

    // 2. Apply the stock change to product_stock at the selected location
    if (direction === "decrease") {
      const { error: rpcErr } = await db.rpc("deduct_stock_at_location", {
        p_product_id: selectedProduct,
        p_quantity: qty,
        p_location_id: formLocationId,
      });
      if (rpcErr) console.error(rpcErr);
    } else {
      const { error: rpcErr } = await db.rpc("add_product_stock_at_location", {
        p_product_id: selectedProduct,
        p_quantity: qty,
        p_location_id: formLocationId,
      });
      if (rpcErr) console.error(rpcErr);
    }

    setSaving(false);
    setShowForm(false);
    resetForm();
    loadData();
  }

  const filteredProducts = products.filter((p) =>
    p.name.toLowerCase().includes(productSearch.toLowerCase()) ||
    p.inventory_id.toLowerCase().includes(productSearch.toLowerCase())
  );

  const selectedProd = products.find((p) => p.id === selectedProduct);
  const selectedProdStockAtFormLoc = selectedProd && formLocationId
    ? stockAt(selectedProd.id, formLocationId)
    : 0;

  const reasonColors: Record<string, string> = {
    Breakage: "red",
    Expired: "amber",
    Theft: "red",
    Damaged: "red",
    Samples: "blue",
    Correction: "gray",
    Other: "gray",
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Wrench className="w-7 h-7 text-green-600" />
            Stock Adjustments
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Record breakage, expired items, theft, or corrections. Each adjustment is tagged to a
            specific location.
          </p>
        </div>
        <Button onClick={() => setShowForm(true)}>
          <Plus className="w-4 h-4 mr-2" /> New Adjustment
        </Button>
      </div>

      {/* Adjustment history */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading...</div>
      ) : adjustments.length === 0 ? (
        <div className="text-center py-12">
          <Package className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500">No stock adjustments recorded yet.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {adjustments.map((adj) => (
            <div
              key={adj.id}
              className="bg-white border border-gray-200 rounded-xl px-5 py-4 flex items-center justify-between"
            >
              <div className="flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-gray-900">{adj.product_name}</span>
                  <span className="text-xs font-mono text-gray-400">{adj.inventory_id}</span>
                  <Badge color={reasonColors[adj.reason] || "gray"}>{adj.reason}</Badge>
                  {adj.location_name && (
                    <span className="text-xs text-gray-600 inline-flex items-center gap-1">
                      <Store className="w-3 h-3" /> {adj.location_name}
                    </span>
                  )}
                  {adj.direction === "decrease" ? (
                    <span className="text-xs text-red-600 flex items-center gap-0.5"><ArrowDown className="w-3 h-3" />Remove</span>
                  ) : (
                    <span className="text-xs text-green-600 flex items-center gap-0.5"><ArrowUp className="w-3 h-3" />Add</span>
                  )}
                </div>
                {adj.notes && <p className="text-sm text-gray-600 mt-1">{adj.notes}</p>}
                <p className="text-xs text-gray-400 mt-1">
                  {formatDate(adj.adjustment_date)} · {adj.adjusted_by || "Unknown"} · Stock: {adj.stock_before} → {adj.stock_after}
                </p>
              </div>
              <div className="text-right">
                <p className={`text-lg font-bold ${adj.direction === "decrease" ? "text-red-600" : "text-green-600"}`}>
                  {adj.direction === "decrease" ? "−" : "+"}{adj.quantity}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* New Adjustment Modal */}
      <Modal open={showForm} onClose={() => { setShowForm(false); resetForm(); }} title="New Stock Adjustment" wide>
        <div className="space-y-4">
          {/* Location picker */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-1.5">
              <Store className="w-4 h-4 text-gray-500" />
              Adjust stock at which location?
            </label>
            {canSwitchLocation && locations.length > 1 ? (
              <select
                value={formLocationId || ""}
                onChange={(e) => setFormLocationId(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
              >
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            ) : (
              <div className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5 text-sm text-gray-700">
                {currentLocationName ?? "(no location selected)"}
              </div>
            )}
            <p className="text-xs text-gray-500 mt-1">
              The adjustment changes stock for this location only. Other locations are unaffected.
            </p>
          </div>

          {/* Product search & select */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Product</label>
            {selectedProd ? (
              <div className="flex items-center justify-between bg-green-50 border border-green-200 rounded-lg px-4 py-3">
                <div>
                  <span className="font-medium text-gray-900">{selectedProd.name}</span>
                  <span className="text-xs text-gray-400 ml-2 font-mono">{selectedProd.inventory_id}</span>
                  <span className="block text-xs text-gray-500 mt-0.5">
                    Current stock at this location: <span className="font-medium text-gray-700">{selectedProdStockAtFormLoc}</span>
                  </span>
                </div>
                <button
                  onClick={() => setSelectedProduct("")}
                  className="text-xs text-red-500 hover:underline"
                >
                  Change
                </button>
              </div>
            ) : (
              <div>
                <div className="relative mb-2">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input
                    type="text"
                    value={productSearch}
                    onChange={(e) => setProductSearch(e.target.value)}
                    placeholder="Search products..."
                    className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
                    autoFocus
                  />
                </div>
                <div className="max-h-40 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
                  {filteredProducts.slice(0, 20).map((p) => {
                    const stockHere = formLocationId ? stockAt(p.id, formLocationId) : 0;
                    return (
                      <button
                        key={p.id}
                        onClick={() => { setSelectedProduct(p.id); setProductSearch(""); }}
                        className="w-full text-left px-3 py-2 hover:bg-green-50 text-sm flex justify-between"
                      >
                        <span>
                          <span className="text-xs font-mono text-gray-400 mr-2">{p.inventory_id}</span>
                          {p.name}
                        </span>
                        <span className="text-xs text-gray-400">Here: {stockHere}</span>
                      </button>
                    );
                  })}
                  {filteredProducts.length === 0 && (
                    <p className="text-sm text-gray-400 text-center py-4">No products found</p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Direction */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Adjustment type</label>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => setDirection("decrease")}
                className={`flex items-center justify-center gap-2 p-3 rounded-xl border-2 text-sm font-medium transition-all ${
                  direction === "decrease"
                    ? "border-red-500 bg-red-50 text-red-700"
                    : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
                }`}
              >
                <ArrowDown className="w-5 h-5" />
                Remove Stock
              </button>
              <button
                onClick={() => setDirection("increase")}
                className={`flex items-center justify-center gap-2 p-3 rounded-xl border-2 text-sm font-medium transition-all ${
                  direction === "increase"
                    ? "border-green-500 bg-green-50 text-green-700"
                    : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
                }`}
              >
                <ArrowUp className="w-5 h-5" />
                Add Stock
              </button>
            </div>
          </div>

          {/* Reason */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Reason</label>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
            >
              {REASONS.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>

          {/* Quantity */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Quantity</label>
            <input
              type="number"
              min="1"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="How many units?"
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
            />
            {selectedProd && quantity && parseInt(quantity) > 0 && (
              <p className="text-xs text-gray-500 mt-1">
                Stock at this location: {selectedProdStockAtFormLoc} → {direction === "decrease"
                  ? Math.max(selectedProdStockAtFormLoc - parseInt(quantity), 0)
                  : selectedProdStockAtFormLoc + parseInt(quantity)
                }
              </p>
            )}
          </div>

          {/* Notes */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes (optional)</label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Dropped crate, found expired in back"
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
            />
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-2">
            <Button variant="secondary" onClick={() => { setShowForm(false); resetForm(); }} className="flex-1">
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              loading={saving}
              disabled={!selectedProduct || !quantity || parseInt(quantity) <= 0 || !formLocationId}
              className="flex-1"
            >
              Save Adjustment
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
