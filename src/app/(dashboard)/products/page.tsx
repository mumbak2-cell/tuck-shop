"use client";
import { useEffect, useState, useCallback } from "react";
import { db } from "@/lib/supabase";
import { Product } from "@/types/database";
import { formatZAR } from "@/lib/format";
import { useOrg } from "@/lib/org-context";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { ProductForm } from "@/components/products/product-form";
import { CsvUploadModal } from "@/components/products/csv-upload";
import { Plus, Search, Filter, Upload } from "lucide-react";

export default function ProductsPage() {
  const { currentLocationId, currentLocationName } = useOrg();
  const [products, setProducts] = useState<Product[]>([]);
  const [stockByProduct, setStockByProduct] = useState<Record<string, number>>({});
  /** True once the per-location product_stock query has returned. A missing
   * entry in stockByProduct means "zero at this location" only after this
   * flag flips - before then we cannot distinguish "no row" from "not loaded". */
  const [perLocationLoaded, setPerLocationLoaded] = useState(false);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [showCsv, setShowCsv] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);

  // Load the org's categories. We merge the explicit categories table with
  // any category values actually present on products — bulk CSV imports
  // often introduce categories that were never seeded into the categories
  // table, and we still want them to show up in the filter dropdown.
  useEffect(() => {
    (async () => {
      const [{ data: catRows }, { data: prodCats }] = await Promise.all([
        db.from("categories").select("name").eq("active", true).order("sort_order"),
        db.from("products").select("category").eq("discontinued", false).limit(100000),
      ]);
      const ordered = ((catRows as { name: string }[]) || []).map((c) => c.name);
      const fromProducts = new Set<string>();
      ((prodCats as { category: string | null }[]) || []).forEach((r) => {
        const c = (r.category || "").trim();
        if (c) fromProducts.add(c);
      });
      const known = new Set(ordered);
      const leftovers = [...fromProducts]
        .filter((c) => !known.has(c))
        .sort((a, b) => a.localeCompare(b));
      setCategories([...ordered, ...leftovers]);
    })();
  }, []);

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    let query = db
      .from("products")
      .select("*")
      .eq("discontinued", false)
      .order("inventory_id", { ascending: true })
      // Raise the default 1000-row PostgREST cap so operators with 1000+
      // SKUs (Devine Bakes runs ~1380) see every product.
      .limit(100000);

    if (categoryFilter) query = query.eq("category", categoryFilter);
    if (search) query = query.ilike("name", `%${search}%`);

    const { data, error } = await query;
    if (error) console.error("Error fetching products:", error);
    else setProducts(data || []);

    // Fetch per-location stock for the current location so the table shows
    // accurate stock for this shop. If the query succeeds we treat missing
    // entries as 0 (the product simply has no allocation at this location).
    // If the query errors (e.g. migration 024 not yet run, product_stock
    // table does not exist), we fall back to the legacy products.opening_stock.
    if (currentLocationId) {
      const { data: stockRows, error: stockErr } = await db
        .from("product_stock")
        .select("product_id, quantity")
        .eq("location_id", currentLocationId)
        .limit(100000);
      if (stockErr) {
        setPerLocationLoaded(false);
        setStockByProduct({});
      } else {
        const map: Record<string, number> = {};
        ((stockRows as { product_id: string; quantity: number }[]) || []).forEach((r) => {
          map[r.product_id] = r.quantity;
        });
        setStockByProduct(map);
        setPerLocationLoaded(true);
      }
    } else {
      setPerLocationLoaded(false);
      setStockByProduct({});
    }

    setLoading(false);
  }, [search, categoryFilter, currentLocationId]);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  function handleEdit(product: Product) {
    setEditing(product);
    setShowForm(true);
  }

  function handleClose() {
    setShowForm(false);
    setEditing(null);
  }

  async function handleSaved() {
    handleClose();
    await fetchProducts();
  }

  async function handleDiscontinue(product: Product) {
    if (!confirm(`Discontinue "${product.name}"? It will be hidden from the product list.`)) return;
    const { error } = await db
      .from("products")
      .update({ discontinued: true })
      .eq("id", product.id);
    if (error) alert("Error: " + error.message);
    else fetchProducts();
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Products</h1>
          {currentLocationName && (
            <p className="text-xs text-gray-500 mt-0.5">
              Showing stock for <span className="font-medium text-gray-700">{currentLocationName}</span>. Product catalogue is shared across all locations.
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setShowCsv(true)}>
            <Upload className="w-4 h-4 mr-2" /> CSV Import
          </Button>
          <Button onClick={() => setShowForm(true)}>
            <Plus className="w-4 h-4 mr-2" /> Add Product
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search products..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
          />
        </div>
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-gray-400" />
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
          >
            <option value="">All Categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Product table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-4 py-3 font-medium text-gray-500">ID</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Product</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Category</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500">Cost</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500">Price</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500">Margin</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500">Stock</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={8} className="px-4 py-12 text-center text-gray-400">Loading...</td></tr>
              ) : products.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-12 text-center text-gray-400">No products found</td></tr>
              ) : (
                products.map((p) => {
                  const margin = p.cost_per_unit && p.selling_price
                    ? ((p.selling_price - p.cost_per_unit) / p.selling_price) * 100
                    : null;
                  // Per-location stock: when product_stock has loaded for the
                  // current location, treat a missing entry as 0 (no allocation
                  // at this shop). Only fall back to the legacy org-wide
                  // products.opening_stock if the per-location query itself failed.
                  const locStock = stockByProduct[p.id];
                  const displayStock = perLocationLoaded
                    ? (locStock ?? 0)
                    : p.opening_stock;
                  const lowStock = displayStock <= p.reorder_level && p.reorder_level > 0;
                  return (
                    <tr key={p.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-gray-500 font-mono text-xs">{p.inventory_id}</td>
                      <td className="px-4 py-3 font-medium text-gray-900">
                        {p.name}
                        {p.is_prepared && <Badge variant="blue">Prepared</Badge>}
                      </td>
                      <td className="px-4 py-3 text-gray-600">{p.category}</td>
                      <td className="px-4 py-3 text-right text-gray-600">
                        {p.cost_per_unit ? formatZAR(p.cost_per_unit) : "—"}
                      </td>
                      <td className="px-4 py-3 text-right font-medium">{formatZAR(p.selling_price)}</td>
                      <td className="px-4 py-3 text-right">
                        {margin !== null ? (
                          <Badge variant={margin < 10 ? "red" : margin < 30 ? "yellow" : "green"}>
                            {margin.toFixed(1)}%
                          </Badge>
                        ) : "—"}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className={lowStock ? "text-red-600 font-semibold" : ""}>
                          {displayStock}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right space-x-2">
                        <button onClick={() => handleEdit(p)} className="text-green-600 hover:underline text-xs">Edit</button>
                        <button onClick={() => handleDiscontinue(p)} className="text-red-500 hover:underline text-xs">Remove</button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Product form modal */}
      <Modal open={showForm} onClose={handleClose} title={editing ? "Edit Product" : "Add Product"} wide>
        <ProductForm product={editing} onSaved={handleSaved} onCancel={handleClose} />
      </Modal>

      {/* CSV upload modal */}
      <CsvUploadModal
        open={showCsv}
        onClose={() => setShowCsv(false)}
        onComplete={fetchProducts}
      />
    </div>
  );
}
