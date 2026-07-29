"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { useShift } from "@/lib/shift-context";
import { useOrg } from "@/lib/org-context";
import { db } from "@/lib/supabase";
import { formatZAR } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Clock, Play, Square, Check, Banknote, Smartphone, Users, RotateCcw, Trash2 } from "lucide-react";
import Link from "next/link";
import { paymentBucket } from "@/lib/payment-buckets";
import { localToday } from "@/lib/date-utils";

interface MethodTotal {
  method: string;
  total: number;
  bucket: "cash" | "card" | "credit";
  confirmed: boolean;
}

export default function ShiftPage() {
  const router = useRouter();
  const { name: userName, role } = useAuth();
  const { shift, loading, isOpen, openShift, closeShift, deleteShift, reopenShift } = useShift();
  const { currentLocationId, currentLocationName } = useOrg();

  const [openingFloat, setOpeningFloat] = useState("0");
  const [closingCash, setClosingCash] = useState("");
  const [opening, setOpening] = useState(false);
  const [closing, setClosing] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [methodTotals, setMethodTotals] = useState<MethodTotal[]>([]);
  const [loadingTotals, setLoadingTotals] = useState(false);

  const isAdmin = role === "admin";

  // Reset the local form inputs whenever the operator switches location so
  // values typed for one shop do not pre-fill at another shop.
  useEffect(() => {
    setOpeningFloat("0");
    setClosingCash("");
  }, [currentLocationId]);

  const today = new Date().toLocaleDateString("en-ZA", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // Load today's sales grouped by raw payment_method for the reconciliation
  // panel. Refreshes whenever the operator opens or returns to the screen
  // with an open shift, and when location switches.
  useEffect(() => {
    async function loadMethodTotals() {
      if (!shift || !currentLocationId) return;
      setLoadingTotals(true);
      const today = localToday();
      const { data } = await db
        .from("sales")
        .select("total_amount, payment_method, location_id")
        .eq("sale_date", today)
        .eq("voided", false)
        .eq("location_id", currentLocationId);
      const sums = new Map<string, number>();
      ((data as { total_amount: number; payment_method: string }[]) || []).forEach((s) => {
        const m = (s.payment_method || "Unknown").trim() || "Unknown";
        sums.set(m, (sums.get(m) || 0) + (Number(s.total_amount) || 0));
      });
      const rows: MethodTotal[] = Array.from(sums.entries())
        .map(([method, total]) => ({
          method,
          total,
          bucket: paymentBucket(method),
          confirmed: false,
        }))
        .sort((a, b) => b.total - a.total);
      setMethodTotals(rows);
      setLoadingTotals(false);
    }
    if (shift && shift.status === "open") {
      loadMethodTotals();
    }
  }, [shift, currentLocationId]);


  async function handleOpenShift() {
    setOpening(true);
    const success = await openShift(userName, parseFloat(openingFloat) || 0);
    setOpening(false);
    if (success) {
      router.push("/pos");
    }
  }

  async function handleCloseShift() {
    if (!closingCash && closingCash !== "0") {
      alert("Please enter the closing cash amount.");
      return;
    }
    setClosing(true);
    await closeShift(userName, parseFloat(closingCash) || 0);
    setClosing(false);
  }

  if (loading) {
    return <div className="text-center py-12 text-gray-400">Loading...</div>;
  }

  // No shift today — show open shift screen
  if (!shift) {
    return (
      <div className="max-w-lg mx-auto mt-8">
        <div className="bg-white rounded-2xl border border-gray-200 p-8">
          <div className="text-center mb-8">
            <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <Play className="w-8 h-8 text-green-600" />
            </div>
            <h1 className="text-2xl font-bold text-gray-900">Start Shift</h1>
            <p className="text-sm text-gray-500 mt-1">{today}</p>
          </div>

          <div className="space-y-4">
            <Input
              label="Opening Float (R)"
              type="number"
              step="0.01"
              value={openingFloat}
              onChange={(e) => setOpeningFloat(e.target.value)}
              placeholder="Cash in till at start of shift"
            />

            <Button onClick={handleOpenShift} loading={opening} size="lg" className="w-full text-base py-4">
              <Play className="w-5 h-5 mr-2" />
              Open Shift
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Shift is closed
  if (shift.status === "closed") {
    return (
      <div className="max-w-lg mx-auto mt-8">
        <div className="bg-white rounded-2xl border border-gray-200 p-8">
          <div className="text-center mb-6">
            <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <Check className="w-8 h-8 text-gray-500" />
            </div>
            <h1 className="text-2xl font-bold text-gray-900">Shift Closed</h1>
            <p className="text-sm text-gray-500 mt-1">{today}</p>
          </div>

          <div className="space-y-3 text-sm">
            <div className="flex justify-between py-2 border-b border-gray-100">
              <span className="text-gray-500">Opened by</span>
              <span className="font-medium text-gray-900">{shift.opened_by}</span>
            </div>
            <div className="flex justify-between py-2 border-b border-gray-100">
              <span className="text-gray-500">Opened at</span>
              <span className="font-medium text-gray-900">
                {new Date(shift.opened_at).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
            <div className="flex justify-between py-2 border-b border-gray-100">
              <span className="text-gray-500">Opening float</span>
              <span className="font-medium text-gray-900">{formatZAR(shift.opening_float)}</span>
            </div>
            <div className="flex justify-between py-2 border-b border-gray-100">
              <span className="text-gray-500">Closed by</span>
              <span className="font-medium text-gray-900">{shift.closed_by}</span>
            </div>
            <div className="flex justify-between py-2 border-b border-gray-100">
              <span className="text-gray-500">Closed at</span>
              <span className="font-medium text-gray-900">
                {shift.closed_at ? new Date(shift.closed_at).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" }) : "—"}
              </span>
            </div>
            <div className="flex justify-between py-2">
              <span className="text-gray-500">Closing cash</span>
              <span className="font-medium text-gray-900">{shift.closing_cash !== null ? formatZAR(shift.closing_cash) : "—"}</span>
            </div>
          </div>

          {isAdmin && (
            <div className="mt-6 pt-4 border-t border-gray-100 space-y-2">
              <p className="text-xs text-gray-400 uppercase tracking-wide font-medium mb-2">Admin actions</p>
              <Button
                onClick={async () => {
                  if (!confirm("Reopen this shift? The cashier will be able to continue selling and close it again later.")) return;
                  setReopening(true);
                  const ok = await reopenShift();
                  setReopening(false);
                  if (ok) router.push("/pos");
                }}
                loading={reopening}
                variant="secondary"
                size="sm"
                className="w-full"
              >
                <RotateCcw className="w-4 h-4 mr-2" />
                Reopen Shift
              </Button>
              <Button
                onClick={async () => {
                  if (!confirm("Delete this shift entirely? This cannot be undone. The cashier will be able to start a fresh shift.")) return;
                  setDeleting(true);
                  await deleteShift(shift.id);
                  setDeleting(false);
                }}
                loading={deleting}
                variant="danger"
                size="sm"
                className="w-full"
              >
                <Trash2 className="w-4 h-4 mr-2" />
                Delete Shift
              </Button>
            </div>
          )}

          <div className="mt-6 pt-4 border-t border-gray-100">
            <Link
              href="/revenue-assurance"
              className="flex items-center justify-center gap-2 text-sm text-green-600 hover:underline"
            >
              View Revenue Assurance Report →
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // Shift is open — show shift status + close option
  return (
    <div className="max-w-lg mx-auto mt-8">
      <div className="bg-white rounded-2xl border border-gray-200 p-8">
        <div className="text-center mb-6">
          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <Clock className="w-8 h-8 text-green-600 animate-pulse" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Shift Open</h1>
          <p className="text-sm text-gray-500 mt-1">{today}</p>
          <p className="text-xs text-gray-400 mt-1">
            Opened by {shift.opened_by} at{" "}
            {new Date(shift.opened_at).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" })}
          </p>
        </div>

        <div className="space-y-3 text-sm mb-6">
          <div className="flex justify-between py-2 border-b border-gray-100">
            <span className="text-gray-500">Opening float</span>
            <span className="font-medium text-gray-900">{formatZAR(shift.opening_float)}</span>
          </div>
        </div>

        {/* Close shift section */}
        <div className="border-t border-gray-200 pt-6">
          <h2 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <Square className="w-5 h-5 text-red-500" />
            End-of-Day Reconciliation
          </h2>

          {/* End-of-day reconciliation panel: every payment method on one screen */}
          <ReconciliationPanel
            loading={loadingTotals}
            methodTotals={methodTotals}
            setMethodTotals={setMethodTotals}
            openingFloat={parseFloat(shift.opening_float?.toString() || "0") || 0}
            closingCash={closingCash}
          />

          <div className="space-y-4">
            <Input
              label="Closing Cash Counted in Till"
              type="number"
              step="0.01"
              value={closingCash}
              onChange={(e) => setClosingCash(e.target.value)}
              placeholder="Count the cash and enter total"
            />

            <Button
              onClick={handleCloseShift}
              loading={closing}
              variant="danger"
              size="lg"
              className="w-full text-base py-4"
            >
              <Square className="w-5 h-5 mr-2" />
              Close Shift
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReconciliationPanel({
  loading, methodTotals, setMethodTotals, openingFloat, closingCash,
}: {
  loading: boolean;
  methodTotals: MethodTotal[];
  setMethodTotals: React.Dispatch<React.SetStateAction<MethodTotal[]>>;
  openingFloat: number;
  closingCash: string;
}) {
  if (loading) {
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 mb-4 text-sm text-gray-400">
        Loading today&apos;s sales...
      </div>
    );
  }

  if (methodTotals.length === 0) {
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 mb-4 text-sm text-gray-500">
        No sales recorded yet today at this shop.
      </div>
    );
  }

  function iconForBucket(bucket: MethodTotal["bucket"]) {
    if (bucket === "cash") return <Banknote className="w-4 h-4 text-green-600" />;
    if (bucket === "credit") return <Users className="w-4 h-4 text-amber-600" />;
    // card bucket covers mobile money, card, EFT, online payment links, etc.
    return <Smartphone className="w-4 h-4 text-blue-600" />;
  }

  const cashSales = methodTotals.filter((m) => m.bucket === "cash").reduce((s, m) => s + m.total, 0);
  const electronicSales = methodTotals.filter((m) => m.bucket === "card").reduce((s, m) => s + m.total, 0);
  const creditSales = methodTotals.filter((m) => m.bucket === "credit").reduce((s, m) => s + m.total, 0);
  const totalSales = cashSales + electronicSales + creditSales;

  const expectedCash = openingFloat + cashSales;
  const actualCash = parseFloat(closingCash) || 0;
  const cashVariance = closingCash ? actualCash - expectedCash : null;

  function toggleConfirmed(method: string) {
    setMethodTotals((prev) => prev.map((m) => m.method === method ? { ...m, confirmed: !m.confirmed } : m));
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3">
        Today&apos;s sales by payment method
      </p>
      <div className="space-y-2">
        {methodTotals.map((m) => (
          <div key={m.method} className="flex items-center justify-between py-1.5">
            <div className="flex items-center gap-2 min-w-0">
              {iconForBucket(m.bucket)}
              <span className="text-sm font-medium text-gray-900 truncate">{m.method}</span>
            </div>
            <div className="flex items-center gap-3 flex-shrink-0">
              <span className="text-sm font-semibold text-gray-900">{formatZAR(m.total)}</span>
              {m.bucket === "card" && (
                <label className="inline-flex items-center gap-1.5 text-xs cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={m.confirmed}
                    onChange={() => toggleConfirmed(m.method)}
                    className="w-3.5 h-3.5 text-green-600 border-gray-300 rounded focus:ring-green-500"
                  />
                  <span className={m.confirmed ? "text-green-700 font-medium" : "text-gray-500"}>
                    {m.confirmed ? "Confirmed" : "Confirm?"}
                  </span>
                </label>
              )}
              {m.bucket === "credit" && (
                <span className="text-xs text-gray-400">customer balance</span>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 pt-3 border-t border-gray-100 space-y-1.5">
        <div className="flex justify-between text-sm">
          <span className="text-gray-600">Total sales today</span>
          <span className="font-semibold text-gray-900">{formatZAR(totalSales)}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-600">Opening float</span>
          <span className="text-gray-700">{formatZAR(openingFloat)}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-600">+ Cash sales</span>
          <span className="text-gray-700">{formatZAR(cashSales)}</span>
        </div>
        <div className="flex justify-between text-sm font-semibold pt-1 border-t border-gray-100">
          <span className="text-gray-900">Expected cash in till</span>
          <span className="text-gray-900">{formatZAR(expectedCash)}</span>
        </div>
        {cashVariance !== null && (
          <div className={`rounded-lg px-3 py-2 mt-2 text-sm font-medium flex justify-between ${
            cashVariance === 0 ? "bg-green-50 text-green-700"
              : cashVariance > 0 ? "bg-blue-50 text-blue-700"
              : "bg-red-50 text-red-700"
          }`}>
            <span>Cash variance</span>
            <span>
              {formatZAR(cashVariance)}
              {cashVariance === 0 && " — perfect"}
              {cashVariance > 0 && " — over"}
              {cashVariance < 0 && " — short"}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
