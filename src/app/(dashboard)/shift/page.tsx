"use client";
import { useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { useShift } from "@/lib/shift-context";
import { formatZAR } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Clock, Play, Square, ClipboardList, Check, AlertTriangle } from "lucide-react";
import Link from "next/link";

export default function ShiftPage() {
  const { name: userName, role } = useAuth();
  const { shift, loading, isOpen, openShift, closeShift } = useShift();

  const [openingFloat, setOpeningFloat] = useState("0");
  const [closingCash, setClosingCash] = useState("");
  const [opening, setOpening] = useState(false);
  const [closing, setClosing] = useState(false);

  const today = new Date().toLocaleDateString("en-ZA", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  async function handleOpenShift() {
    setOpening(true);
    await openShift(userName, parseFloat(openingFloat) || 0);
    setOpening(false);
  }

  async function handleCloseShift() {
    if (!shift?.stock_count_done) {
      alert("Please complete a stock count before closing the shift. Use Stock Count in the app or import from StockPilot.");
      return;
    }
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

            <div className="bg-gray-50 rounded-lg px-4 py-3 text-sm text-gray-600">
              <p>Yesterday&apos;s closing stock will be used as today&apos;s opening stock for Revenue Assurance.</p>
            </div>

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
          <div className="flex justify-between py-2 border-b border-gray-100">
            <span className="text-gray-500">Stock count done</span>
            <span className={`font-medium ${shift.stock_count_done ? "text-green-600" : "text-amber-600"}`}>
              {shift.stock_count_done ? "Yes ✓" : "Not yet"}
            </span>
          </div>
        </div>

        {/* Close shift section */}
        <div className="border-t border-gray-200 pt-6">
          <h2 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <Square className="w-5 h-5 text-red-500" />
            Close Shift
          </h2>

          {!shift.stock_count_done && (
            <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-4">
              <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" />
              <div className="text-sm text-amber-800">
                <p className="font-medium">Stock count required before closing</p>
                <p className="mt-1">Do a count in the app or import from StockPilot.</p>
                <div className="flex gap-2 mt-3">
                  <Link href="/stock">
                    <Button variant="secondary" size="sm">
                      <ClipboardList className="w-4 h-4 mr-1" /> Stock Count
                    </Button>
                  </Link>
                  <Link href="/stockpilot-import">
                    <Button variant="secondary" size="sm">
                      <ClipboardList className="w-4 h-4 mr-1" /> StockPilot Import
                    </Button>
                  </Link>
                </div>
              </div>
            </div>
          )}

          <div className="space-y-4">
            <Input
              label="Closing Cash in Till (R)"
              type="number"
              step="0.01"
              value={closingCash}
              onChange={(e) => setClosingCash(e.target.value)}
              placeholder="Count the cash and enter total"
            />

            <Button
              onClick={handleCloseShift}
              loading={closing}
              variant={shift.stock_count_done ? "danger" : "secondary"}
              disabled={!shift.stock_count_done}
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
