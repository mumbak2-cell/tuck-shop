"use client";
import { useState } from "react";
import { db } from "@/lib/supabase";
import { Product, CATEGORIES } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

interface Props {
  product?: Product | null;
  onSaved: () => void;
  onCancel: () => void;
}

export function ProductForm({ product, onSaved, onCancel }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [form, setForm] = useState({
    inventory_id: product?.inventory_id || "",
    name: product?.name || "",
    category: product?.category || "",
    package_price: product?.package_price?.toString() || "",
    qty_in_pack: product?.qty_in_pack?.toString() || "",
    selling_price: product?.selling_price?.toString() || "",
    is_prepared: product?.is_prepared || false,
    opening_stock: product?.opening_stock?.toString() || "0",
    reorder_level: product?.reorder_level?.toString() || "0",
  });

  function update(field: string, value: string | boolean) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const payload = {
      inventory_id: form.inventory_id.trim(),
      name: form.name.trim(),
      category: form.category,
      package_price: form.package_price ? parseFloat(form.package_price) : null,
      qty_in_pack: form.qty_in_pack ? parseInt(form.qty_in_pack) : null,
      selling_price: parseFloat(form.selling_price),
      is_prepared: form.is_prepared,
      opening_stock: parseInt(form.opening_stock) || 0,
      reorder_level: parseInt(form.reorder_level) || 0,
    };

    if (!payload.inventory_id || !payload.name || !payload.category || !payload.selling_price) {
      setError("Please fill in all required fields.");
      setLoading(false);
      return;
    }

    let result;
    if (product) {
      result = await db.from("products").update(payload).eq("id", product.id);
    } else {
      result = await db.from("products").insert(payload);
    }

    if (result.error) {
      setError(result.error.message);
      setLoading(false);
      return;
    }

    setLoading(false);
    onSaved();
  }

  const categoryOptions = CATEGORIES.map((c) => ({ value: c, label: c }));

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

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Input
          label="Inventory ID *"
          placeholder="e.g. IN0094"
          value={form.inventory_id}
          onChange={(e) => update("inventory_id", e.target.value)}
          disabled={!!product}
        />
        <Input
          label="Product Name *"
          placeholder="e.g. Chocolate Bar"
          value={form.name}
          onChange={(e) => update("name", e.target.value)}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Select
          label="Category *"
          options={categoryOptions}
          placeholder="Select category"
          value={form.category}
          onChange={(e) => update("category", e.target.value)}
        />
        <div className="flex items-end pb-1">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.is_prepared}
              onChange={(e) => update("is_prepared", e.target.checked)}
              className="rounded border-gray-300 text-green-600 focus:ring-green-500"
            />
            Prepared food item (has recipe)
          </label>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Input
          label="Package / Batch Price (R)"
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
          label="Selling Price (R) *"
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
          <span className="font-medium">R{costPerUnit.toFixed(2)}</span>
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

      <div className="flex justify-end gap-3 pt-4 border-t">
        <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button type="submit" loading={loading}>
          {product ? "Save Changes" : "Add Product"}
        </Button>
      </div>
    </form>
  );
}
