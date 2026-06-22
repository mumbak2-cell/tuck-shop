"use client";
import { useState, useEffect } from "react";
import { db } from "@/lib/supabase";
import { Product } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { formatMoney, getActiveSymbol } from "@/lib/format";
import { useOrg } from "@/lib/org-context";

interface Props {
  product?: Product | null;
  onSaved: () => void;
  onCancel: () => void;
}

interface CategoryRow {
  id: string;
  name: string;
  sort_order: number;
}

export function ProductForm({ product, onSaved, onCancel }: Props) {
  const { preparesFood, currentLocationId, currentLocationName } = useOrg();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [categories, setCategories] = useState<CategoryRow[]>([]);

  const [form, setForm] = useState({
    name: product?.name || "",
    category: product?.category || "",
    package_price: product?.package_price?.toString() || "",
    qty_in_pack: product?.qty_in_pack?.toString() || "",
    selling_price: product?.selling_price?.toString() || "",
    is_prepared: product?.is_prepared || false,
    is_sellable: (product as unknown as { is_sellable?: boolean })?.is_sellable !== false,
    opening_stock: product?.opening_stock?.toString() || "0",
    reorder_level: product?.reorder_level?.toString() || "0",
  });

  // Load categories from the org's categories table (RLS scopes automatically)
  useEffect(() => {
    (async () => {
      const { data } = await db
        .from("categories")
        .select("id, name, sort_order")
        .eq("active", true)
        .order("sort_order");
      setCategories((data as CategoryRow[]) || []);
    })();
  }, []);

  function update(field: string, value: string | boolean) {
    setForm((prev) => {
      const next = { ...prev, [field]: value };
      // Auto-uncheck sellable when category is Ingredients (legacy convention)
      if (field === "category" && value === "Ingredients") {
        next.is_sellable = false;
      }
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const payload: Record<string, unknown> = {
      name: form.name.trim(),
      category: form.category,
      package_price: form.package_price ? parseFloat(form.package_price) : null,
      qty_in_pack: form.qty_in_pack ? parseInt(form.qty_in_pack) : null,
      selling_price: parseFloat(form.selling_price),
      is_prepared: form.is_prepared,
      is_sellable: form.is_sellable,
      opening_stock: parseInt(form.opening_stock) || 0,
      reorder_level: parseInt(form.reorder_level) || 0,
    };

    if (!payload.name || !payload.category || !payload.selling_price) {
      setError("Please fill in all required fields.");
      setLoading(false);
      return;
    }

    let result;
    let newProductId: string | null = null;
    if (product) {
      result = await db.from("products").update(payload).eq("id", product.id);
    } else {
      // inventory_id is auto-generated server-side by the trigger.
      // We need the inserted row's id so we can also write the opening
      // stock into product_stock for the current location.
      result = await db.from("products").insert(payload).select("id").single();
      newProductId = result?.data?.id ?? null;
    }

    if (result.error) {
      setError(result.error.message);
      setLoading(false);
      return;
    }

    // Per-location stock: allocate the opening stock to the current location.
    // If product_stock RPC fails (migration 024 not run), the legacy
    // products.opening_stock value still recorded a sane number.
    const targetProductId = product ? product.id : newProductId;
    const openingStock = parseInt(form.opening_stock) || 0;
    if (targetProductId && currentLocationId && openingStock > 0 && !product) {
      // Only on CREATE: write the opening stock to the current location.
      // On UPDATE we leave product_stock alone - operator should use
      // Receive Stock to add more, or Stock Adjustments to correct.
      await db.rpc("add_product_stock_at_location", {
        p_product_id: targetProductId,
        p_quantity: openingStock,
        p_location_id: currentLocationId,
      });
    }

    setLoading(false);
    onSaved();
  }

  const categoryOptions = categories.map((c) => ({ value: c.name, label: c.name }));
  const currencySymbol = getActiveSymbol();

  // Computed cost and margin
  const costPerUnit =
    form.package_price && form.qty_in_pack
      ? parseFloat(form.package_price) / parseInt(form.qty_in_pack)
      : null;
  const margin =
    costPerUnit && form.selling_price
      ? ((parseFloat(form.selling_price) - costPerUnit) / parseFloat(form.selling_price)) * 100
      : null;

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>
      )}

      {product && (
        <div className="text-xs text-gray-500">
          Inventory ID:{" "}
          <span className="font-mono font-medium text-gray-700">{product.inventory_id}</span>
          <span className="ml-2 text-gray-400">(auto-generated)</span>
        </div>
      )}

      <Input
        label="Product Name *"
        placeholder="e.g. A4 Ream, Blue Pen, Chocolate Bar"
        value={form.name}
        onChange={(e) => update("name", e.target.value)}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Select
          label="Category *"
          options={categoryOptions}
          placeholder={categoryOptions.length === 0 ? "No categories - set up in Settings" : "Select category"}
          value={form.category}
          onChange={(e) => update("category", e.target.value)}
          disabled={categoryOptions.length === 0}
        />
        <div className="flex flex-col gap-2 justify-end pb-1">
          {preparesFood && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.is_prepared}
                onChange={(e) => update("is_prepared", e.target.checked)}
                className="rounded border-gray-300 text-green-600 focus:ring-green-500"
              />
              Prepared food item (has recipe)
            </label>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.is_sellable}
              onChange={(e) => update("is_sellable", e.target.checked)}
              className="rounded border-gray-300 text-green-600 focus:ring-green-500"
            />
            Sellable item (included in Revenue Assurance)
          </label>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Input
          label={`Package / Batch Price (${currencySymbol})`}
          type="number"
          step="0.01"
          placeholder="0.00"
          value={form.package_price}
          onChange={(e) => update("package_price", e.target.value)}
        />
        <Input
          label="Units per Package / Batch"
          type="number"
          placeholder="1"
          value={form.qty_in_pack}
          onChange={(e) => update("qty_in_pack", e.target.value)}
        />
        <Input
          label={`Selling Price (${currencySymbol}) *`}
          type="number"
          step="0.01"
          placeholder="0.00"
          value={form.selling_price}
          onChange={(e) => update("selling_price", e.target.value)}
        />
      </div>

      {/* Live cost / margin preview */}
      {costPerUnit !== null && margin !== null && (
        <div className="bg-gray-50 rounded-lg px-4 py-3 text-sm">
          <span className="text-gray-600">Cost per unit: </span>
          <span className="font-medium">{formatMoney(costPerUnit)}</span>
          <span className="mx-3 text-gray-300">|</span>
          <span className="text-gray-600">Margin: </span>
          <span className={`font-medium ${margin < 10 ? "text-red-600" : margin < 30 ? "text-amber-600" : "text-green-600"}`}>
            {margin.toFixed(1)}%
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Input
          label="Opening Stock"
          type="number"
          value={form.opening_stock}
          onChange={(e) => update("opening_stock", e.target.value)}
        />
        <Input
          label="Reorder Level"
          type="number"
          value={form.reorder_level}
          onChange={(e) => update("reorder_level", e.target.value)}
        />
      </div>
      {!product && currentLocationName && (
        <p className="text-xs text-gray-500 -mt-2">
          Opening stock will be allocated to <span className="font-medium text-gray-700">{currentLocationName}</span>.
          To stock this product at another location, switch in the sidebar and use Receive Stock.
        </p>
      )}

      <div className="flex justify-end gap-3 pt-4 border-t">
        <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button type="submit" loading={loading}>
          {product ? "Save Changes" : "Add Product"}
        </Button>
      </div>
    </form>
  );
}
