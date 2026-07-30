"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { useShift } from "@/lib/shift-context";
import { useOrg } from "@/lib/org-context";
import { db } from "@/lib/supabase";
import { formatZAR, getActiveSymbol } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Clock, Play, Square, Check, Banknote, Smartphone, Users, RotateCcw, Trash2, Calculator, ChevronDown } from "lucide-react";
import Link from "next/link";
import { paymentBucket } from "@/lib/payment-buckets";
import { localToday } from "@/lib/date-utils";

interface MethodTotal {
  method: string;
  total: number;
  bucket: "cash" | "card" | "credit";
  confirmed: boolean;
}

/**
 * Notes and coins a cashier can be holding, largest first, down to 1 unit.
 * Only the currencies we actually trade in are listed; anything else falls
 * back to the ZAR ladder so the counter still works, just with the wrong
 * denominations — add a row here when a new country goes live.
 */
const DENOMINATIONS: Record<string, number[]> = {
  ZAR: [200, 100, 50, 20, 10, 5, 2, 1],
  ZMW: [500, 200, 100, 50, 20, 10, 5, 2, 1],
};

function sumDenominations(denominations: number[], counts: Record<number, string>): number {
  return denominations.reduce((sum, d) => sum + d * (parseInt(counts[d] ?? "", 10) || 0), 0);
}

