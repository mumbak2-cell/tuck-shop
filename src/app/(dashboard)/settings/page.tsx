"use client";
import { useState, useEffect } from "react";
import { db } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { Settings, Save, Key, Link, Building2, Coins, Warehouse, Boxes, CreditCard, Sparkles, Printer, ChefHat, ExternalLink, Clock, ShoppingCart, Calculator, EyeOff, HandCoins, Gift, AlertTriangle, ClipboardCheck } from "lucide-react";
import { useOrg } from "@/lib/org-context";
import { SADC_CURRENCIES, DEFAULT_CURRENCY, type CurrencyCode } from "@/lib/currency";
import { setActiveCurrency } from "@/lib/format";
import { CURRENCY_CACHE_KEY } from "@/lib/currency-context";
import { DailyDigestSection } from "@/components/settings/daily-digest-section";
import { PeriodLockSection } from "@/components/settings/period-lock-section";
import { TeamSection } from "@/components/settings/team-section";
import { PaymentMethodsSection } from "@/components/settings/payment-methods-section";
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
  const [requiresShift, setRequiresShift] = useState(false);
  // Low stock report threshold (units). "5" default, admin can set 0+.
  const [lowStockThreshold, setLowStockThreshold] = useState("5");
  // Per-branch receipts toggle (location_settings). Absence of a row = enabled.
  const [receiptsByLocation, setReceiptsByLocation] = useState<Record<string, boolean>>({});
  // Per-branch wholesale allow list. The discount itself is negotiated at the
  // till, per line item, so it is deliberately not configured here.
  const [wholesaleByLocation, setWholesaleByLocation] = useState<Record<string, boolean>>({});
  // Per-branch cash denomination counter at shift close. Absence of a row = off.
  const [denomCountByLocation, setDenomCountByLocation] = useState<Record<string, boolean>>({});
  // Per-branch blind cash-up: hides expected cash from cashiers at shift close.
  const [blindCashUpByLocation, setBlindCashUpByLocation] = useState<Record<string, boolean>>({});
  // Per-branch: block Close Shift until a stock count for today exists at that branch.
  const [requireStockCountByLocation, setRequireStockCountByLocation] = useState<Record<string, boolean>>({});
  // Per-branch cash back: lets the till hand out cash against a card payment.
  const [cashBackByLocation, setCashBackByLocation] = useState<Record<string, boolean>>({});
  // Per-branch card incentive: free item on electronic sales over a spend.
  const [cardRewardByLocation, setCardRewardByLocation] = useState<
    Record<string, { enabled: boolean; threshold: string; productId: string }>
  >({});
  // Sellable products, for choosing the freebie.
  const [rewardProducts, setRewardProducts] = useState<{ id: string; name: string }[]>([]);
  const {
    locations,
    orgId,
    currentLocationId,
    subscriptionPlan,
    subscriptionStatus,
    currentPeriodEnd,
    refresh: refreshOrg,
    can,
  } = useOrg();
  // PINs are per-location (location_settings). `pinLocationId` is the branch the
  // owner has explicitly picked to edit; until then we fall back to the active
  // location. Deriving (rather than syncing via an effect) avoids a cascading
  // render when the active location resolves.
  const [pinLocationId, setPinLocationId] = useState<string | null>(null);
  const effectivePinLocationId = pinLocationId ?? currentLocationId;
  const [showPricing, setShowPricing] = useState(false);
  const [managingSubscription, setManagingSubscription] = useState(false);
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

  // Load per-branch wholesale settings.
  useEffect(() => {
    if (locations.length === 0) return;
    db.from("location_settings")
      .select("location_id, value")
      .eq("key", "wholesale_enabled")
      .then(({ data }: { data: { location_id: string; value: string }[] | null }) => {
        const map: Record<string, boolean> = {};
        locations.forEach((l) => (map[l.id] = false));
        (data || []).forEach((row) => {
          map[row.location_id] = row.value === "true";
        });
        setWholesaleByLocation(map);
      });
  }, [locations]);

  // Load the per-branch denomination-counter toggle for every branch at once.
  useEffect(() => {
    if (locations.length === 0) return;
    db.from("location_settings")
      .select("location_id, value")
      .eq("key", "denomination_count_enabled")
      .then(({ data }: { data: { location_id: string; value: string }[] | null }) => {
        const map: Record<string, boolean> = {};
        locations.forEach((l) => (map[l.id] = false));
        (data || []).forEach((row) => {
          map[row.location_id] = row.value === "true";
        });
        setDenomCountByLocation(map);
      });
  }, [locations]);

  // Load the per-branch blind cash-up toggle for every branch at once.
  useEffect(() => {
    if (locations.length === 0) return;
    db.from("location_settings")
      .select("location_id, value")
      .eq("key", "blind_cash_up_enabled")
      .then(({ data }: { data: { location_id: string; value: string }[] | null }) => {
        const map: Record<string, boolean> = {};
        locations.forEach((l) => (map[l.id] = false));
        (data || []).forEach((row) => {
          map[row.location_id] = row.value === "true";
        });
        setBlindCashUpByLocation(map);
      });
  }, [locations]);

  // Load the per-branch stock-count-required-to-close toggle for every branch at once.
  useEffect(() => {
    if (locations.length === 0) return;
    db.from("location_settings")
      .select("location_id, value")
      .eq("key", "require_stock_count_for_cashup")
      .then(({ data }: { data: { location_id: string; value: string }[] | null }) => {
        const map: Record<string, boolean> = {};
        locations.forEach((l) => (map[l.id] = false));
        (data || []).forEach((row) => {
          map[row.location_id] = row.value === "true";
        });
        setRequireStockCountByLocation(map);
      });
  }, [locations]);

  // Load the per-branch cash back toggle for every branch at once.
  useEffect(() => {
    if (locations.length === 0) return;
    db.from("location_settings")
      .select("location_id, value")
      .eq("key", "cash_back_enabled")
      .then(({ data }: { data: { location_id: string; value: string }[] | null }) => {
        const map: Record<string, boolean> = {};
        locations.forEach((l) => (map[l.id] = false));
        (data || []).forEach((row) => {
          map[row.location_id] = row.value === "true";
        });
        setCashBackByLocation(map);
      });
  }, [locations]);

  // Load the per-branch card incentive for every branch at once.
  useEffect(() => {
    if (locations.length === 0) return;
    db.from("location_settings")
      .select("location_id, key, value")
      .in("key", ["card_reward_enabled", "card_reward_threshold", "card_reward_product_id"])
      .then(({ data }: { data: { location_id: string; key: string; value: string }[] | null }) => {
        const map: Record<string, { enabled: boolean; threshold: string; productId: string }> = {};
        locations.forEach((l) => (map[l.id] = { enabled: false, threshold: "", productId: "" }));
        (data || []).forEach((row) => {
          if (!map[row.location_id]) map[row.location_id] = { enabled: false, threshold: "", productId: "" };
          if (row.key === "card_reward_enabled") map[row.location_id].enabled = row.value === "true";
          if (row.key === "card_reward_threshold") map[row.location_id].threshold = row.value;
          if (row.key === "card_reward_product_id") map[row.location_id].productId = row.value;
        });
        setCardRewardByLocation(map);
      });
  }, [locations]);

  // Product list for the freebie picker.
  useEffect(() => {
    db.from("products")
      .select("id, name")
      .eq("discontinued", false)
      .order("name")
      .then(({ data }: { data: { id: string; name: string }[] | null }) => {
        setRewardProducts(data || []);
      });
  }, []);

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
    setRequiresShift(map.requires_shift === "true");
    setLowStockThreshold(map.low_stock_threshold ?? "5");
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

  async function handleManageSubscription() {
    setManagingSubscription(true);
    try {
      const { data: sessionData } = await db.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) { alert("Not signed in"); return; }
      const res = await fetch("/api/billing/manage", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Unknown error" }));
        alert(body.error || "Could not open subscription management");
        return;
      }
      const { url } = await res.json();
      window.open(url, "_blank", "noopener");
    } finally {
      setManagingSubscription(false);
    }
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
      { key: "requires_shift", value: requiresShift ? "true" : "false" },
      {
        key: "low_stock_threshold",
        value: String(Math.max(0, Number(lowStockThreshold) || 0)),
      },
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

    // Wholesale allow list — one row per branch.
    if (locations.length > 0) {
      const wholesaleRows = locations.map((l) => ({
        org_id: orgId,
        location_id: l.id,
        key: "wholesale_enabled",
        value: (wholesaleByLocation[l.id] ?? false) ? "true" : "false",
        updated_at: new Date().toISOString(),
      }));
      const { error: wsErr } = await db
        .from("location_settings")
        .upsert(wholesaleRows, { onConflict: "location_id,key" });
      if (wsErr) {
        setSaving(false);
        alert("Failed to save wholesale settings: " + (wsErr.message || "Unknown error"));
        return;
      }
    }

    // Denomination counter toggle — one row per branch.
    if (locations.length > 0) {
      const denomRows = locations.map((l) => ({
        org_id: orgId,
        location_id: l.id,
        key: "denomination_count_enabled",
        value: (denomCountByLocation[l.id] ?? false) ? "true" : "false",
        updated_at: new Date().toISOString(),
      }));
      const { error: denomErr } = await db
        .from("location_settings")
        .upsert(denomRows, { onConflict: "location_id,key" });
      if (denomErr) {
        setSaving(false);
        alert("Failed to save cash count settings: " + (denomErr.message || "Unknown error"));
        return;
      }
    }

    // Blind cash-up toggle — one row per branch.
    if (locations.length > 0) {
      const blindRows = locations.map((l) => ({
        org_id: orgId,
        location_id: l.id,
        key: "blind_cash_up_enabled",
        value: (blindCashUpByLocation[l.id] ?? false) ? "true" : "false",
        updated_at: new Date().toISOString(),
      }));
      const { error: blindErr } = await db
        .from("location_settings")
        .upsert(blindRows, { onConflict: "location_id,key" });
      if (blindErr) {
        setSaving(false);
        alert("Failed to save blind cash-up settings: " + (blindErr.message || "Unknown error"));
        return;
      }
    }

    // Stock-count-required-to-close toggle — one row per branch.
    if (locations.length > 0) {
      const stockCountRows = locations.map((l) => ({
        org_id: orgId,
        location_id: l.id,
        key: "require_stock_count_for_cashup",
        value: (requireStockCountByLocation[l.id] ?? false) ? "true" : "false",
        updated_at: new Date().toISOString(),
      }));
      const { error: scErr } = await db
        .from("location_settings")
        .upsert(stockCountRows, { onConflict: "location_id,key" });
      if (scErr) {
        setSaving(false);
        alert("Failed to save stock count settings: " + (scErr.message || "Unknown error"));
        return;
      }
    }

    // Cash back toggle — one row per branch.
    if (locations.length > 0) {
      const cashBackRows = locations.map((l) => ({
        org_id: orgId,
        location_id: l.id,
        key: "cash_back_enabled",
        value: (cashBackByLocation[l.id] ?? false) ? "true" : "false",
        updated_at: new Date().toISOString(),
      }));
      const { error: cbErr } = await db
        .from("location_settings")
        .upsert(cashBackRows, { onConflict: "location_id,key" });
      if (cbErr) {
        setSaving(false);
        alert("Failed to save cash back settings: " + (cbErr.message || "Unknown error"));
        return;
      }
    }

    // Card incentive — three rows per branch (enabled, threshold, product).
    if (locations.length > 0) {
      const rewardRows: { org_id: string; location_id: string; key: string; value: string; updated_at: string }[] = [];
      for (const l of locations) {
        const r = cardRewardByLocation[l.id] ?? { enabled: false, threshold: "", productId: "" };
        if (r.enabled && (!r.productId || !(parseFloat(r.threshold) > 0))) {
          setSaving(false);
          alert(`Card incentive at ${l.name}: choose a free item and a spend over 0, or untick the branch.`);
          return;
        }
        const now = new Date().toISOString();
        rewardRows.push(
          { org_id: orgId, location_id: l.id, key: "card_reward_enabled", value: r.enabled ? "true" : "false", updated_at: now },
          { org_id: orgId, location_id: l.id, key: "card_reward_threshold", value: r.threshold || "0", updated_at: now },
          { org_id: orgId, location_id: l.id, key: "card_reward_product_id", value: r.productId || "", updated_at: now }
        );
      }
      const { error: rwErr } = await db
        .from("location_settings")
        .upsert(rewardRows, { onConflict: "location_id,key" });
      if (rwErr) {
        setSaving(false);
        alert("Failed to save card incentive settings: " + (rwErr.message || "Unknown error"));
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

  // Shown beside the headings of settings that are stored per branch.
  const perBranchBadge = locations.length > 1
    ? <span className="text-xs font-normal text-gray-400 ml-1">(per branch)</span>
    : undefined;

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
        <CollapsibleSection title="Plan & Billing" icon={CreditCard}>
          <div className="space-y-4">
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
                {subscriptionStatus === "active" && currentPeriodEnd && (
                  <p className="text-xs text-gray-500 mt-1">
                    Renews {new Date(currentPeriodEnd).toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric" })}
                  </p>
                )}
                {subscriptionStatus !== "active" && (
                  <p className="text-xs text-gray-500 mt-1">
                    Upgrade any time to unlock more locations, users and priority support.
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {subscriptionStatus === "active" && (
                  <Button
                    variant="secondary"
                    onClick={handleManageSubscription}
                    loading={managingSubscription}
                  >
                    <ExternalLink className="w-4 h-4 mr-2" />
                    Manage subscription
                  </Button>
                )}
                <Button onClick={() => setShowPricing(true)}>
                  <Sparkles className="w-4 h-4 mr-2" />
                  {subscriptionStatus === "active" ? "Change plan" : "Upgrade"}
                </Button>
              </div>
            </div>
          </div>
        </CollapsibleSection>
        <PricingModal open={showPricing} onClose={() => setShowPricing(false)} />

        {/* Business Details */}
        <CollapsibleSection title="Business Details" icon={Building2}>
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
        </CollapsibleSection>

        {/* Currency */}
        <CollapsibleSection title="Currency" icon={Coins}>
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
        </CollapsibleSection>

        {/* Access PINs */}
        <CollapsibleSection title="Access PINs" icon={Key} badge={perBranchBadge}>
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
        </CollapsibleSection>

        {/* Receipts — per branch */}
        <CollapsibleSection title="Receipts" icon={Printer} badge={perBranchBadge}>
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
        </CollapsibleSection>

        {/* Shift Requirements */}
        <CollapsibleSection title="Shift Requirements" icon={Clock}>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={requiresShift}
              onChange={(e) => setRequiresShift(e.target.checked)}
              className="mt-1 w-4 h-4 rounded border-gray-300 text-green-600 focus:ring-green-500"
            />
            <div>
              <p className="text-sm font-medium text-gray-900">
                Require shift to be open before selling
              </p>
              <p className="text-xs text-gray-500 mt-1">
                When enabled, cashiers must open a shift before they can make sales.
                The shift tracks opening float, closing cash, and daily reconciliation.
              </p>
            </div>
          </label>
        </CollapsibleSection>

        {/* Low stock report threshold — org-wide */}
        <CollapsibleSection title="Low Stock Alert" icon={AlertTriangle}>
          <p className="text-sm text-gray-500 mb-4">
            The Reports page flags a product as low stock once its quantity at a branch
            falls to or below this number (and it still has stock — out-of-stock items
            show separately). Set to 0 to only flag items with none left.
          </p>
          <div>
            <label className="block text-sm text-gray-600 mb-1">Low stock at or below</label>
            <input
              type="number"
              min="0"
              step="1"
              value={lowStockThreshold}
              onChange={(e) => setLowStockThreshold(e.target.value)}
              className="w-32 border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
            />
            <span className="ml-2 text-sm text-gray-500">units</span>
          </div>
        </CollapsibleSection>

        {/* Cash denomination counter — per branch */}
        <CollapsibleSection title="Cash Count at Shift Close" icon={Calculator} badge={perBranchBadge}>
          <p className="text-sm text-gray-500 mb-4">
            Tick a branch to give its cashiers a note-by-note counter when closing a shift.
            They enter how many of each note and coin are in the till and the closing cash
            total is worked out for them.
          </p>
          <div className="space-y-3">
            {locations.map((l) => (
              <label key={l.id} className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={denomCountByLocation[l.id] ?? false}
                  onChange={(e) =>
                    setDenomCountByLocation((m) => ({ ...m, [l.id]: e.target.checked }))
                  }
                  className="w-4 h-4 text-green-600 border-gray-300 rounded focus:ring-green-500"
                />
                <span className="text-sm font-medium text-gray-700">{l.name}</span>
              </label>
            ))}
          </div>
        </CollapsibleSection>

        {/* Card incentive — per branch */}
        <CollapsibleSection title="Card Incentive" icon={Gift} badge={perBranchBadge}>
          <p className="text-sm text-gray-500 mb-4">
            Give a free item on card, EFT and mobile money sales over a set amount, to push
            customers off cash. The item is added to the sale at no charge, so its stock comes
            down and its cost is counted, but it adds nothing to the takings. Cash back does not
            count towards the spend.
          </p>
          <div className="space-y-4">
            {locations.map((l) => {
              const r = cardRewardByLocation[l.id] ?? { enabled: false, threshold: "", productId: "" };
              const update = (patch: Partial<typeof r>) =>
                setCardRewardByLocation((m) => ({ ...m, [l.id]: { ...r, ...patch } }));
              return (
                <div key={l.id} className="border border-gray-200 rounded-lg p-4">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      onChange={(e) => update({ enabled: e.target.checked })}
                      className="w-4 h-4 text-green-600 border-gray-300 rounded focus:ring-green-500"
                    />
                    <span className="text-sm font-medium text-gray-900">{l.name}</span>
                  </label>
                  {r.enabled && (
                    <div className="mt-3 ml-7 space-y-3">
                      <div>
                        <label className="block text-sm text-gray-600 mb-1">Spend at least</label>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={r.threshold}
                          onChange={(e) => update({ threshold: e.target.value })}
                          placeholder="0.00"
                          className="w-32 border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm text-gray-600 mb-1">Free item</label>
                        <select
                          value={r.productId}
                          onChange={(e) => update({ productId: e.target.value })}
                          className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:border-green-500 focus:ring-1 focus:ring-green-500"
                        >
                          <option value="">Choose a product...</option>
                          {rewardProducts.map((p) => (
                            <option key={p.id} value={p.id}>{p.name}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </CollapsibleSection>

        {/* Cash back — per branch */}
        <CollapsibleSection title="Cash Back" icon={HandCoins} badge={perBranchBadge}>
          <p className="text-sm text-gray-500 mb-4">
            Tick a branch that hands customers cash against a card payment. Its cashiers
            get a Cash Back field on card, EFT and mobile money sales — the amount is added
            to the card charge and taken off the expected cash at shift close, so the till
            still balances.
          </p>
          <div className="space-y-3">
            {locations.map((l) => (
              <label key={l.id} className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={cashBackByLocation[l.id] ?? false}
                  onChange={(e) =>
                    setCashBackByLocation((m) => ({ ...m, [l.id]: e.target.checked }))
                  }
                  className="w-4 h-4 text-green-600 border-gray-300 rounded focus:ring-green-500"
                />
                <span className="text-sm font-medium text-gray-700">{l.name}</span>
              </label>
            ))}
          </div>
        </CollapsibleSection>

        {/* Blind cash-up — per branch. A manager without manage_blind_cashup
            can't see or change this section at all. */}
        {can("manage_blind_cashup") && (
          <CollapsibleSection title="Blind Cash-Up" icon={EyeOff} badge={perBranchBadge}>
            <p className="text-sm text-gray-500 mb-4">
              Tick a branch to hide the expected cash, cash takings and variance from its
              cashiers when they close a shift. They count the till and enter the total
              without being shown what it should be, so you reconcile against an unprompted
              figure. Admins always see the full reconciliation.
            </p>
            <div className="space-y-3">
              {locations.map((l) => (
                <label key={l.id} className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={blindCashUpByLocation[l.id] ?? false}
                    onChange={(e) =>
                      setBlindCashUpByLocation((m) => ({ ...m, [l.id]: e.target.checked }))
                    }
                    className="w-4 h-4 text-green-600 border-gray-300 rounded focus:ring-green-500"
                  />
                  <span className="text-sm font-medium text-gray-700">{l.name}</span>
                </label>
              ))}
            </div>
          </CollapsibleSection>
        )}

        {/* Stock count required to close — per branch */}
        <CollapsibleSection title="Stock Count Required to Close" icon={ClipboardCheck} badge={perBranchBadge}>
          <p className="text-sm text-gray-500 mb-4">
            Tick a branch to block Close Shift until a stock count has been done there today.
            The cash-up figure itself is unchanged — this only makes sure the closing stock
            take actually happened before the till is reconciled.
          </p>
          <div className="space-y-3">
            {locations.map((l) => (
              <label key={l.id} className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={requireStockCountByLocation[l.id] ?? false}
                  onChange={(e) =>
                    setRequireStockCountByLocation((m) => ({ ...m, [l.id]: e.target.checked }))
                  }
                  className="w-4 h-4 text-green-600 border-gray-300 rounded focus:ring-green-500"
                />
                <span className="text-sm font-medium text-gray-700">{l.name}</span>
              </label>
            ))}
          </div>
        </CollapsibleSection>

        {/* Wholesale Mode — per branch */}
        <CollapsibleSection title="Wholesale Mode" icon={ShoppingCart} badge={perBranchBadge}>
          <p className="text-sm text-gray-500 mb-4">
            Tick the branches allowed to sell in bulk. Products must also be flagged as
            &ldquo;wholesale enabled&rdquo; to offer a wholesale price. The discount itself is
            set by the cashier in the POS, per item, before charging.
          </p>
          <div className="space-y-3">
            {locations.map((l) => (
              <label key={l.id} className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={wholesaleByLocation[l.id] ?? false}
                  onChange={(e) =>
                    setWholesaleByLocation((m) => ({ ...m, [l.id]: e.target.checked }))
                  }
                  className="w-4 h-4 text-green-600 border-gray-300 rounded focus:ring-green-500"
                />
                <span className="text-sm font-medium text-gray-700">{l.name}</span>
              </label>
            ))}
          </div>
        </CollapsibleSection>

        {/* Online Payment Link (generic) */}
        <CollapsibleSection title="Online Payment Link" icon={Link}>
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
        </CollapsibleSection>

        {/* Prepared food — gates Ingredients, the "prepared item" flag on products,
            and recipe costing. Only settable at first-time setup before this. */}
        <CollapsibleSection title="Prepared Food" icon={ChefHat}>
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
        </CollapsibleSection>

        {/* Stock Mode — always visible so single-shop orgs can pre-pick before adding a second location */}
        <CollapsibleSection
          title="Stock Mode"
          icon={Boxes}
          badge={locations.length <= 1 ? (
            <span className="text-xs font-normal text-gray-400 ml-1">(takes effect when you add a second shop)</span>
          ) : undefined}
        >
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
        </CollapsibleSection>

        {/* Warehouse Management */}
        <CollapsibleSection title="Warehouse Management (WMS)" icon={Warehouse}>
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
        </CollapsibleSection>

        {/* Payment methods - owner/manager, renders null for cashiers */}
        <PaymentMethodsSection />

        {/* Team management - owner/manager, renders null for cashiers */}
        <TeamSection />

        {/* Period Lock - owner only, prevents retroactive edits to closed periods */}
        <PeriodLockSection />

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

        {/* Legal / billing links */}
        <nav className="flex flex-wrap gap-x-4 gap-y-1 pt-4 border-t border-gray-100 text-xs text-gray-500">
          <a href="/pricing" className="hover:text-gray-700 hover:underline">Pricing</a>
          <a href="/terms" className="hover:text-gray-700 hover:underline">Terms of Service</a>
          <a href="/refund-policy" className="hover:text-gray-700 hover:underline">Refund &amp; Cancellation Policy</a>
        </nav>
      </div>
    </div>
  );
}
