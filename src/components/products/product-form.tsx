"use client";
import { useState, useEffect } from "react";
import { db } from "@/lib/supabase";
import { Product } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { formatMoney, getActiveSymbol } from "@/lib/format";
import { useOrg } from "@/lib/org-context";
import { RecipeEditor, RecipeLine } from "@/components/products/recipe-editor";
import { SupplierSelect } from "@/components/suppliers/supplier-select";

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
  const { preparesFood, currentLocationId, currentLocationName, orgId, locations } = useOrg();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [categories, setCategories] = useState<CategoryRow[]>([]);

  // Only multi-branch orgs get per-location price overrides; a single-shop
  // operator just uses the base selling price.
  const isMultiBranch = locations.length > 1;

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
    units_per_batch: product?.units_per_batch?.toString() || "",
    wholesale_enabled: product?.wholesale_enabled || false,
    wholesale_min_qty: product?.wholesale_min_qty?.toString() || "1",
    default_supplier: product?.default_supplier || "",
  });

  // Recipe lines for a prepared item. Held here rather than written directly so
  // a new product (which has no id until insert) can be saved in one go.
  const [recipeLines, setRecipeLines] = useState<RecipeLine[]>([]);

  // Per-branch price override inputs, keyed by location_id. Empty string =
  // "no override, use the base price". Loaded from existing rows when editing.
  const [branchPrices, setBranchPrices] = useState<Record<string, string>>({});

  // Existing recipe for a prepared item being edited.
  useEffect(() => {
    if (!product?.id) return;
    (async () => {
      const { data } = await db
        .from("recipes")
        .select("ingredient_id, quantity_per_batch, unit")
        .eq("product_id", product.id);
      setRecipeLines(
        ((data as { ingredient_id: string; quantity_per_batch: number; unit: string }[]) || []).map((r) => ({
          ingredientId: r.ingredient_id,
          quantity: r.quantity_per_batch.toString(),
          unit: r.unit || "",
        }))
      );
    })();
  }, [product?.id]);

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

  // When editing a multi-branch product, preload its existing price overrides.
  useEffect(() => {
    if (!product || !isMultiBranch) return;
    (async () => {
      const { data } = await db
        .from("product_location_prices")
        .select("location_id, selling_price")
        .eq("product_id", product.id);
      const next: Record<string, string> = {};
      (data as { location_id: string; selling_price: number | string }[] | null)?.forEach((r) => {
        next[r.location_id] = String(Number(r.selling_price));
      });
      setBranchPrices(next);
    })();
  }, [product, isMultiBranch]);

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
      // Only meaningful for a prepared item; clearing the flag clears the yield
      // so a stale batch size can't keep costing a bought-in product.
      units_per_batch:
        form.is_prepared && form.units_per_batch ? parseInt(form.units_per_batch) : null,
      is_sellable: form.is_sellable,
      opening_stock: parseInt(form.opening_stock) || 0,
      reorder_level: parseInt(form.reorder_level) || 0,
      wholesale_enabled: form.wholesale_enabled,
      wholesale_min_qty: form.wholesale_enabled ? parseInt(form.wholesale_min_qty) || 1 : 1,
      default_supplier: form.default_supplier.trim() || null,
    };

    if (!payload.name || !payload.category || !payload.selling_price) {
      setError("Please fill in all required fields.");
      setLoading(false);
      return;
    }

    // Validate any branch-price overrides before writing the product, so a
    // typo doesn't leave the product saved but the prices half-applied.
    if (isMultiBranch) {
      for (const loc of locations) {
        const raw = (branchPrices[loc.id] ?? "").trim();
        if (raw === "") continue;
        const n = parseFloat(raw);
        if (!Number.isFinite(n) || n < 0) {
          setError(`Enter a valid price for ${loc.name}, or leave it blank to use the base price.`);
          setLoading(false);
          return;
        }
      }
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

    // Reconcile per-branch price overrides: a filled input upserts an override,
    // a blank one removes it (falling back to the base price). Failures here
    // don't undo the saved product; surface them but still close.
    if (isMultiBranch && targetProductId && orgId) {
      const base = parseFloat(form.selling_price);
      await Promise.all(
        locations.map((loc) => {
          const raw = (branchPrices[loc.id] ?? "").trim();
          if (raw === "") {
            return db
              .from("product_location_prices")
              .delete()
              .eq("product_id", targetProductId)
              .eq("location_id", loc.id);
          }
          const price = parseFloat(raw);
          // An override equal to the base price is redundant — drop it so the
          // list only ever holds genuine exceptions.
          if (price === base) {
            return db
              .from("product_location_prices")
              .delete()
              .eq("product_id", targetProductId)
              .eq("location_id", loc.id);
          }
          return db.from("product_location_prices").upsert(
            {
              product_id: targetProductId,
              location_id: loc.id,
              selling_price: price,
              org_id: orgId,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "product_id,location_id" }
          );
        })
      );
    }

    // Reconcile the recipe. Replace-in-full rather than diffing: a recipe is a
    // handful of rows, and the delete+insert keeps the stored cost consistent
    // with what was on screen. The migration-055 trigger recalculates the
    // product's cost from these rows, so nothing here writes a cost directly.
    if (targetProductId && form.is_prepared) {
      const validLines = recipeLines.filter(
        (l) => l.ingredientId && l.quantity.trim() !== "" && Number.isFinite(parseFloat(l.quantity))
      );
      await db.from("recipes").delete().eq("product_id", targetProductId);
      if (validLines.length > 0) {
        const { error: recipeErr } = await db.from("recipes").insert(
          validLines.map((l) => ({
            product_id: targetProductId,
            ingredient_id: l.ingredientId,
            quantity_per_batch: parseFloat(l.quantity),
            unit: l.unit || "",
          }))
        );
        if (recipeErr) {
          // The product saved; only the recipe failed. Say so rather than
          // closing silently and leaving the item costed at zero.
          setError("Product saved, but the recipe could not be saved: " + recipeErr.message);
          setLoading(false);
          return;
        }
      }
    } else if (targetProductId && product?.is_prepared && !form.is_prepared) {
      // No longer prepared — drop the recipe so it can't cost a bought-in item.
      await db.from("recipes").delete().eq("product_id", targetProductId);
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
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Supplier</label>
          <SupplierSelect
            value={form.default_supplier}
            onChange={(name) => update("default_supplier", name)}
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
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

      {/* Recipe — the cost source for a prepared item. Without it the POS
          records zero cost for every sale and the item shows infinite margin. */}
      {form.is_prepared && (
        <div className="rounded-lg border border-gray-200 p-4 space-y-3">
          <div>
            <p className="text-sm font-medium text-gray-900">Recipe</p>
            <p className="text-xs text-gray-500">
              What one batch uses. This is where a prepared item&apos;s cost comes from — without
              it the item sells at zero cost and its profit looks larger than it is.
            </p>
          </div>

          <Input
            label="Units this batch makes *"
            type="number"
            min="1"
            placeholder="e.g. 24"
            value={form.units_per_batch}
            onChange={(e) => update("units_per_batch", e.target.value)}
          />

          <RecipeEditor
            lines={recipeLines}
            onChange={setRecipeLines}
            unitsPerBatch={form.units_per_batch}
          />
        </div>
      )}

      {isMultiBranch && (
        <div className="rounded-lg border border-gray-200 p-4 space-y-3">
          <div>
            <p className="text-sm font-medium text-gray-900">Prices per branch (optional)</p>
            <p className="text-xs text-gray-500">
              Leave a branch blank to charge the base selling price
              {form.selling_price ? ` (${currencySymbol}${form.selling_price})` : ""}. Enter a value only
              where a branch sells this item for something different.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {locations.map((loc) => (
              <Input
                key={loc.id}
                label={loc.name}
                type="number"
                step="0.01"
                placeholder={form.selling_price || "base price"}
                value={branchPrices[loc.id] ?? ""}
                onChange={(e) =>
                  setBranchPrices((prev) => ({ ...prev, [loc.id]: e.target.value }))
                }
              />
            ))}
          </div>
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

      <div className="border-t pt-4 mt-4 space-y-4">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={form.wholesale_enabled}
            onChange={(e) => update("wholesale_enabled", e.target.checked)}
            className="h-4 w-4 text-blue-600 rounded border-gray-300"
          />
          <span className="text-sm font-medium text-gray-700">Enable wholesale pricing</span>
        </label>
        {form.wholesale_enabled && (
          <Input
            label="Minimum Qty for Wholesale"
            type="number"
            min={1}
            value={form.wholesale_min_qty}
            onChange={(e) => update("wholesale_min_qty", e.target.value)}
          />
        )}
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