export default function ShiftPage() {
  const router = useRouter();
  const { name: userName, role } = useAuth();
  const { shift, loading, isOpen, openShift, closeShift, deleteShift, reopenShift } = useShift();
  const { currentLocationId, currentLocationName, currency } = useOrg();

  const [openingFloat, setOpeningFloat] = useState("0");
  const [closingCash, setClosingCash] = useState("");
  const [opening, setOpening] = useState(false);
  const [closing, setClosing] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [methodTotals, setMethodTotals] = useState<MethodTotal[]>([]);
  const [loadingTotals, setLoadingTotals] = useState(false);
  // Cash handed to customers as cash back today — left the drawer without
  // being a sale, so expected cash must come down by it.
  const [cashBackPaidOut, setCashBackPaidOut] = useState(0);
  // Per-branch denomination counter (location_settings). Absence of a row = off.
  // Cached locally so a cashier closing a shift offline still gets the counter.
  const [denomCountEnabled, setDenomCountEnabled] = useState(false);
  // Blind cash-up: the cashier counts the till without being shown what it
  // should hold, so the manager reconciles against an unprompted figure.
  const [blindCashUpEnabled, setBlindCashUpEnabled] = useState(false);

  const isAdmin = role === "admin";
  // Managers always see the full reconciliation — they are the ones checking it.
  const hideCashTotals = blindCashUpEnabled && !isAdmin;

  // Reset the local form inputs whenever the operator switches location so
  // values typed for one shop do not pre-fill at another shop.
  useEffect(() => {
    setOpeningFloat("0");
    setClosingCash("");
  }, [currentLocationId]);

  // Read the branch's shift-close toggles. Cache first so both still work
  // offline; refresh from the server only when we have a line.
  useEffect(() => {
    if (!currentLocationId) return;

    const read = (key: string) => {
      try {
        return window.localStorage.getItem("tilify_" + key + "_" + currentLocationId);
      } catch {
        return null;
      }
    };
    const write = (key: string, enabled: boolean) => {
      try {
        window.localStorage.setItem("tilify_" + key + "_" + currentLocationId, enabled ? "true" : "false");
      } catch {
        // ignore — cache is best-effort
      }
    };

    const cachedDenom = read("denom_count");
    const cachedBlind = read("blind_cash_up");
    setDenomCountEnabled(cachedDenom === "true");
    // The denomination counter is a convenience, so an unknown value is simply
    // off. Blind cash-up is a control, so an unknown value hides the totals
    // rather than revealing them — a never-synced device must not leak the
    // expected cash just because it cannot reach the server.
    setBlindCashUpEnabled(cachedBlind === null ? !navigator.onLine : cachedBlind === "true");

    if (!navigator.onLine) return;
    db.from("location_settings")
      .select("key, value")
      .eq("location_id", currentLocationId)
      .in("key", ["denomination_count_enabled", "blind_cash_up_enabled"])
      .then(({ data }: { data: { key: string; value: string }[] | null }) => {
        const byKey = new Map((data || []).map((r) => [r.key, r.value]));
        const denom = byKey.get("denomination_count_enabled") === "true";
        const blind = byKey.get("blind_cash_up_enabled") === "true";
        setDenomCountEnabled(denom);
        setBlindCashUpEnabled(blind);
        write("denom_count", denom);
        write("blind_cash_up", blind);
      });
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
        .select("total_amount, payment_method, location_id, cash_back")
        .eq("sale_date", today)
        .eq("voided", false)
        .eq("location_id", currentLocationId);
      const sums = new Map<string, number>();
      let paidOut = 0;
      ((data as { total_amount: number; payment_method: string; cash_back: number | null }[]) || []).forEach((s) => {
        const m = (s.payment_method || "Unknown").trim() || "Unknown";
        sums.set(m, (sums.get(m) || 0) + (Number(s.total_amount) || 0));
        // Recorded once per transaction, on its first line, so a plain sum is
        // the day's total rather than a multiple of it.
        paidOut += Number(s.cash_back) || 0;
      });
      setCashBackPaidOut(paidOut);
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
            {!hideCashTotals && (
              <div className="flex justify-between py-2 border-b border-gray-100">
                <span className="text-gray-500">Opening float</span>
                <span className="font-medium text-gray-900">{formatZAR(shift.opening_float)}</span>
              </div>
            )}
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

          {/* That report states the variance outright, so linking to it from
              here would hand back exactly what blind cash-up withholds. */}
          {!hideCashTotals && (
            <div className="mt-6 pt-4 border-t border-gray-100">
              <Link
                href="/revenue-assurance"
                className="flex items-center justify-center gap-2 text-sm text-green-600 hover:underline"
              >
                View Revenue Assurance Report →
              </Link>
            </div>
          )}
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

        {!hideCashTotals && (
          <div className="space-y-3 text-sm mb-6">
            <div className="flex justify-between py-2 border-b border-gray-100">
              <span className="text-gray-500">Opening float</span>
              <span className="font-medium text-gray-900">{formatZAR(shift.opening_float)}</span>
            </div>
          </div>
        )}

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
            hideCashTotals={hideCashTotals}
            cashBackPaidOut={cashBackPaidOut}
          />

          {denomCountEnabled && (
            <DenominationCounter
              key={currentLocationId ?? "none"}
              currency={currency}
              onTotal={(total) => setClosingCash(total > 0 ? total.toFixed(2) : "")}
            />
          )}

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

/**
 * Note-by-note cash counter. Writes the running total up to the close-shift
 * form, which keeps the plain "Closing Cash" box editable — a cashier who
 * would rather count in their head can still ignore this panel.
 */
function DenominationCounter({
  currency,
  onTotal,
}: {
  currency: string | null;
  onTotal: (total: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [counts, setCounts] = useState<Record<number, string>>({});

  const denominations = DENOMINATIONS[currency ?? ""] ?? DENOMINATIONS.ZAR;
  const symbol = getActiveSymbol();
  const total = sumDenominations(denominations, counts);

  function setCount(denomination: number, value: string) {
    const next = { ...counts, [denomination]: value };
    setCounts(next);
    onTotal(sumDenominations(denominations, next));
  }

  return (
    <div className="mb-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-gray-900"
      >
        <Calculator className="w-4 h-4 text-gray-500" />
        Count cash by denomination
        <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="mt-3 border border-gray-200 rounded-xl p-4">
          <div className="space-y-2">
            {denominations.map((d) => {
              const qty = parseInt(counts[d] ?? "", 10) || 0;
              return (
                <div key={d} className="flex items-center gap-3">
                  <span className="w-14 text-sm font-medium text-gray-900">{symbol}{d}</span>
                  <span className="text-sm text-gray-400">×</span>
                  <input
                    type="number"
                    min={0}
                    inputMode="numeric"
                    value={counts[d] ?? ""}
                    onChange={(e) => setCount(d, e.target.value)}
                    onFocus={(e) => e.target.select()}
                    placeholder="0"
                    aria-label={`How many ${symbol}${d}`}
                    className="w-20 h-9 text-center text-sm border border-gray-200 rounded-lg focus:border-green-500 focus:ring-1 focus:ring-green-500 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                  <span className="flex-1 text-right text-sm text-gray-600">
                    {qty > 0 ? formatZAR(d * qty) : "—"}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="flex justify-between items-center pt-3 mt-3 border-t border-gray-200">
            <span className="text-sm font-semibold text-gray-900">Total counted</span>
            <span className="text-lg font-bold text-gray-900">{formatZAR(total)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function ReconciliationPanel({
  loading, methodTotals, setMethodTotals, openingFloat, closingCash, hideCashTotals, cashBackPaidOut,
}: {
  loading: boolean;
  methodTotals: MethodTotal[];
  setMethodTotals: React.Dispatch<React.SetStateAction<MethodTotal[]>>;
  openingFloat: number;
  closingCash: string;
  /** Cash back handed out today, which the till no longer holds. */
  cashBackPaidOut: number;
  /**
   * Blind cash-up. Hides every figure the cashier could work the expected
   * till total back from: the cash takings, the day's total, and the
   * expected/variance block. Card and mobile money stay visible because those
   * are reconciled against the machine slip, not the drawer, and cannot be
   * used to derive the cash figure once the overall total is hidden.
   */
  hideCashTotals: boolean;
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

  const expectedCash = openingFloat + cashSales - cashBackPaidOut;
  const actualCash = parseFloat(closingCash) || 0;
  const cashVariance = closingCash ? actualCash - expectedCash : null;

  function toggleConfirmed(method: string) {
    setMethodTotals((prev) => prev.map((m) => m.method === method ? { ...m, confirmed: !m.confirmed } : m));
  }

  // Cash rows are dropped entirely under blind cash-up rather than blanked,
  // so there is nothing on screen to add up.
  const visibleMethods = hideCashTotals
    ? methodTotals.filter((m) => m.bucket !== "cash")
    : methodTotals;

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3">
        {hideCashTotals ? "Today's non-cash sales" : "Today's sales by payment method"}
      </p>
      {hideCashTotals && visibleMethods.length === 0 && (
        <p className="text-sm text-gray-500">
          Count the cash in the till and enter the total below. Your manager will reconcile it.
        </p>
      )}
      <div className="space-y-2">
        {visibleMethods.map((m) => (
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

      {!hideCashTotals && (
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
        {cashBackPaidOut > 0 && (
          <div className="flex justify-between text-sm">
            <span className="text-gray-600">− Cash back paid out</span>
            <span className="text-gray-700">{formatZAR(cashBackPaidOut)}</span>
          </div>
        )}
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
      )}
    </div>
  );
}
