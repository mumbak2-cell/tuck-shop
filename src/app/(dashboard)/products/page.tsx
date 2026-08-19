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
import { fetchAllPaged } from "@/lib/fetch-all";
import { useDebounce } from "@/lib/use-debounce";
import { Tooltip } from "@/components/ui/tooltip";
import { localToday } from "@/lib/date-utils";
import { TruncatedText } from "@/components/ui/truncate";
import { ActionMenu, MenuItem } from "@/components/ui/menu";
import { useToast } from "@/components/ui/toast";
import { Plus, Search, Filter, Upload, Download, Tag, Pencil, Trash2 } from "lucide-react";

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
  const debouncedSearch = useDebounce(search, 300);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [showCsv, setShowCsv] = useState(false);
  const [showCategories, setShowCategories] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<"" | "price" | "discontinue">("");
  const [bulkPricePercent, setBulkPricePercent] = useState("");
  const [bulkProcessing, setBulkProcessing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const toast = useToast();

  // Load the org's categories. We merge the explicit categories table with
  // any category values actually present on products — bulk CSV imports
  // often introduce categories that were never seeded into the categories
  // table, and we still want them to show up in the filter dropdown.
  // The products read is paginated because Supabase's server-side max_rows
  // (default 1000) silently truncates large catalogues otherwise.
  useEffect(() => {
    (async () => {
      const [{ data: catRows }, prodCats] = await Promise.all([
        db.from("categories").select("name").eq("active", true).order("sort_order"),
        fetchAllPaged<{ category: string | null }>(() =>
          db.from("products").select("category").eq("discontinued", false)
        ),
      ]);
      const ordered = ((catRows as { name: string }[]) || []).map((c) => c.name);
      const fromProducts = new Set<string>();
      prodCats.forEach((r) => {
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

    // Paginate via .range() so we get every product regardless of Supabase's
    // server-side max_rows ceiling (default 1000). Operators like Devine
    // Bakes carry ~1380 SKUs; a simple .limit() is silently truncated at the
    // server when max_rows is set.
    try {
      const all = await fetchAllPaged<Product>(() => {
        let q = db
          .from("products")
          .select("*")
          .eq("discontinued", false)
          .order("inventory_id", { ascending: true });
        if (categoryFilter) q = q.eq("category", categoryFilter);
        if (debouncedSearch) q = q.ilike("name", `%${debouncedSearch}%`);
        return q;
      });
      setProducts(all);
    } catch (e) {
      console.error("Error fetching products:", e);
      setProducts([]);
    }

    // Fetch per-location stock for the current location so the table shows
    // accurate stock for this shop. If the query succeeds we treat missing
    // entries as 0 (the product simply has no allocation at this location).
    // If the query errors (e.g. migration 024 not yet run, product_stock
    // table does not exist), we fall back to the legacy products.opening_stock.
    if (currentLocationId) {
      try {
        const stockRows = await fetchAllPaged<{ product_id: string; quantity: number }>(() =>
          db
            .from("product_stock")
            .select("product_id, quantity")
            .eq("location_id", currentLocationId)
        );
        const map: Record<string, number> = {};
        stockRows.forEach((r) => {
          map[r.product_id] = r.quantity;
        });
        setStockByProduct(map);
        setPerLocationLoaded(true);
      } catch {
        setPerLocationLoaded(false);
        setStockByProduct({});
      }
    } else {
      setPerLocationLoaded(false);
      setStockByProduct({});
    }

    setLoading(false);
  }, [debouncedSearch, categoryFilter, currentLocationId]);

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

  async function handleExport() {
    // The export menu item closes its dropdown immediately on click, so
    // there's no button left to disable — a toast is the only visible
    // feedback while the main thread builds the CSV string on large
    // catalogues. The exporting guard just prevents a double-trigger.
    if (exporting) return;
    setExporting(true);
    toast.info("Exporting products…");
    try {
      await handleExportInner();
    } finally {
      setExporting(false);
    }
  }

  async function handleExportInner() {
    // Export the full product list (subject to current search / category filter)
    // as CSV with per-location current stock attached. The format mirrors what
    // CSV Import accepts, so round-trip editing in Excel/Sheets is clean.
    //
    // Every Supabase read here is paginated via .range() to bypass the
    // server-side max_rows ceiling (default 1000). Without this, Devine
    // Bakes' 1380 SKUs were truncated to 999 rows on export.
    //
    // We also re-fetch products inside the export — never trust the page's
    // products state alone — so if the user clicked Export before the
    // background fetchProducts had finished, the CSV is still complete.
    const [exportProducts, stock, { data: locs }] = await Promise.all([
      fetchAllPaged<Product>(() => {
        let q = db
          .from("products")
          .select("*")
          .eq("discontinued", false)
          .order("inventory_id", { ascending: true });
        if (categoryFilter) q = q.eq("category", categoryFilter);
        if (debouncedSearch) q = q.ilike("name", `%${debouncedSearch}%`);
        return q;
      }),
      fetchAllPaged<{ product_id: string; location_id: string; quantity: number }>(() =>
        db.from("product_stock").select("product_id, location_id, quantity")
      ),
      db.from("locations").select("id, name").eq("active", true).order("sort_order"),
    ]);

    const locNameById = new Map<string, string>(
      ((locs || []) as { id: string; name: string }[]).map((l) => [l.id, l.name])
    );
    const stockByPid = new Map<string, { location_id: string; quantity: number }[]>();
    stock.forEach((s) => {
      const arr = stockByPid.get(s.product_id) ?? [];
      arr.push({ location_id: s.location_id, quantity: s.quantity });
      stockByPid.set(s.product_id, arr);
    });

    const header = "Inventory ID,Name,Category,Location,Current Stock,Reorder Level,Cost / Pack,Qty In Pack,Selling Price";
    const lines: string[] = [];
    exportProducts.forEach((p) => {
      const rows = stockByPid.get(p.id) ?? [];
      if (rows.length === 0) {
        lines.push(`${p.inventory_id},"${escapeCsv(p.name)}","${escapeCsv(p.category || "")}","(org-wide)",${p.opening_stock},${p.reorder_level},${p.package_price || 0},${p.qty_in_pack || 0},${p.selling_price}`);
      } else {
        rows.forEach((s) => {
          lines.push(`${p.inventory_id},"${escapeCsv(p.name)}","${escapeCsv(p.category || "")}","${locNameById.get(s.location_id) || "—"}",${s.quantity},${p.reorder_level},${p.package_price || 0},${p.qty_in_pack || 0},${p.selling_price}`);
        });
      }
    });

    const bom = "﻿";
    const csv = bom + [header, ...lines].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `products_with_stock_${localToday()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function escapeCsv(s: string): string {
    return s.replace(/"/g, '""');
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selectedIds.size === products.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(products.map((p) => p.id)));
    }
  }

  async function handleBulkPriceUpdate() {
    const pct = parseFloat(bulkPricePercent);
    if (isNaN(pct) || pct === 0) return;
    if (!window.confirm(`Adjust selling price by ${pct > 0 ? "+" : ""}${pct}% for ${selectedIds.size} products?`)) return;
    setBulkProcessing(true);
    const targets = products.filter((p) => selectedIds.has(p.id));
    const failures: string[] = [];
    for (const p of targets) {
      const newPrice = Math.round(p.selling_price * (1 + pct / 100) * 100) / 100;
      const { error } = await db.from("products").update({ selling_price: newPrice }).eq("id", p.id);
      if (error) failures.push(`${p.name}: ${error.message}`);
    }
    setBulkProcessing(false);
    if (failures.length > 0) {
      alert(`${targets.length - failures.length} updated, ${failures.length} failed:\n${failures.join("\n")}`);
    }
    setSelectedIds(new Set());
    setBulkAction("");
    setBulkPricePercent("");
    fetchProducts();
  }

  async function handleBulkDiscontinue() {
    if (!window.confirm(`Discontinue ${selectedIds.size} selected products?`)) return;
    setBulkProcessing(true);
    const targets = products.filter((p) => selectedIds.has(p.id));
    const failures: string[] = [];
    for (const id of selectedIds) {
      const { error } = await db.from("products").update({ discontinued: true }).eq("id", id);
      if (error) {
        const name = targets.find((p) => p.id === id)?.name ?? id;
        failures.push(`${name}: ${error.message}`);
      }
    }
    setBulkProcessing(false);
    if (failures.length > 0) {
      alert(`${selectedIds.size - failures.length} discontinued, ${failures.length} failed:\n${failures.join("\n")}`);
    }
    setSelectedIds(new Set());
    setBulkAction("");
    fetchProducts();
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
        {/* Add Product is the everyday action and stays exposed; managing
            categories, exporting and bulk-importing are occasional, so they
            live behind the overflow menu rather than holding permanent space. */}
        <div className="flex gap-2 flex-wrap">
          <Button onClick={() => setShowForm(true)}>
            <Plus className="w-4 h-4 mr-2" /> Add Product
          </Button>
          <ActionMenu label="More product actions">
            {(close) => (
              <>
                <MenuItem icon={Tag} onClick={() => { close(); setShowCategories(true); }}>
                  Manage categories
                </MenuItem>
                <MenuItem icon={Upload} onClick={() => { close(); setShowCsv(true); }}>
                  CSV import
                </MenuItem>
                <MenuItem icon={Download} onClick={() => { close(); handleExport(); }}>
                  Export to CSV
                </MenuItem>
              </>
            )}
          </ActionMenu>
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

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 mb-4 bg-green-50 border border-green-200 rounded-lg px-4 py-3">
          <span className="text-sm font-medium text-green-800">{selectedIds.size} selected</span>
          <select
            value={bulkAction}
            onChange={(e) => setBulkAction(e.target.value as "" | "price" | "discontinue")}
            className="border border-gray-300 rounded px-2 py-1 text-sm"
          >
            <option value="">Bulk actions...</option>
            <option value="price">Adjust price %</option>
            <option value="discontinue">Discontinue</option>
          </select>
          {bulkAction === "price" && (
            <>
              <input
                type="number"
                value={bulkPricePercent}
                onChange={(e) => setBulkPricePercent(e.target.value)}
                placeholder="e.g. 10 or -5"
                className="border border-gray-300 rounded px-2 py-1 text-sm w-28"
              />
              <span className="text-xs text-gray-500">%</span>
              <Button size="sm" onClick={handleBulkPriceUpdate} disabled={bulkProcessing || !bulkPricePercent}>
                Apply
              </Button>
            </>
          )}
          {bulkAction === "discontinue" && (
            <Button size="sm" variant="danger" onClick={handleBulkDiscontinue} disabled={bulkProcessing}>
              Discontinue
            </Button>
          )}
          <button onClick={() => { setSelectedIds(new Set()); setBulkAction(""); }} className="ml-auto text-xs text-gray-500 hover:underline">
            Clear selection
          </button>
        </div>
      )}

      {/* Product table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-3 py-3 w-10">
                  <input
                    type="checkbox"
                    checked={products.length > 0 && selectedIds.size === products.length}
                    onChange={toggleSelectAll}
                    className="rounded border-gray-300"
                  />
                </th>
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
                <tr><td colSpan={9} className="px-4 py-12 text-center text-gray-400">Loading...</td></tr>
              ) : products.length === 0 ? (
                <tr><td colSpan={9} className="px-4 py-12 text-center text-gray-400">No products found</td></tr>
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
                    <tr key={p.id} className={`group hover:bg-gray-50 ${selectedIds.has(p.id) ? "bg-green-50" : ""}`}>
                      <td className="px-3 py-3">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(p.id)}
                          onChange={() => toggleSelect(p.id)}
                          className="rounded border-gray-300"
                        />
                      </td>
                      <td className="px-4 py-3 text-gray-500 font-mono text-xs">{p.inventory_id}</td>
                      <td className="px-4 py-3 font-medium text-gray-900 max-w-[18rem]">
                        <div className="flex items-center gap-2">
                          <TruncatedText>{p.name}</TruncatedText>
                          {p.is_prepared && <Badge variant="gray">Prepared</Badge>}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {p.category ? <Badge variant="gray">{p.category}</Badge> : <span className="text-gray-400">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-600 tabular-nums">
                        {p.cost_per_unit ? formatZAR(p.cost_per_unit) : "—"}
                      </td>
                      <td className="px-4 py-3 text-right font-medium tabular-nums">{formatZAR(p.selling_price)}</td>
                      {/* Only a margin that needs attention gets colour. A green
                          chip on every healthy product made the column decorative
                          — the thin margins no longer stood out. */}
                      <td className="px-4 py-3 text-right tabular-nums">
                        {margin === null ? (
                          <span className="text-gray-400">—</span>
                        ) : margin < 10 ? (
                          <Badge variant="red">{margin.toFixed(1)}%</Badge>
                        ) : (
                          <span className="text-gray-600">{margin.toFixed(1)}%</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        <span className={lowStock ? "text-red-600 font-semibold" : ""}>
                          {displayStock}
                        </span>
                      </td>
                      {/* Row actions are revealed on hover/focus-within: at ~1,400
                          SKUs a permanent Edit/Remove pair on every row is louder
                          than the data. Kept focusable for keyboard users. */}
                      <td className="px-4 py-3 text-right">
                        <div className="inline-flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                          <Tooltip label="Edit product">
                            <button
                              onClick={() => handleEdit(p)}
                              aria-label={`Edit ${p.name}`}
                              className="rounded p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900"
                            >
                              <Pencil className="w-4 h-4" />
                            </button>
                          </Tooltip>
                          <Tooltip label="Discontinue product">
                            <button
                              onClick={() => handleDiscontinue(p)}
                              aria-label={`Discontinue ${p.name}`}
                              className="rounded p-1.5 text-gray-500 hover:bg-red-50 hover:text-red-700"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </Tooltip>
                        </div>
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

      {/* Manage categories modal */}
      <ManageCategoriesModal
        open={showCategories}
        onClose={() => setShowCategories(false)}
        onChanged={async () => {
          await fetchProducts();
          // Reload the categories list too — paginated so categories that
          // appear only on products beyond row 1000 still show up.
          const [{ data: catRows }, prodCats] = await Promise.all([
            db.from("categories").select("name").eq("active", true).order("sort_order"),
            fetchAllPaged<{ category: string | null }>(() =>
              db.from("products").select("category").eq("discontinued", false)
            ),
          ]);
          const ordered = ((catRows as { name: string }[]) || []).map((c) => c.name);
          const fromProducts = new Set<string>();
          prodCats.forEach((r) => {
            const c = (r.category || "").trim();
            if (c) fromProducts.add(c);
          });
          const known = new Set(ordered);
          const leftovers = [...fromProducts]
            .filter((c) => !known.has(c))
            .sort((a, b) => a.localeCompare(b));
          setCategories([...ordered, ...leftovers]);
        }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Categories management modal — each operator defines their own taxonomy.
// Lets them: see every category currently in use (whether in the categories
// table or only on products), add new ones, rename existing ones (which
// updates every affected product), and discontinue ones with no products
// attached.
// ─────────────────────────────────────────────────────────────────────────

function ManageCategoriesModal({
  open, onClose, onChanged,
}: {
  open: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [rows, setRows] = useState<{ name: string; count: number; inTable: boolean }[]>([]);
  const [loading, setLoading] = useState(true);
  const [newCategory, setNewCategory] = useState("");
  const [adding, setAdding] = useState(false);
  const [renameFrom, setRenameFrom] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const [{ data: catRows }, prodCats] = await Promise.all([
      db.from("categories").select("name").eq("active", true).order("sort_order"),
      fetchAllPaged<{ category: string | null }>(() =>
        db.from("products").select("category").eq("discontinued", false)
      ),
    ]);
    const tableNames = new Set<string>(((catRows as { name: string }[]) || []).map((c) => c.name));
    const counts = new Map<string, number>();
    prodCats.forEach((r) => {
      const c = (r.category || "").trim();
      if (c) counts.set(c, (counts.get(c) || 0) + 1);
    });
    const all = new Set<string>([...tableNames, ...counts.keys()]);
    const list = [...all]
      .map((name) => ({
        name,
        count: counts.get(name) || 0,
        inTable: tableNames.has(name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    setRows(list);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (open) {
      refresh();
      setNewCategory("");
      setRenameFrom(null);
      setRenameTo("");
      setMsg(null);
    }
  }, [open, refresh]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const name = newCategory.trim();
    if (!name) return;
    setAdding(true);
    setMsg(null);
    const { error } = await db.from("categories").insert({ name, sort_order: rows.length, active: true });
    setAdding(false);
    if (error) {
      setMsg(`Could not add: ${error.message}`);
      return;
    }
    setNewCategory("");
    await refresh();
    await onChanged();
  }

  async function handleRename(originalName: string) {
    const next = renameTo.trim();
    if (!next || next === originalName) {
      setRenameFrom(null);
      return;
    }
    setBusy(originalName);
    setMsg(null);
    // Rename the categories-table row if it exists
    const tableUpdate = await db.from("categories").update({ name: next }).eq("name", originalName);
    // Rename every product currently tagged with the old name
    const productsUpdate = await db.from("products").update({ category: next }).eq("category", originalName);
    setBusy(null);
    if (tableUpdate.error && tableUpdate.error.code !== "23505") {
      setMsg(`Rename failed on categories table: ${tableUpdate.error.message}`);
      return;
    }
    if (productsUpdate.error) {
      setMsg(`Products were not fully renamed: ${productsUpdate.error.message}`);
      return;
    }
    setRenameFrom(null);
    setRenameTo("");
    await refresh();
    await onChanged();
  }

  async function handleDiscontinue(name: string, count: number) {
    if (count > 0) {
      alert(`Cannot discontinue "${name}" — ${count} product${count !== 1 ? "s" : ""} still use it. Rename the category instead, or re-categorise those products first.`);
      return;
    }
    if (!confirm(`Remove "${name}" from your category list?`)) return;
    setBusy(name);
    await db.from("categories").update({ active: false }).eq("name", name);
    setBusy(null);
    await refresh();
    await onChanged();
  }

  return (
    <Modal open={open} onClose={onClose} title="Manage Categories" wide>
      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          Define what categories make sense for your business. Add new ones, rename existing ones (every product
          with that category updates automatically), or remove categories you don&apos;t use any more.
        </p>

        {/* Add */}
        <form onSubmit={handleAdd} className="flex gap-2">
          <input
            type="text"
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            placeholder="New category name (e.g. Cream & Dairy)"
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
          />
          <Button type="submit" loading={adding}>
            <Plus className="w-4 h-4 mr-1" /> Add
          </Button>
        </form>

        {msg && (
          <div className="bg-amber-50 border border-amber-200 text-amber-900 px-3 py-2 rounded-lg text-sm">{msg}</div>
        )}

        {/* List */}
        <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-96 overflow-y-auto">
          {loading ? (
            <div className="px-4 py-6 text-center text-sm text-gray-400">Loading...</div>
          ) : rows.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-gray-400">No categories yet — add your first one above.</div>
          ) : (
            rows.map((r) => (
              <div key={r.name} className="group px-4 py-3 flex items-center justify-between gap-3">
                {renameFrom === r.name ? (
                  <>
                    <input
                      type="text"
                      value={renameTo}
                      autoFocus
                      onChange={(e) => setRenameTo(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleRename(r.name);
                        if (e.key === "Escape") setRenameFrom(null);
                      }}
                      className="flex-1 border border-green-400 rounded-lg px-3 py-1.5 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
                    />
                    <button type="button" onClick={() => handleRename(r.name)} className="text-sm text-green-700 hover:underline">Save</button>
                    <button type="button" onClick={() => setRenameFrom(null)} className="text-sm text-gray-500 hover:underline">Cancel</button>
                  </>
                ) : (
                  <>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{r.name}</p>
                      <p className="text-xs text-gray-500">
                        {r.count} product{r.count !== 1 ? "s" : ""}
                        {!r.inTable && " · only on products (not in your formal list)"}
                      </p>
                    </div>
                    {/* Revealed on hover/focus — the list is for reading your
                        taxonomy; renaming and removing are the rare cases. */}
                    <div className="inline-flex shrink-0 gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                      <Tooltip label="Rename category">
                        <button
                          type="button"
                          onClick={() => { setRenameFrom(r.name); setRenameTo(r.name); }}
                          disabled={busy === r.name}
                          aria-label={`Rename ${r.name}`}
                          className="rounded p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900 disabled:opacity-50"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                      </Tooltip>
                      <Tooltip label={r.count > 0 ? `In use by ${r.count} product${r.count !== 1 ? "s" : ""}` : "Remove category"}>
                        <button
                          type="button"
                          onClick={() => handleDiscontinue(r.name, r.count)}
                          disabled={busy === r.name}
                          aria-label={`Remove ${r.name}`}
                          className="rounded p-1.5 text-gray-500 hover:bg-red-50 hover:text-red-700 disabled:opacity-50"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </Tooltip>
                    </div>
                  </>
                )}
              </div>
            ))
          )}
        </div>

        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose}>Done</Button>
        </div>
      </div>
    </Modal>
  );
}
