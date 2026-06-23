"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { db } from "@/lib/supabase";
import { useOrg } from "@/lib/org-context";
import { Button } from "@/components/ui/button";
import { SHOP_PRESETS } from "@/lib/shop-presets";
import {
  getPaymentPresetsForCurrency,
  type PaymentMethodPreset,
  type PaymentKind,
} from "@/lib/payment-presets";
import { DEFAULT_CURRENCY } from "@/lib/currency";
import { Store, Plus, X, CreditCard, Boxes } from "lucide-react";

export default function SetupPage() {
  const router = useRouter();
  const org = useOrg();
  const [shopType, setShopType] = useState<string>("");
  const [preparesFood, setPreparesFood] = useState<boolean>(false);
  const [inventoryPrefix, setInventoryPrefix] = useState<string>("ITEM");
  const [stockMode, setStockMode] = useState<"per_location" | "central">("per_location");
  const [categories, setCategories] = useState<string[]>([]);
  const [newCategory, setNewCategory] = useState("");
  // Payment methods - seeded from the org's currency (country)
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethodPreset[]>([]);
  const [newPaymentName, setNewPaymentName] = useState("");
  const [newPaymentKind, setNewPaymentKind] = useState<PaymentKind>("mobile_money");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the payment methods from the operator's currency once it loads.
  useEffect(() => {
    if (paymentMethods.length === 0) {
      // org.shopType is null at this stage; rely on currency which is set on sign-up.
      // Currency lives in localStorage too (CurrencyProvider cached it on signup).
      let currency: string = DEFAULT_CURRENCY.code;
      try {
        currency = window.localStorage.getItem("tilify_currency") || currency;
      } catch {
        // ignore
      }
      setPaymentMethods(getPaymentPresetsForCurrency(currency));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  function addPaymentMethod() {
    const name = newPaymentName.trim();
    if (!name) return;
    if (paymentMethods.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
      setNewPaymentName("");
      return;
    }
    setPaymentMethods([...paymentMethods, { name, kind: newPaymentKind }]);
    setNewPaymentName("");
  }

  function removePaymentMethod(idx: number) {
    setPaymentMethods(paymentMethods.filter((_, i) => i !== idx));
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
    if (paymentMethods.length === 0) {
      setError("Please keep at least one payment method.");
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

    // Save the org's payment method list.
    const { error: pmErr } = await db.from("payment_methods").insert(
      paymentMethods.map((m, i) => ({
        name: m.name,
        kind: m.kind,
        sort_order: i,
      }))
    );
    if (pmErr) {
      setError("Could not save payment methods: " + pmErr.message);
      setSaving(false);
      return;
    }

    // Save the settings via upsert
    const settings = [
      { key: "shop_type", value: shopType },
      { key: "prepares_food", value: preparesFood ? "true" : "false" },
      { key: "inventory_id_prefix", value: inventoryPrefix.toUpperCase().trim() },
      { key: "stock_mode", value: stockMode },
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

        {/* Stock mode (matters once a second shop is added; pick now so you don't have to think later) */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Boxes className="w-4 h-4 text-gray-500" />
            <label className="block text-sm font-medium text-gray-700">
              Stock model for multiple shops
            </label>
          </div>
          <p className="text-xs text-gray-500 mb-3">
            You can change this later in Settings. Most retailers keep separate stock per shop; pick
            central if you plan to share one inventory pool across all branches.
          </p>
          <div className="space-y-2">
            <label className="flex items-start gap-3 cursor-pointer p-3 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
              <input
                type="radio"
                name="stockMode"
                checked={stockMode === "per_location"}
                onChange={() => setStockMode("per_location")}
                className="mt-1 w-4 h-4 text-green-600 border-gray-300 focus:ring-green-500"
              />
              <div>
                <p className="text-sm font-medium text-gray-900">Per-location stock <span className="text-xs text-gray-500 font-normal">(recommended)</span></p>
                <p className="text-xs text-gray-500 mt-0.5">Each shop owns its inventory. Counts, sales and adjustments stay scoped to one shop.</p>
              </div>
            </label>
            <label className="flex items-start gap-3 cursor-pointer p-3 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
              <input
                type="radio"
                name="stockMode"
                checked={stockMode === "central"}
                onChange={() => setStockMode("central")}
                className="mt-1 w-4 h-4 text-green-600 border-gray-300 focus:ring-green-500"
              />
              <div>
                <p className="text-sm font-medium text-gray-900">Central stock <span className="text-xs text-gray-500 font-normal">(McDonald&apos;s pattern)</span></p>
                <p className="text-xs text-gray-500 mt-0.5">All shops draw from one shared inventory pool replenished from a central warehouse.</p>
              </div>
            </label>
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

        {/* Payment methods */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <CreditCard className="w-4 h-4 text-gray-500" />
            <label className="block text-sm font-medium text-gray-700">
              How do customers pay you?
            </label>
          </div>
          <p className="text-xs text-gray-500 mb-3">
            Suggested for your country based on your currency. Add, edit, or remove any of these
            before saving. Mobile money and cash are pre-selected for SADC markets.
          </p>
          <div className="flex flex-wrap gap-2 mb-3 min-h-[2.5rem]">
            {paymentMethods.length === 0 && (
              <span className="text-sm text-gray-400 italic py-1">
                Add at least one payment method below.
              </span>
            )}
            {paymentMethods.map((m, i) => (
              <span
                key={`${m.name}-${i}`}
                className="inline-flex items-center gap-1.5 px-3 py-1 bg-blue-50 border border-blue-200 rounded-full text-sm text-blue-900"
              >
                <span className="font-medium">{m.name}</span>
                <span className="text-xs text-blue-600 opacity-70">
                  {m.kind === "mobile_money" ? "mobile" : m.kind}
                </span>
                <button
                  type="button"
                  onClick={() => removePaymentMethod(i)}
                  className="text-blue-600 hover:text-red-600"
                  aria-label={`Remove ${m.name}`}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={newPaymentName}
              onChange={(e) => setNewPaymentName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addPaymentMethod();
                }
              }}
              placeholder="Payment method name"
              className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
            />
            <select
              value={newPaymentKind}
              onChange={(e) => setNewPaymentKind(e.target.value as PaymentKind)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
            >
              <option value="cash">Cash</option>
              <option value="card">Card</option>
              <option value="mobile_money">Mobile Money</option>
              <option value="eft">EFT</option>
              <option value="credit">Credit</option>
              <option value="other">Other</option>
            </select>
            <Button type="button" variant="secondary" onClick={addPaymentMethod}>
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
