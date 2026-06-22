"use client";
import { useEffect, useState, useCallback } from "react";
import { db } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Badge } from "@/components/ui/badge";
import { WmsCsvUploadModal } from "@/components/wms/csv-catalog-upload";
import {
  Warehouse,
  Search,
  Plus,
  Edit2,
  AlertTriangle,
  Package,
  Filter,
  Upload,
} from "lucide-react";

interface WmsCatalogItem {
  id: number;
  sku: string;
  item_name: string;
  category: string | null;
  pack_size: number;
}

interface WmsInventoryRow {
  id: number;
  wms_item_id: number;
  physical_qty: number;
  reorder_level: number;
  reorder_qty: number;
  updated_at: string;
}

interface StockRow {
  catalog: WmsCatalogItem;
  inventory: WmsInventoryRow | null;
}

export default function WarehousePage() {
  const { role } = useAuth();
  const [rows, setRows] = useState<StockRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<WmsCatalogItem | null>(null);

  // Form state
  const [formSku, setFormSku] = useState("");
  const [formName, setFormName] = useState("");
  const [formCategory, setFormCategory] = useState("");
  const [formPackSize, setFormPackSize] = useState("1");
  const [formReorderLevel, setFormReorderLevel] = useState("10");
  const [formReorderQty, setFormReorderQty] = useState("50");
  const [showCsv, setShowCsv] = useState(false);
  const [saving, setSaving] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);

    const [{ data: catalog }, { data: inventory }] = await Promise.all([
      db.from("wms_catalog").select("*").order("item_name"),
      db.from("wms_inventory").select("*"),
    ]);

    const catalogItems: WmsCatalogItem[] = (catalog || []) as any[];
    const inventoryItems: WmsInventoryRow[] = (inventory || []) as any[];

    // Build inventory lookup
    const invMap = new Map<number, WmsInventoryRow>();
    inventoryItems.forEach((inv: any) => invMap.set(inv.wms_item_id, inv));

    // Extract unique categories
    const cats = new Set<string>();
    catalogItems.forEach((c: any) => {
      if (c.category) cats.add(c.category);
    });
    setCategories(Array.from(cats).sort());

    const combined: StockRow[] = catalogItems.map((c: any) => ({
      catalog: c,
      inventory: invMap.get(c.id) || null,
    }));

    setRows(combined);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  function openAddForm() {
    setEditing(null);
    setFormSku("");
    setFormName("");
    setFormCategory("");
    setFormPackSize("1");
    setFormReorderLevel("10");
    setFormReorderQty("50");
    setShowForm(true);
  }

  function openEditForm(item: WmsCatalogItem, inv: WmsInventoryRow | null) {
    setEditing(item);
    setFormSku(item.sku);
    setFormName(item.item_name);
    setFormCategory(item.category || "");
    setFormPackSize(String(item.pack_size));
    setFormReorderLevel(String(inv?.reorder_level ?? 10));
    setFormReorderQty(String(inv?.reorder_qty ?? 50));
    setShowForm(true);
  }

  async function handleSave() {
    if (!formSku.trim() || !formName.trim()) return;
    setSaving(true);

    try {
      if (editing) {
        // Update catalog
        await db
          .from("wms_catalog")
          .update({
            sku: formSku.trim(),
            item_name: formName.trim(),
            category: formCategory.trim() || null,
            pack_size: parseInt(formPackSize) || 1,
          })
          .eq("id", editing.id);

        // Update inventory thresholds
        await db
          .from("wms_inventory")
          .update({
            reorder_level: parseInt(formReorderLevel) || 10,
            reorder_qty: parseInt(formReorderQty) || 50,
          })
          .eq("wms_item_id", editing.id);
      } else {
        // Insert catalog item
        const { data: newItem, error: catErr } = await db
          .from("wms_catalog")
          .insert({
            sku: formSku.trim(),
            item_name: formName.trim(),
            category: formCategory.trim() || null,
            pack_size: parseInt(formPackSize) || 1,
          })
          .select("id")
          .single();

        if (catErr) throw catErr;

        // Create inventory row
        await db.from("wms_inventory").insert({
          wms_item_id: (newItem as any).id,
          physical_qty: 0,
          reorder_level: parseInt(formReorderLevel) || 10,
          reorder_qty: parseInt(formReorderQty) || 50,
        });
      }

      setShowForm(false);
      await fetchData();
    } catch (err: any) {
      console.error("Error saving WMS item:", err);
      alert(err.message || "Failed to save item");
    } finally {
      setSaving(false);
    }
  }

  // Filter rows
  const filtered = rows.filter((r: StockRow) => {
    const matchSearch =
      !search ||
      r.catalog.item_name.toLowerCase().includes(search.toLowerCase()) ||
      r.catalog.sku.toLowerCase().includes(search.toLowerCase());
    const matchCategory = !categoryFilter || r.catalog.category === categoryFilter;
    return matchSearch && matchCategory;
  });

  // Reorder alerts
  const alerts = rows.filter(
    (r: StockRow) =>
      r.inventory && r.inventory.physical_qty <= r.inventory.reorder_level
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Warehouse className="w-7 h-7 text-green-600" />
            Warehouse Stock
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {rows.length} items in catalog
          </p>
        </div>
        {role === "admin" && (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setShowCsv(true)}>
              <Upload className="w-4 h-4 mr-1" />
              CSV Import
            </Button>
            <Button onClick={openAddForm}>
              <Plus className="w-4 h-4 mr-1" />
              Add Item
            </Button>
          </div>
        )}
      </div>

      {/* Reorder Alerts */}
      {alerts.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-amber-800 flex items-center gap-2 mb-2">
            <AlertTriangle className="w-4 h-4" />
            Reorder Alerts ({alerts.length})
          </h2>
          <div className="flex flex-wrap gap-2">
            {alerts.map((r: StockRow) => (
              <Badge key={r.catalog.id} variant="amber">
                {r.catalog.item_name}: {r.inventory!.physical_qty} left
                (min {r.inventory!.reorder_level})
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* Search & Filter */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <Input
            placeholder="Search by name or SKU..."
            value={search}
            onChange={(e: any) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-gray-400" />
          <select
            value={categoryFilter}
            onChange={(e: any) => setCategoryFilter(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="">All Categories</option>
            {categories.map((c: string) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Stock Table */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading...</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12">
          <Package className="w-12 h-12 mx-auto text-gray-300 mb-3" />
          <p className="text-gray-500">
            {rows.length === 0
              ? "No items in warehouse catalog. Add your first item above."
              : "No items match your search."}
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="text-left px-4 py-3 font-medium text-gray-600">SKU</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Item Name</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Category</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Pack Size</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Qty on Hand</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Reorder Level</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Status</th>
                  {role === "admin" && (
                    <th className="text-center px-4 py-3 font-medium text-gray-600">Actions</th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map((r: StockRow) => {
                  const qty = r.inventory?.physical_qty ?? 0;
                  const reorder = r.inventory?.reorder_level ?? 10;
                  const isLow = qty <= reorder;
                  return (
                    <tr
                      key={r.catalog.id}
                      className={isLow ? "bg-amber-50/50" : "hover:bg-gray-50"}
                    >
                      <td className="px-4 py-3 font-mono text-xs text-gray-500">
                        {r.catalog.sku}
                      </td>
                      <td className="px-4 py-3 font-medium text-gray-900">
                        {r.catalog.item_name}
                      </td>
                      <td className="px-4 py-3 text-gray-500">
                        {r.catalog.category || "—"}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-500">
                        {r.catalog.pack_size}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold">
                        {qty}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-500">
                        {reorder}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {isLow ? (
                          <Badge variant="amber">Low Stock</Badge>
                        ) : (
                          <Badge variant="green">OK</Badge>
                        )}
                      </td>
                      {role === "admin" && (
                        <td className="px-4 py-3 text-center">
                          <button
                            onClick={() => openEditForm(r.catalog, r.inventory)}
                            className="text-gray-400 hover:text-green-600 transition-colors"
                          >
                            <Edit2 className="w-4 h-4" />
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add/Edit Modal */}
      <Modal open={showForm} onClose={() => setShowForm(false)} title={editing ? "Edit Warehouse Item" : "Add Warehouse Item"}>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">SKU</label>
            <Input
              value={formSku}
              onChange={(e: any) => setFormSku(e.target.value)}
              placeholder="e.g. CHIPS-LAY-36"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Item Name</label>
            <Input
              value={formName}
              onChange={(e: any) => setFormName(e.target.value)}
              placeholder="e.g. Lays Original 36-pack"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
            <Input
              value={formCategory}
              onChange={(e: any) => setFormCategory(e.target.value)}
              placeholder="e.g. Snacks"
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Pack Size</label>
              <Input
                type="number"
                min="1"
                value={formPackSize}
                onChange={(e: any) => setFormPackSize(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Reorder Level</label>
              <Input
                type="number"
                min="0"
                value={formReorderLevel}
                onChange={(e: any) => setFormReorderLevel(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Reorder Qty</label>
              <Input
                type="number"
                min="1"
                value={formReorderQty}
                onChange={(e: any) => setFormReorderQty(e.target.value)}
              />
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving || !formSku.trim() || !formName.trim()}>
              {saving ? "Saving..." : editing ? "Update" : "Add Item"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* CSV Import Modal */}
      <WmsCsvUploadModal
        open={showCsv}
        onClose={() => setShowCsv(false)}
        onComplete={fetchData}
      />
    </div>
  );
}
