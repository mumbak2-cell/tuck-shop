"use client";
import { useState, useEffect } from "react";
import { db } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Settings, Save, Key, Link, Building2, Coins, Warehouse, Boxes } from "lucide-react";
import { useOrg } from "@/lib/org-context";
import { SADC_CURRENCIES, DEFAULT_CURRENCY, type CurrencyCode } from "@/lib/currency";
import { setActiveCurrency } from "@/lib/format";
import { CURRENCY_CACHE_KEY } from "@/lib/currency-context";
import { DailyDigestSection } from "@/components/settings/daily-digest-section";

export default function SettingsPage() {
  const [adminPin, setAdminPin] = useState("");
  const [cashierPin, setCashierPin] = useState("");
  const [ikhokhaLink, setIkhokhaLink] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [businessPhone, setBusinessPhone] = useState("");
  const [currency, setCurrency] = useState<CurrencyCode>(DEFAULT_CURRENCY.code);
  const [wmsEnabled, setWmsEnabled] = useState(false);
  const [wmsOnly, setWmsOnly] = useState(false);
  const [stockMode, setStockMode] = useState<"per_location" | "central">("per_location");
  const { locations, refresh: refreshOrg } = useOrg();
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadSettings();
  }, []);

  async function loadSettings() {
    const { data } = await db.from("app_settings").select("*");
    const map: Record<string, string> = {};
    ((data || []) as any[]).forEach((row: any) => (map[row.key] = row.value));

    setAdminPin(map.admin_pin || "1234");
    setCashierPin(map.cashier_pin || "0000");
    setIkhokhaLink(map.ikhokha_link || "");
    setBusinessName(map.business_name || "My Shop");
    setBusinessPhone(map.business_phone || "");
    setCurrency((map.currency as CurrencyCode) || DEFAULT_CURRENCY.code);
    setWmsEnabled(map.wms_enabled === "true");
    setWmsOnly(map.wms_only === "true");
    setStockMode(map.stock_mode === "central" ? "central" : "per_location");
    setLoading(false);
  }

  async function handleSave() {
    setSaving(true);
    setSuccess(false);

    const settings = [
      { key: "admin_pin", value: adminPin || "1234" },
      { key: "cashier_pin", value: cashierPin || "0000" },
      { key: "ikhokha_link", value: ikhokhaLink },
      { key: "business_name", value: businessName || "My Shop" },
      { key: "business_phone", value: businessPhone },
      { key: "currency", value: currency || DEFAULT_CURRENCY.code },
      { key: "wms_enabled", value: wmsEnabled ? "true" : "false" },
      { key: "wms_only", value: wmsOnly ? "true" : "false" },
      { key: "stock_mode", value: stockMode },
    ];

    for (const s of settings) {
      await db
        .from("app_settings")
        .upsert({ key: s.key, value: s.value, updated_at: new Date().toISOString() }, { onConflict: "key" });
    }

    // Apply the currency immediately so the rest of the UI reflects it without a reload.
    setActiveCurrency(currency);
    try {
      window.localStorage.setItem(CURRENCY_CACHE_KEY, currency);
    } catch {
      // ignore
    }

    setSuccess(true);
    setSaving(false);
    setTimeout(() => setSuccess(false), 3000);
    // Refresh OrgContext so stockMode/etc are immediately visible to other tabs.
    refreshOrg();
  }

  if (loading) {
    return <div className="text-center py-12 text-gray-400">Loading...</div>;
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <Settings className="w-7 h-7 text-green-600" />
          Settings
        </h1>
        <p className="text-sm text-gray-500 mt-1">Manage PINs, payment links, and business details</p>
      </div>

      <div className="space-y-6">
        {/* Business Details */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2 mb-4">
            <Building2 className="w-5 h-5 text-gray-600" />
            Business Details
          </h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Business Name</label>
              <input
                type="text"
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Business Phone</label>
              <input
                type="text"
                value={businessPhone}
                onChange={(e) => setBusinessPhone(e.target.value)}
                placeholder="e.g. 012 345 6789"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
              />
            </div>
          </div>
        </div>

        {/* Currency */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2 mb-4">
            <Coins className="w-5 h-5 text-gray-600" />
            Currency
          </h2>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Display currency</label>
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value as CurrencyCode)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
            >
              {SADC_CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.country} — {c.symbol} ({c.code}, {c.name})
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-1">
              Symbol shown before every amount in the app, on receipts, statements and exports.
              Changes apply immediately after Save.
            </p>
          </div>
        </div>

        {/* Access PINs */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2 mb-4">
            <Key className="w-5 h-5 text-gray-600" />
            Access PINs
          </h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Admin PIN</label>
              <input
                type="text"
                value={adminPin}
                onChange={(e) => setAdminPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="4-6 digit PIN"
                maxLength={6}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono tracking-widest focus:border-green-500 focus:ring-1 focus:ring-green-500"
              />
              <p className="text-xs text-gray-500 mt-1">Full access: products, prices, reports, settings, expenses</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Cashier PIN</label>
              <input
                type="text"
                value={cashierPin}
                onChange={(e) => setCashierPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="4-6 digit PIN"
                maxLength={6}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono tracking-widest focus:border-green-500 focus:ring-1 focus:ring-green-500"
              />
              <p className="text-xs text-gray-500 mt-1">Limited access: POS, stock count, daily sales only</p>
            </div>
          </div>
        </div>

        {/* Online Payment Link (generic) */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2 mb-4">
            <Link className="w-5 h-5 text-gray-600" />
            Online Payment Link
          </h2>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Payment Link URL (optional)
            </label>
            <input
              type="url"
              value={ikhokhaLink}
              onChange={(e) => setIkhokhaLink(e.target.value)}
              placeholder="https://..."
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
            />
            <p className="text-xs text-gray-500 mt-1">
              Any URL where credit customers can pay you online — iKhokha, Yoco, Flutterwave, a bank
              transfer page, a mobile money request link, or your own payment portal. It will be attached
              to every WhatsApp credit invoice and statement you send. Leave blank if you do not have one.
            </p>
          </div>
        </div>

        {/* Stock Mode — always visible so single-shop orgs can pre-pick before adding a second location */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2 mb-4">
              <Boxes className="w-5 h-5 text-gray-600" />
              Stock Mode
              {locations.length <= 1 && (
                <span className="text-xs font-normal text-gray-400 ml-1">(takes effect when you add a second shop)</span>
              )}
            </h2>
            <p className="text-sm text-gray-500 mb-4">
              How stock is shared across your shops. Default: each shop holds its own stock — sales decrement the shop where the sale happened, and stock counts only show that shop&apos;s products.
            </p>
            <div className="space-y-3">
              <label className="flex items-start gap-3 cursor-pointer p-3 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
                <input
                  type="radio"
                  name="stockMode"
                  checked={stockMode === "per_location"}
                  onChange={() => setStockMode("per_location")}
                  className="mt-1 w-4 h-4 text-green-600 border-gray-300 focus:ring-green-500"
                />
                <div>
                  <p className="text-sm font-medium text-gray-900">Per-location stock <span className="text-xs text-gray-500 font-normal">(default)</span></p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Each shop owns its own inventory. Best for independent retail shops with separate
                    physical stock at each location. Counts, sales and adjustments stay scoped to one shop.
                  </p>
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
                  <p className="text-sm font-medium text-gray-900">Central stock</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    All shops draw from one shared inventory pool (McDonald&apos;s pattern). Pick this when
                    you replenish from a central warehouse and the &quot;location&quot; is really just a till.
                    Counts and adjustments are still done per shop, but reporting treats the pool as one.
                  </p>
                </div>
              </label>
            </div>
          </div>

        {/* Warehouse Management */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2 mb-4">
            <Warehouse className="w-5 h-5 text-gray-600" />
            Warehouse Management (WMS)
          </h2>
          <div className="space-y-4">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={wmsEnabled}
                onChange={(e) => {
                  setWmsEnabled(e.target.checked);
                  if (!e.target.checked) setWmsOnly(false);
                }}
                className="w-4 h-4 text-green-600 border-gray-300 rounded focus:ring-green-500"
              />
              <div>
                <p className="text-sm font-medium text-gray-700">Enable Warehouse Module</p>
                <p className="text-xs text-gray-500">Adds Warehouse Stock, Receive, and Dispatch to the sidebar</p>
              </div>
            </label>
            {wmsEnabled && (
              <label className="flex items-center gap-3 cursor-pointer ml-7">
                <input
                  type="checkbox"
                  checked={wmsOnly}
                  onChange={(e) => setWmsOnly(e.target.checked)}
                  className="w-4 h-4 text-green-600 border-gray-300 rounded focus:ring-green-500"
                />
                <div>
                  <p className="text-sm font-medium text-gray-700">WMS-Only Mode</p>
                  <p className="text-xs text-gray-500">Hides POS, Shift, and retail stock views. Use when this account is a warehouse only.</p>
                </div>
              </label>
            )}
          </div>
        </div>

        {/* Daily Email Digest - self-contained section reading from report_subscriptions */}
        <DailyDigestSection />

        {/* Save */}
        <div className="flex items-center gap-4">
          <Button onClick={handleSave} loading={saving}>
            <Save className="w-4 h-4 mr-2" />
            Save Settings
          </Button>
          {success && (
            <span className="text-sm text-green-600 font-medium">Settings saved successfully.</span>
          )}
        </div>
      </div>
    </div>
  );
}
