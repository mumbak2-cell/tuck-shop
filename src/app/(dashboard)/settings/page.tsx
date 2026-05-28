"use client";
import { useState, useEffect } from "react";
import { db } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Settings, Save, Key, Link, Building2 } from "lucide-react";

export default function SettingsPage() {
  const [adminPin, setAdminPin] = useState("");
  const [cashierPin, setCashierPin] = useState("");
  const [ikhokhaLink, setIkhokhaLink] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [businessPhone, setBusinessPhone] = useState("");
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
    setBusinessName(map.business_name || "Tuck Shop");
    setBusinessPhone(map.business_phone || "");
    setLoading(false);
  }

  async function handleSave() {
    setSaving(true);
    setSuccess(false);

    const settings = [
      { key: "admin_pin", value: adminPin || "1234" },
      { key: "cashier_pin", value: cashierPin || "0000" },
      { key: "ikhokha_link", value: ikhokhaLink },
      { key: "business_name", value: businessName || "Tuck Shop" },
      { key: "business_phone", value: businessPhone },
    ];

    for (const s of settings) {
      await db
        .from("app_settings")
        .upsert({ key: s.key, value: s.value, updated_at: new Date().toISOString() }, { onConflict: "key" });
    }

    setSuccess(true);
    setSaving(false);
    setTimeout(() => setSuccess(false), 3000);
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

        {/* iKhokha Payment Link */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2 mb-4">
            <Link className="w-5 h-5 text-gray-600" />
            iKhokha Payment Link
          </h2>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Payment Link URL</label>
            <input
              type="url"
              value={ikhokhaLink}
              onChange={(e) => setIkhokhaLink(e.target.value)}
              placeholder="https://pay.ikhokha.com/your-link"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
            />
            <p className="text-xs text-gray-500 mt-1">
              This link will be included in WhatsApp invoices and statements so customers can pay online.
              Get your payment link from the iKhokha app or dashboard.
            </p>
          </div>
        </div>

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
