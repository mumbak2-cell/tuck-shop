"use client";
import { useState, useEffect } from "react";
import { db } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Settings, Save, Key, Link, Building2, Coins, Warehouse, Boxes, CreditCard, Sparkles, Printer, ChefHat } from "lucide-react";
import { useOrg } from "@/lib/org-context";
import { SADC_CURRENCIES, DEFAULT_CURRENCY, type CurrencyCode } from "@/lib/currency";
import { setActiveCurrency } from "@/lib/format";
import { CURRENCY_CACHE_KEY } from "@/lib/currency-context";
import { DailyDigestSection } from "@/components/settings/daily-digest-section";
import { TeamSection } from "@/components/settings/team-section";
import { PaymentMethodsSection } from "@/components/settings/payment-methods-section";
import { VatSection } from "@/components/settings/vat-section";
import { PricingModal } from "@/components/billing/pricing-modal";
import { getPlan } from "@/lib/plans";

export default function SettingsPage() {
  const [adminPin, setAdminPin] = useState("");
  const [cashierPin, setCashierPin] = useState("");
  const [ikhokhaLink, setIkhokhaLink] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [businessPhone, setBusinessPhone] = useState("");
  const [currency, setCurrency] = useState<CurrencyCode>(DEFAULT_CURRENCY.code);
  const [wmsEnabled, setWmsEnabled] = useState(false);
  // Was previously only settable during first-time setup, which left any shop
  // that started without it unable to reach Ingredients, the "prepared item"
  // flag, or recipe costing at all — with no way to turn it on.
  const [preparesFood, setPreparesFood] = useState(false);
  const [wmsOnly, setWmsOnly] = useState(false);
  const [stockMode, setStockMode] = useState<"per_location" | "central">("per_location");
  // Per-branch receipts toggle (location_settings). Absence of a row = enabled.
  const [receiptsByLocation, setReceiptsByLocation] = useState<Record<string, boolean>>({});
  const {
    locations,
    orgId,
    currentLocationId,
    subscriptionPlan,
    subscriptionStatus,
    refresh: refreshOrg,
  } = useOrg();
  // PINs are per-location (location_settings). `pinLocationId` is the branch the
  // owner has explicitly picked to edit; until then we fall back to the active
  // location. Deriving (rather than syncing via an effect) avoids a cascading
  // render when the active location resolves.
  const [pinLocationId, setPinLocationId] = useState<string | null>(null);
  const effectivePinLocationId = pinLocationId ?? currentLocationId;
  const [showPricing, setShowPricing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadSettings();
  }, []);

  // Load the PINs for the branch being edited (and reload when it changes).
  useEffect(() => {
    if (effectivePinLocationId) loadPins(effectivePinLocationId);
  }, [effectivePinLocationId]);

  // Load the per-branch receipts toggle for every branch at once.
  useEffect(() => {
    if (locations.length === 0) return;
    db.from("location_settings")
      .select("location_id, value")
      .eq("key", "receipts_enabled")
      .then(({ data }: { data: { location_id: string; value: string }[] | null }) => {
        const map: Record<string, boolean> = {};
        locations.forEach((l) => (map[l.id] = true));
        (data || []).forEach((row) => {
          map[row.location_id] = row.value !== "false";
        });
        setReceiptsByLocation(map);
      });
  }, [locations]);

  async function loadSettings() {
    const { data } = await db.from("app_settings").select("*");
    const map: Record<string, string> = {};
    ((data || []) as any[]).forEach((row: any) => (map[row.key] = row.value));

    setIkhokhaLink(map.ikhokha_link || "");
    setBusinessName(map.business_name || "My Shop");
    setBusinessPhone(map.business_phone || "");
    setCurrency((map.currency as CurrencyCode) || DEFAULT_CURRENCY.code);
    setWmsEnabled(map.wms_enabled === "true");
    setWmsOnly(map.wms_only === "true");
    setPreparesFood(map.prepares_food === "true");
    setStockMode(map.stock_mode === "central" ? "central" : "per_location");
    setLoading(false);
  }

  // PINs come from location_settings (per branch), not app_settings.
  async function loadPins(locationId: string) {
    const { data } = await db
      .from("location_settings")
      .select("key, value")
      .eq("location_id", locationId)
      .in("key", ["admin_pin", "cashier_pin"]);
    const map: Record<string, string> = {};
    ((data || []) as { key: string; value: string }[]).forEach((row) => (map[row.key] = row.value));
    setAdminPin(map.admin_pin || "1234");
    setCashierPin(map.cashier_pin || "0000");
  }

  async function handleSave() {
    setSaving(true);
    setSuccess(false);

    // PINs are handled separately (location_settings) — everything else is
    // org-wide and lives in app_settings.
    const settings = [
      { key: "ikhokha_link", value: ikhokhaLink },
      { key: "business_name", value: businessName || "My Shop" },
      { key: "business_phone", value: businessPhone },
      { key: "currency", value: currency || DEFAULT_CURRENCY.code },
      { key: "wms_enabled", value: wmsEnabled ? "true" : "false" },
      { key: "wms_only", value: wmsOnly ? "true" : "false" },
      { key: "prepares_food", value: preparesFood ? "true" : "false" },
      { key: "stock_mode", value: stockMode },
    ];

    if (!orgId) {
      setSaving(false);
      alert("No organisation is loaded — cannot save settings.");
      return;
    }

    // app_settings is keyed by (org_id, key) and org_id has no column default,
    // so every row must carry org_id and the upsert must resolve on that pair.
    // (Resolving on "key" alone matches no unique constraint and errors.)
    const rows = settings.map((s) => ({
      org_id: orgId,
      key: s.key,
      value: s.value,
      updated_at: new Date().toISOString(),
    }));

    const { error } = await db
      .from("app_settings")
      .upsert(rows, { onConflict: "org_id,key" });

    if (error) {
      setSaving(false);
      alert("Failed to save settings: " + (error.message || "Unknown error"));
      return;
    }

    // PINs — per branch. location_settings is keyed UNIQUE(location_id, key).
    // Absence of the target location is only possible before the org has loaded.
    if (effectivePinLocationId) {
      const pinRows = [
        { org_id: orgId, location_id: effectivePinLocationId, key: "admin_pin", value: adminPin || "1234", updated_at: new Date().toISOString() },
        { org_id: orgId, location_id: effectivePinLocationId, key: "cashier_pin", value: cashierPin || "0000", updated_at: new Date().toISOString() },
      ];
      const { error: pinErr } = await db
        .from("location_settings")
        .upsert(pinRows, { onConflict: "location_id,key" });
      if (pinErr) {
        setSaving(false);
        alert("Failed to save PINs: " + (pinErr.message || "Unknown error"));
        return;
      }
    }

    // Receipts toggle — one row per branch, same keying as PINs.
    if (locations.length > 0) {
      const receiptRows = locations.map((l) => ({
        org_id: orgId,
        location_id: l.id,
        key: "receipts_enabled",
        value: (receiptsByLocation[l.id] ?? true) ? "true" : "false",
        updated_at: new Date().toISOString(),
      }));
      const { error: rcptErr } = await db
        .from("location_settings")
        .upsert(receiptRows, { onConflict: "location_id,key" });
      if (rcptErr) {
        setSaving(false);
        alert("Failed to save receipt settings: " + (rcptErr.message || "Unknown error"));
        return;
      }
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
        {/* Plan & Billing — always-available upgrade / change-plan entry point */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2 mb-4">
            <CreditCard className="w-5 h-5 text-gray-600" />
            Plan &amp; Billing
          </h2>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-sm text-gray-700">
                Current plan:{" "}
                <span className="font-semibold">
                  {(subscriptionPlan && getPlan(subscriptionPlan as "starter" | "growth" | "pro")?.name) || "Trial"}
                </span>
                {subscriptionStatus === "trialing" && (
                  <span className="text-gray-400 font-normal"> · on trial</span>
                )}
                {subscriptionStatus === "past_due" && (
                  <span className="text-amber-600 font-normal"> · payment overdue</span>
                )}
                {subscriptionStatus === "cancelled" && (
                  <span className="text-red-600 font-normal"> · cancelled</span>
                )}
              </p>
              <p className="text-xs text-gray-500 mt-1">
                Upgrade any time to unlock more locations, users and priority support.
              </p>
            </div>
            <Button onClick={() => setShowPricing(true)}>
              <Sparkles className="w-4 h-4 mr-2" />
              {subscriptionStatus === "active" ? "Change plan" : "Upgrade"}
            </Button>
          </div>
        </div>
        <PricingModal open={showPricing} onClose={() => setShowPricing(false)} />

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
            {locations.length > 1 && (
              <span className="text-xs font-normal text-gray-400 ml-1">(per branch)</span>
            )}
          </h2>
          <div className="space-y-4">
            {locations.length > 1 && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Branch</label>
                <select
                  value={effectivePinLocationId ?? ""}
                  onChange={(e) => setPinLocationId(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:border-green-500 focus:ring-1 focus:ring-green-500"
                >
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  Each branch has its own PINs. Pick a branch to set its Admin and Cashier PINs.
                </p>
              </div>
            )}
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

        {/* Receipts — per branch */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2 mb-4">
            <Printer className="w-5 h-5 text-gray-600" />
            Receipts
            {locations.length > 1 && (
              <span className="text-xs font-normal text-gray-400 ml-1">(per branch)</span>
            )}
          </h2>
          <p className="text-sm text-gray-500 mb-4">
            Untick a branch that doesn&apos;t issue receipts — the Print and WhatsApp receipt
            buttons will no longer appear after a sale at that branch.
          </p>
          <div className="space-y-3">
            {locations.map((l) => (
              <label key={l.id} className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={receiptsByLocation[l.id] ?? true}
                  onChange={(e) =>
                    setReceiptsByLocation((m) => ({ ...m, [l.id]: e.target.checked }))
                  }
                  className="w-4 h-4 text-green-600 border-gray-300 rounded focus:ring-green-500"
                />
                <span className="text-sm font-medium text-gray-700">{l.name}</span>
              </label>
            ))}
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

        {/* Prepared food — gates Ingredients, the "prepared item" flag on products,
            and recipe costing. Only settable at first-time setup before this. */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2 mb-4">
            <ChefHat className="w-5 h-5 text-gray-600" />
            Prepared Food
          </h2>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={preparesFood}
              onChange={(e) => setPreparesFood(e.target.checked)}
              className="mt-1 w-4 h-4 rounded border-gray-300 text-green-600 focus:ring-green-500"
            />
            <div>
              <p className="text-sm font-medium text-gray-900">
                We prepare food or make items from ingredients
              </p>
              <p className="text-xs text-gray-500 mt-1">
                Turns on the <strong>Ingredients</strong> page, the &ldquo;prepared item&rdquo;
                option on products, and recipe costing — so a prepared item&apos;s cost comes from
                what it is made of instead of being recorded as zero.
              </p>
            </div>
          </label>
          {preparesFood && (
            <p className="text-xs text-gray-500 mt-3 pl-7">
              Next: set a <strong>pack quantity</strong> on each ingredient, then open a prepared
              product and add its recipe.
            </p>
          )}
          {!preparesFood && (
            <p className="text-xs text-gray-400 mt-3 pl-7">
              Leave this off if you only resell items you buy in.
            </p>
          )}
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

        {/* VAT registration & rate - owner/manager, renders null for cashiers */}
        <VatSection />

        {/* Payment methods - owner/manager, renders null for cashiers */}
        <PaymentMethodsSection />

        {/* Team management - owner/manager, renders null for cashiers */}
        <TeamSection />

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
