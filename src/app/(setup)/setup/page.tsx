"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { db } from "@/lib/supabase";
import { useOrg } from "@/lib/org-context";
import { Button } from "@/components/ui/button";
import { SHOP_PRESETS } from "@/lib/shop-presets";
import { Store, Plus, X } from "lucide-react";

export default function SetupPage() {
  const router = useRouter();
  const org = useOrg();
  const [shopType, setShopType] = useState<string>("");
  const [preparesFood, setPreparesFood] = useState<boolean>(false);
  const [inventoryPrefix, setInventoryPrefix] = useState<string>("ITEM");
  const [categories, setCategories] = useState<string[]>([]);
  const [newCategory, setNewCategory] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Redirect away if setup is already done or auth has not loaded
  useEffect(() => {
    if (!org.loading && org.setupCompleted) {
      router.replace("/dashboard");
    }
    if (!org.loading && !org.session) {
      router.replace("/login");
    }
  }, [org.loading, org.setupCompleted, org.session, router]);

  function applyPreset(typeName: string) {
    const preset = SHOP_PRESETS.find((p) => p.type === typeName);
    if (!preset) return;
    setShopType(preset.type);
    setInventoryPrefix(preset.inventoryPrefix);
    setPreparesFood(preset.preparesFood);
    setCategories(preset.categories);
  }

  function addCategory() {
    const name = newCategory.trim();
    if (!name) return;
    if (categories.some((c) => c.toLowerCase() === name.toLowerCase())) {
      setNewCategory("");
      return;
    }
    setCategories([...categories, name]);
    setNewCategory("");
  }

  function removeCategory(idx: number) {
    setCategories(categories.filter((_, i) => i !== idx));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!shopType) {
      setError("Please pick a shop type.");
      return;
    }
    if (!inventoryPrefix.trim() || inventoryPrefix.length > 6) {
      setError("Inventory ID prefix must be 1 to 6 characters.");
      return;
    }
    if (categories.length === 0) {
      setError("Please add at least one product category.");
      return;
    }

    setSaving(true);

    // Save the org's category list. Insert each row; org_id is auto-filled by DEFAULT.
    const { error: catErr } = await db.from("categories").insert(
      categories.map((name, i) => ({
        name,
        sort_order: i,
      }))
    );
    if (catErr) {
      setError("Could not save categories: " + catErr.message);
      setSaving(false);
      return;
    }

    // Save the settings via upsert
    const settings = [
      { key: "shop_type", value: shopType },
      { key: "prepares_food", value: preparesFood ? "true" : "false" },
      { key: "inventory_id_prefix", value: inventoryPrefix.toUpperCase().trim() },
      { key: "setup_completed", value: "true" },
    ];
    for (const s of settings) {
      const { error: setErr } = await db
        .from("app_settings")
        .upsert(
          { key: s.key, value: s.value, org_id: org.orgId, updated_at: new Date().toISOString() },
          { onConflict: "org_id,key" }
        );
      if (setErr) {
        setError("Could not save settings: " + setErr.message);
        setSaving(false);
        return;
      }
    }

    await org.refresh();
    router.push("/dashboard");
  }

  if (org.loading || (org.setupCompleted && org.session)) {
    return (
      <div className="text-center py-12 text-gray-400">Loading...</div>
    );
  }

  return (
    <div className="bg-white rounded-2xl shadow-xl p-8">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <Store className="w-8 h-8 text-green-600" />
          <h1 className="text-2xl font-bold text-gray-900">Set up your shop</h1>
        </div>
        <p className="text-sm text-gray-500">
          A few quick choices to tailor Tilify to {org.orgName ?? "your shop"}. You can change any of
          this later in Settings.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Shop type */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            What kind of shop is this?
          </label>
          <div className="grid grid-cols-2 gap-2">
            {SHOP_PRESETS.map((p) => (
              <button
                key={p.type}
                type="button"
                onClick={() => applyPreset(p.type)}
                className={`text-left px-3 py-2 border rounded-lg text-sm transition-colors ${
                  shopType === p.type
                    ? "border-green-600 bg-green-50 text-green-900 font-medium"
                    : "border-gray-300 hover:border-gray-400"
                }`}
              >
                {p.type}
              </button>
            ))}
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Picking a type fills in suggested categories below. Edit them freely before saving.
          </p>
        </div>

        {/* Prepares food */}
        <div>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={preparesFood}
              onChange={(e) => setPreparesFood(e.target.checked)}
              className="w-4 h-4 text-green-600 border-gray-300 rounded focus:ring-green-500"
            />
            <span className="text-sm text-gray-700">
              <span className="font-medium">We prepare food or cook items for sale</span>
              <span className="text-gray-500 block text-xs">
                Turns on Ingredients and Recipes for tracking raw materials. Leave off for pure retail.
              </span>
            </span>
          </label>
        </div>

        {/* Inventory ID prefix */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Inventory ID prefix
          </label>
          <div className="flex items-center gap-3">
            <input
              type="text"
              value={inventoryPrefix}
              onChange={(e) => setInventoryPrefix(e.target.value.toUpperCase().slice(0, 6))}
              className="w-32 border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:border-green-500 focus:ring-1 focus:ring-green-500"
              placeholder="STN"
            />
            <span className="text-sm text-gray-500">
              Inventory IDs will look like <span className="font-mono font-medium text-gray-700">{(inventoryPrefix || "ITEM").trim().toUpperCase()}0001</span>, auto-generated as you add products.
            </span>
          </div>
        </div>

        {/* Categories */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Product categories
          </label>
          <div className="flex flex-wrap gap-2 mb-3 min-h-[2.5rem]">
            {categories.length === 0 && (
              <span className="text-sm text-gray-400 italic py-1">
                Pick a shop type above or add categories below.
              </span>
            )}
            {categories.map((c, i) => (
              <span
                key={`${c}-${i}`}
                className="inline-flex items-center gap-1.5 px-3 py-1 bg-green-50 border border-green-200 rounded-full text-sm text-green-900"
              >
                {c}
                <button
                  type="button"
                  onClick={() => removeCategory(i)}
                  className="text-green-600 hover:text-red-600"
                  aria-label={`Remove ${c}`}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addCategory();
                }
              }}
              placeholder="Add a category"
              className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
            />
            <Button type="button" variant="secondary" onClick={addCategory}>
              <Plus className="w-4 h-4 mr-1" /> Add
            </Button>
          </div>
        </div>

        {error && (
          <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-3 pt-2">
          <Button type="submit" loading={saving}>
            Save and continue
          </Button>
        </div>
      </form>
    </div>
  );
}
