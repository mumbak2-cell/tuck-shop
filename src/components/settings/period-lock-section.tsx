"use client";
import { useEffect, useState } from "react";
import { db } from "@/lib/supabase";
import { useOrg } from "@/lib/org-context";
import { Button } from "@/components/ui/button";
import { Lock, AlertTriangle } from "lucide-react";
import { localToday } from "@/lib/date-utils";

export function PeriodLockSection() {
  const { role, orgId } = useOrg();
  const [lockedThrough, setLockedThrough] = useState<string | null>(null);
  const [newDate, setNewDate] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function load() {
    const { data } = await db
      .from("period_locks")
      .select("locked_through")
      .maybeSingle();
    if (data) {
      setLockedThrough(data.locked_through);
      setNewDate(data.locked_through);
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  if (role !== "owner") return null;

  async function handleSave() {
    if (!newDate) return;

    if (lockedThrough && newDate < lockedThrough) {
      setError("Lock date can only move forward.");
      return;
    }

    const today = localToday();
    if (newDate >= today) {
      setError("Cannot lock today or future dates — you would block current operations.");
      return;
    }

    setSaving(true);
    setError(null);
    setSuccess(false);

    const { error: err } = await db
      .from("period_locks")
      .upsert({ org_id: orgId, locked_through: newDate }, { onConflict: "org_id" });

    if (err) {
      setError(err.message);
    } else {
      setLockedThrough(newDate);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    }
    setSaving(false);
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <div className="px-5 py-3 bg-gray-50 border-b border-gray-100 flex items-center gap-2">
        <Lock className="w-4 h-4 text-gray-600" />
        <h2 className="font-semibold text-gray-800">Period Lock</h2>
      </div>
      <div className="p-5 space-y-4">
        <p className="text-sm text-gray-600">
          Lock a past accounting period to prevent voids, expense deletions, and returns
          from modifying historical data. Once set, the lock can only be moved forward.
        </p>

        {loading ? (
          <div className="text-sm text-gray-400">Loading...</div>
        ) : (
          <>
            {lockedThrough && (
              <div className="flex items-center gap-2 text-sm">
                <Lock className="w-4 h-4 text-amber-600" />
                <span className="text-gray-700">
                  Currently locked through <strong>{lockedThrough}</strong>
                </span>
              </div>
            )}

            <div className="flex items-center gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  Lock through date
                </label>
                <input
                  type="date"
                  value={newDate}
                  max={(() => {
                    const d = new Date();
                    d.setDate(d.getDate() - 1);
                    return d.toLocaleDateString("en-CA");
                  })()}
                  onChange={(e) => {
                    setNewDate(e.target.value);
                    setError(null);
                  }}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
                />
              </div>
              <div className="pt-5">
                <Button
                  onClick={handleSave}
                  loading={saving}
                  disabled={!newDate || newDate === lockedThrough}
                >
                  <Lock className="w-4 h-4 mr-1" />
                  {lockedThrough ? "Advance Lock" : "Set Lock"}
                </Button>
              </div>
            </div>

            {error && (
              <div className="flex items-center gap-2 text-sm text-red-600">
                <AlertTriangle className="w-4 h-4" />
                {error}
              </div>
            )}
            {success && (
              <div className="text-sm text-green-600 font-medium">
                Period locked through {lockedThrough}.
              </div>
            )}

            <div className="text-xs text-gray-500 mt-2">
              Sales on or before the lock date cannot be voided, expenses cannot be deleted,
              and returns against sales in the locked period are blocked.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
