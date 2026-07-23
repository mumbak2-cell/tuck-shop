"use client";
// Bill of materials for a prepared item. Feeds the recipe cost that migration
// 055 stores on the product and that COGS ultimately reads, so the preview
// here deliberately mirrors the SQL: incomplete inputs show no number at all
// rather than a plausible one that happens to be wrong.
import { useEffect, useState } from "react";
import { db } from "@/lib/supabase";
import { Ingredient } from "@/types/database";
import { formatZAR } from "@/lib/format";
import { Plus, Trash2, AlertTriangle } from "lucide-react";

export interface RecipeLine {
  ingredientId: string;
  quantity: string;
  /** The ingredient's unit at the time of editing — recipes.unit is NOT NULL,
   *  and storing it keeps a saved recipe readable if the ingredient changes. */
  unit: string;
}

/** Cost of one batch, or null when any line is missing a usable input. */
export function batchCost(lines: RecipeLine[], ingredients: Ingredient[]): number | null {
  const usable = lines.filter((l) => l.ingredientId && l.quantity.trim() !== "");
  if (usable.length === 0) return null;
  let total = 0;
  for (const line of usable) {
    const ing = ingredients.find((i) => i.id === line.ingredientId);
    if (!ing || !ing.purchase_qty || ing.purchase_qty <= 0) return null;
    const qty = parseFloat(line.quantity);
    if (!Number.isFinite(qty)) return null;
    total += qty * (ing.purchase_price / ing.purchase_qty);
  }
  return total;
}

export function RecipeEditor({
  lines,
  onChange,
  unitsPerBatch,
}: {
  lines: RecipeLine[];
  onChange: (lines: RecipeLine[]) => void;
  unitsPerBatch: string;
}) {
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    db.from("ingredients")
      .select("*")
      .order("name")
      .then(({ data }: { data: Ingredient[] | null }) => {
        setIngredients(data || []);
        setLoaded(true);
      });
  }, []);

  function updateLine(index: number, patch: Partial<RecipeLine>) {
    onChange(lines.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function addLine() {
    onChange([...lines, { ingredientId: "", quantity: "", unit: "" }]);
  }

  function removeLine(index: number) {
    onChange(lines.filter((_, i) => i !== index));
  }

  const cost = batchCost(lines, ingredients);
  const units = parseInt(unitsPerBatch);
  const perUnit = cost != null && Number.isFinite(units) && units > 0 ? cost / units : null;

  // Ingredients chosen here that cannot be costed — the single most likely
  // reason a recipe silently produces no cost.
  const unpriced = lines
    .filter((l) => l.ingredientId)
    .map((l) => ingredients.find((i) => i.id === l.ingredientId))
    .filter((i): i is Ingredient => !!i && (!i.purchase_qty || i.purchase_qty <= 0));

  if (!loaded) {
    return <p className="text-sm text-gray-400">Loading ingredients…</p>;
  }

  if (ingredients.length === 0) {
    return (
      <p className="text-sm text-gray-500">
        No ingredients yet. Add them under Ingredients first, then come back to build the recipe.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {lines.length === 0 && (
        <p className="text-sm text-gray-500">
          No ingredients in this recipe yet. Until one batch is described, this item sells at zero
          cost and shows no profit.
        </p>
      )}

      {lines.map((line, i) => {
        const ing = ingredients.find((x) => x.id === line.ingredientId);
        const lineCost =
          ing && ing.purchase_qty && ing.purchase_qty > 0 && line.quantity.trim() !== ""
            ? parseFloat(line.quantity) * (ing.purchase_price / ing.purchase_qty)
            : null;
        return (
          <div key={i} className="flex items-end gap-2">
            <div className="flex-1 min-w-0">
              <select
                value={line.ingredientId}
                onChange={(e) =>
                  updateLine(i, {
                    ingredientId: e.target.value,
                    unit: ingredients.find((x) => x.id === e.target.value)?.unit ?? "",
                  })
                }
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
              >
                <option value="">Choose ingredient…</option>
                {ingredients.map((ig) => (
                  <option key={ig.id} value={ig.id}>{ig.name}</option>
                ))}
              </select>
            </div>
            <div className="w-28">
              <input
                type="number"
                step="0.0001"
                min="0"
                value={line.quantity}
                onChange={(e) => updateLine(i, { quantity: e.target.value })}
                placeholder="Qty"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
              />
            </div>
            <div className="w-24 text-right text-xs text-gray-500 pb-2.5 truncate">
              {ing ? (lineCost != null ? formatZAR(lineCost) : ing.unit) : ""}
            </div>
            <button
              type="button"
              onClick={() => removeLine(i)}
              aria-label="Remove ingredient"
              className="p-2 text-gray-400 hover:text-red-600"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        );
      })}

      <button
        type="button"
        onClick={addLine}
        className="inline-flex items-center gap-1 text-sm text-green-700 hover:text-green-800 font-medium"
      >
        <Plus className="w-4 h-4" /> Add ingredient
      </button>

      {unpriced.length > 0 && (
        <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
          <p className="text-xs text-amber-800">
            No pack quantity set for {unpriced.map((i) => i.name).join(", ")}. Until that is filled
            in under Ingredients, this recipe cannot be costed and the item keeps selling at zero
            cost.
          </p>
        </div>
      )}

      {(cost != null || perUnit != null) && (
        <div className="bg-gray-50 rounded-lg px-4 py-3 space-y-1">
          <div className="flex justify-between text-sm">
            <span className="text-gray-600">Cost per batch</span>
            <span className="font-medium text-gray-900">{cost != null ? formatZAR(cost) : "—"}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-600">Cost per unit</span>
            <span className="font-semibold text-gray-900">
              {perUnit != null ? formatZAR(perUnit) : "set batch yield"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
