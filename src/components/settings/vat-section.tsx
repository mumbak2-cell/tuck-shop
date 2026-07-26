"use client";
// VAT registration and rate. Stored on the organizations row (vat_percent, tpin)
// — the same source the receipt, the POS and submit_sale_batch already read.
// A null vat_percent means "not VAT-registered": no VAT is charged and the VAT
// panels stay hidden. Owners only.
//
// Turning VAT on here starts charging output VAT on every sale (migration 061).
// Zero-rated items (bread, milk, …) are marked per-product on the product form,
// which only appears once an org is registered here (migration 062).

import { useEffect, useState } from "react";
import { db } from "@/lib/supabase";
import { useOrg } from "@/lib/org-context";
import { Button } from "@/components/ui/button";
import { Receipt } from "lucide-react";

export function VatSection() {
  const { role, orgId, refresh: refreshOrg } = useOrg();
  const [registered, setRegistered] = useState(false);
  const [rate, setRate] = useState("15");
  const [tpin, setTpin] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data } = await db.from("organizations").select("vat_percent, tpin").single();
      const vp = data?.vat_percent;
      if (vp != null && Number(vp) > 0) {
        setRegistered(true);
        setRate(String(Number(vp)));
      }
      setTpin(data?.tpin || "");
      setLoading(false);
    })();
  }, []);

  // Shop configuration — owners and managers, not cashiers.
  if (role !== "owner" && role !== "admin") return null;

  async function save() {
    setError(null);
    const parsedRate = parseFloat(rate);
    if (registered && (!(parsedRate > 0) || parsedRate >= 100)) {
      setError("Enter a VAT rate between 0 and 100 (e.g. 15 for RSA, 16 for Zambia).");
      return;
    }
    setSaving(true);
    // Off = null, so "not registered" is unambiguous and the VAT panels hide.
    const { error: err } = await db
      .from("organizations")
      .update({
        vat_percent: registered ? parsedRate : null,
        tpin: tpin.trim() || null,
      })
      .eq("id", orgId);
    setSaving(false);
    if (err) {
      setError(err.message || "Could not save VAT settings.");
      return;
    }
    // Refresh so the receipt, POS and product form see the change immediately.
    await refreshOrg();
    setSuccess(true);
    setTimeout(() => setSuccess(false), 2500);
  }

  const inputClass =
    "w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500";

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-6">
      <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2 mb-1">
        <Receipt className="w-5 h-5 text-gray-600" />
        VAT
      </h2>
      <p className="text-sm text-gray-500 mb-4">
        Turn this on only if your business is registered for VAT. Prices stay VAT-inclusive; the VAT
        portion is worked out from them on every sale and on the receipt.
      </p>

      {error && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-gray-400 py-4 text-center">Loading…</div>
      ) : (
        <div className="space-y-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={registered}
              onChange={(e) => setRegistered(e.target.checked)}
              className="rounded border-gray-300 text-green-600 focus:ring-green-500"
            />
            We are registered for VAT
          </label>

          {registered && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">VAT rate (%)</label>
                <input
                  type="number"
                  step="0.01"
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                  placeholder="15"
                  className={inputClass}
                />
                <p className="text-xs text-gray-400 mt-1">RSA 15% · Zambia 16%.</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  VAT / tax number (TPIN)
                </label>
                <input
                  type="text"
                  value={tpin}
                  onChange={(e) => setTpin(e.target.value)}
                  placeholder="Shown on receipts"
                  className={inputClass}
                />
              </div>
            </div>
          )}

          {registered && (
            <p className="text-xs text-gray-500">
              Zero-rated items (e.g. brown bread, milk) are marked on each product — a
              &ldquo;Zero-rated for VAT&rdquo; box appears on the product form once VAT is on here.
            </p>
          )}

          <div className="flex items-center gap-3">
            <Button onClick={save} loading={saving}>
              Save VAT settings
            </Button>
            {success && <span className="text-sm text-green-600">Saved.</span>}
          </div>
        </div>
      )}
    </div>
  );
}
