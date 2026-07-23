"use client";
import { useState, useEffect } from "react";
import { db } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useOrg } from "@/lib/org-context";
import { fetchAllPaged } from "@/lib/fetch-all";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { formatZAR, formatDate } from "@/lib/format";
import { PackagePlus, Plus, Trash2, Search, Save, History } from "lucide-react";
import type { Product, Ingredient } from "@/types/database";
import { SupplierSelect } from "@/components/suppliers/supplier-select";

interface ReceiptLine {
  id: string;
  type: "product" | "ingredient";
  itemId: string;
  itemName: string;
  inventoryId?: string;
  quantity: number;
  unitCost: number;
  qtyInPack: number; // units per pack (products only, 1 for ingredients)
}

interface PastReceipt {
  id: string;
  receipt_date: string;
  supplier: string | null;
  total_cost: number;
  recorded_by: string | null;
  created_at: string;
}

export default function ReceiveStockPage() {
  const { name } = useAuth();
  const { currentLocationId, currentLocationName } = useOrg();
  const [products, setProducts] = useState<Product[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [lines, setLines] = useState<ReceiptLine[]>([]);
  const [supplier, setSupplier] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [search, setSearch] = useState("");
  const [showPicker, setShowPicker] = useState(false);
  const [tab, setTab] = useState<"new" | "history">("new");
  const [history, setHistory] = useState<PastReceipt[]>([]);
  const [createExpense, setCreateExpense] = useState(true);
  // How the delivery was paid for. Drives the cash-spent report: stock bought
  // on account leaves the bank later, so it must not count as cash out today.
  const [paidBy, setPaidBy] = useState<"cash" | "account" | "electronic">("cash");

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    // Paginate products via .range() — Supabase max_rows (default 1000)
    // would otherwise truncate large catalogues. Ingredients tables stay
    // small so a plain query is fine there.
    const [prods, { data: ings }, { data: hist }] = await Promise.all([
      fetchAllPaged<Product>(() =>
        db.from("products").select("*").eq("discontinued", false).order("name")
      ),
      db.from("ingredients").select("*").order("name"),
      db.from("stock_receipts").select("*").order("created_at", { ascending: false }).limit(20),
    ]);
    setProducts(prods);
    setIngredients(ings || []);
    setHistory(hist || []);
  }

  function addLine(type: "product" | "ingredient", item: Product | Ingredient) {
    const existing = lines.find(
      (l) => l.type === type && l.itemId === item.id
    );
    if (existing) {
      setLines(lines.map((l) =>
        l.id === existing.id ? { ...l, quantity: l.quantity + 1 } : l
      ));
    } else {
      const unitCost = type === "product"
        ? ((item as Product).package_price || 0)
        : (item as Ingredient).purchase_price;
      const qtyInPack = type === "product" ? ((item as Product).qty_in_pack || 1) : 1;
      setLines([
        ...lines,
        {
          id: crypto.randomUUID(),
          type,
          itemId: item.id,
          itemName: item.name,
          inventoryId: type === "product" ? (item as Product).inventory_id : undefined,
          quantity: 1,
          unitCost,
          qtyInPack,
        },
      ]);
    }
    setShowPicker(false);
    setSearch("");
  }

  function updateLine(id: string, field: "quantity" | "unitCost", value: number) {
    setLines(lines.map((l) => (l.id === id ? { ...l, [field]: value } : l)));
  }

  function removeLine(id: string) {
    setLines(lines.filter((l) => l.id !== id));
  }

  const totalCost = lines.reduce((sum, l) => sum + l.quantity * l.unitCost, 0);

  async function handleSave() {
    if (lines.length === 0) return;
    setSaving(true);
    setSuccess(false);

    try {
      // 1. Create receipt header
      const { data: receipt, error: hErr } = await db
        .from("stock_receipts")
        .insert({
          receipt_date: new Date().toISOString().split("T")[0],
          supplier: supplier || null,
          notes: notes || null,
          total_cost: totalCost,
          recorded_by: name,
          paid_by: paidBy,
        })
        .select()
        .single();
      if (hErr) throw hErr;

      // 2. Create receipt items
      const items = lines.map((l) => ({
        receipt_id: receipt.id,
        product_id: l.type === "product" ? l.itemId : null,
        ingredient_id: l.type === "ingredient" ? l.itemId : null,
        quantity: l.quantity,
        unit_cost: l.unitCost,
      }));
      const { error: iErr } = await db.from("stock_receipt_items").insert(items);
      if (iErr) throw iErr;

      // 3. Increment stock for each line (packs × qty_in_pack = total units)
      // Per-location: stock goes into product_stock for the current location.
      // Falls back to org-wide add_product_stock if the location-aware RPC
      // is missing (migration 024 has not yet run).
      for (const l of lines) {
        if (l.type === "product") {
          const totalUnits = Math.round(l.quantity * l.qtyInPack);
          let locOk = false;
          if (currentLocationId) {
            const { error: locErr } = await db.rpc("add_product_stock_at_location", {
              p_product_id: l.itemId,
              p_quantity: totalUnits,
              p_location_id: currentLocationId,
            });
            if (!locErr) locOk = true;
          }
          if (locOk) continue;
          // Legacy fallback: org-wide
          const { error } = await db.rpc("add_product_stock", {
            p_product_id: l.itemId,
            p_quantity: totalUnits,
          });
          if (error) {
            const { data: prod } = await db
              .from("products")
              .select("opening_stock")
              .eq("id", l.itemId)
              .single();
            if (prod) {
              await db
                .from("products")
                .update({ opening_stock: (prod.opening_stock || 0) + totalUnits })
                .eq("id", l.itemId);
            }
          }
        } else {
          const { error } = await db.rpc("add_ingredient_stock", {
            p_ingredient_id: l.itemId,
            p_quantity: l.quantity,
          });
          if (error) {
            const { data: ing } = await db
              .from("ingredients")
              .select("current_stock")
              .eq("id", l.itemId)
              .single();
            if (ing) {
              await db
                .from("ingredients")
                .update({ current_stock: (ing.current_stock || 0) + l.quantity })
                .eq("id", l.itemId);
            }
          }
        }
      }

      // 4. Optionally create expense entry
      if (createExpense && totalCost > 0) {
        await db.from("expenses").insert({
          expense_date: new Date().toISOString().split("T")[0],
          category: "Stock Purchases",
          description: supplier ? `Stock delivery from ${supplier}` : "Stock delivery",
          amount: totalCost,
          recorded_by: name,
        });
      }

      setSuccess(true);
      setLines([]);
      setSupplier("");
      setNotes("");
      loadData();
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      alert("Error saving receipt: " + (err instanceof Error ? err.message : "Unknown error"));
    } finally {
      setSaving(false);
    }
  }

  // Filter items for picker — split products into purchased vs prepared
  const searchLower = search.toLowerCase();
  const allFilteredProducts = products.filter(
    (p) =>
      p.name.toLowerCase().includes(searchLower) ||
      p.inventory_id.toLowerCase().includes(searchLower)
  );
  const filteredProducts = allFilteredProducts.filter((p) => !p.is_prepared);
  const filteredPrepared = allFilteredProducts.filter((p) => p.is_prepared);
  const filteredIngredients = ingredients.filter((i) =>
    i.name.toLowerCase().includes(searchLower)
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <PackagePlus className="w-7 h-7 text-green-600" />
            Receive Stock
          </h1>
          <p className="text-sm text-gray-500 mt-1">Record incoming deliveries for products and ingredients</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant={tab === "new" ? "primary" : "secondary"}
            onClick={() => setTab("new")}
            size="sm"
          >
            <Plus className="w-4 h-4 mr-1" /> New Receipt
          </Button>
          <Button
            variant={tab === "history" ? "primary" : "secondary"}
            onClick={() => setTab("history")}
            size="sm"
          >
            <History className="w-4 h-4 mr-1" /> History
          </Button>
        </div>
      </div>

      {tab === "new" && (
        <div className="space-y-6">
          {/* Supplier and notes */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Supplier (optional)</label>
              <SupplierSelect value={supplier} onChange={setSupplier} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Notes (optional)</label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. Weekly restock, Invoice #12345"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
              />
            </div>
          </div>

          {/* Add item button */}
          <div>
            <Button onClick={() => setShowPicker(true)} variant="secondary">
              <Plus className="w-4 h-4 mr-2" /> Add Item
            </Button>
          </div>

          {/* Item picker dropdown */}
          {showPicker && (
            <div className="bg-white border border-gray-200 rounded-xl shadow-lg p-4">
              <div className="relative mb-3">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search products or ingredients..."
                  className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
                  autoFocus
                />
              </div>
              <div className="max-h-60 overflow-y-auto space-y-1">
                {filteredProducts.length > 0 && (
                  <>
                    <p className="text-xs font-semibold text-gray-500 uppercase px-2 py-1">Products</p>
                    {filteredProducts.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => addLine("product", p)}
                        className="w-full text-left px-3 py-2 rounded-lg hover:bg-green-50 text-sm flex items-center justify-between"
                      >
                        <span>
                          <span className="text-xs font-mono text-gray-400 mr-2">{p.inventory_id}</span>
                          {p.name}
                        </span>
                        <span className="text-xs text-gray-400">Stock: {p.opening_stock}</span>
                      </button>
                    ))}
                  </>
                )}
                {filteredPrepared.length > 0 && (
                  <>
                    <p className="text-xs font-semibold text-gray-500 uppercase px-2 py-1 mt-2">Prepared Items (no cost)</p>
                    {filteredPrepared.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => addLine("product", p)}
                        className="w-full text-left px-3 py-2 rounded-lg hover:bg-amber-50 text-sm flex items-center justify-between"
                      >
                        <span>
                          <span className="text-xs font-mono text-gray-400 mr-2">{p.inventory_id}</span>
                          {p.name}
                          <span className="ml-2 text-xs text-amber-600">Prepared</span>
                        </span>
                        <span className="text-xs text-gray-400">Stock: {p.opening_stock}</span>
                      </button>
                    ))}
                  </>
                )}
                {filteredIngredients.length > 0 && (
                  <>
                    <p className="text-xs font-semibold text-gray-500 uppercase px-2 py-1 mt-2">Ingredients</p>
                    {filteredIngredients.map((i) => (
                      <button
                        key={i.id}
                        onClick={() => addLine("ingredient", i)}
                        className="w-full text-left px-3 py-2 rounded-lg hover:bg-blue-50 text-sm flex items-center justify-between"
                      >
                        <span>{i.name}</span>
                        <span className="text-xs text-gray-400">Stock: {i.current_stock} {i.unit}</span>
                      </button>
                    ))}
                  </>
                )}
                {filteredProducts.length === 0 && filteredPrepared.length === 0 && filteredIngredients.length === 0 && (
                  <p className="text-sm text-gray-400 text-center py-4">No items found</p>
                )}
              </div>
              <div className="mt-3 pt-3 border-t">
                <Button variant="ghost" size="sm" onClick={() => { setShowPicker(false); setSearch(""); }}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {/* Lines table */}
          {lines.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-gray-700">Item</th>
                    <th className="text-center px-4 py-3 font-medium text-gray-700 w-28">Qty</th>
                    <th className="text-center px-4 py-3 font-medium text-gray-700 w-32">Unit Cost (R)</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-700 w-28">Line Total</th>
                    <th className="w-12" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {lines.map((l) => (
                    <tr key={l.id}>
                      <td className="px-4 py-3">
                        <span className="font-medium">{l.itemName}</span>
                        {l.inventoryId && (
                          <span className="text-xs text-gray-400 ml-2 font-mono">{l.inventoryId}</span>
                        )}
                        <span className={`ml-2 text-xs px-1.5 py-0.5 rounded ${l.type === "product" ? "bg-green-50 text-green-700" : "bg-blue-50 text-blue-700"}`}>
                          {l.type}
                        </span>
                        {l.type === "product" && l.qtyInPack > 1 && (
                          <span className="block text-xs text-gray-400 mt-0.5">
                            {l.quantity} pack{l.quantity !== 1 ? "s" : ""} × {l.qtyInPack} = {Math.round(l.quantity * l.qtyInPack)} units
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <input
                          type="number"
                          min="0"
                          step={l.type === "ingredient" ? "0.01" : "1"}
                          value={l.quantity}
                          onChange={(e) => updateLine(l.id, "quantity", parseFloat(e.target.value) || 0)}
                          className="w-full text-center border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={l.unitCost}
                          onChange={(e) => updateLine(l.id, "unitCost", parseFloat(e.target.value) || 0)}
                          className="w-full text-center border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
                        />
                      </td>
                      <td className="px-4 py-3 text-right font-medium">{formatZAR(l.quantity * l.unitCost)}</td>
                      <td className="px-2 py-3">
                        <Tooltip label="Remove item">
                          <button
                            onClick={() => removeLine(l.id)}
                            aria-label="Remove item"
                            className="p-1.5 text-gray-400 hover:text-red-600 rounded"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </Tooltip>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-gray-50">
                  <tr>
                    <td colSpan={3} className="px-4 py-3 text-right font-semibold text-gray-700">Total</td>
                    <td className="px-4 py-3 text-right font-bold text-lg text-gray-900">{formatZAR(totalCost)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {/* Options */}
          {lines.length > 0 && (
            <div className="space-y-4">
              <div>
                <p className="text-sm font-medium text-gray-700 mb-2">How was this paid?</p>
                <div className="flex flex-wrap gap-2">
                  {([
                    { key: "cash", label: "Cash" },
                    { key: "account", label: "On account" },
                    { key: "electronic", label: "EFT / card" },
                  ] as const).map((opt) => (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => setPaidBy(opt.key)}
                      className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                        paidBy === opt.key
                          ? "border-green-500 bg-green-50 text-green-700"
                          : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-gray-500 mt-2">
                  {paidBy === "account"
                    ? "Counted as cash spent on the day you pay the supplier, not today."
                    : "Counted as money out today on the Cash spent report."}
                </p>
              </div>

              <div className="flex items-center justify-between gap-3 flex-wrap">
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={createExpense}
                    onChange={(e) => setCreateExpense(e.target.checked)}
                    className="rounded border-gray-300 text-green-600 focus:ring-green-500"
                  />
                  Also record as &quot;Stock Purchases&quot; expense
                </label>
                <Button onClick={handleSave} loading={saving} disabled={lines.length === 0}>
                  <Save className="w-4 h-4 mr-2" />
                  Save Receipt — {formatZAR(totalCost)}
                </Button>
              </div>
            </div>
          )}

          {success && (
            <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm">
              Stock receipt saved successfully. Product and ingredient stock levels have been updated.
            </div>
          )}
        </div>
      )}

      {tab === "history" && (
        <div className="space-y-3">
          {history.length === 0 ? (
            <div className="text-center py-12 text-gray-400">
              <PackagePlus className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p>No stock receipts recorded yet.</p>
            </div>
          ) : (
            history.map((r) => (
              <div key={r.id} className="bg-white border border-gray-200 rounded-xl px-5 py-4 flex items-center justify-between">
                <div>
                  <p className="font-medium text-gray-900">{r.supplier || "No supplier"}</p>
                  <p className="text-sm text-gray-500">{formatDate(r.receipt_date)} · Recorded by {r.recorded_by || "Unknown"}</p>
                </div>
                <p className="text-lg font-bold text-gray-900">{formatZAR(r.total_cost)}</p>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
