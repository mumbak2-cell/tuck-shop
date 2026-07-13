"use client";
import { useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { Lock, Delete } from "lucide-react";

export function PinPad() {
  const { login } = useAuth();
  const [pin, setPin] = useState("");
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit() {
    if (pin.length < 4) return;
    setLoading(true);
    setError(false);
    const success = await login(pin);
    if (!success) {
      setError(true);
      setPin("");
    }
    setLoading(false);
  }

  function handleDigit(d: string) {
    if (pin.length >= 6) return;
    setError(false);
    const next = pin + d;
    setPin(next);
    // Auto-submit at 4 digits
    if (next.length === 4) {
      setTimeout(async () => {
        setLoading(true);
        const success = await login(next);
        if (!success) {
          setError(true);
          setPin("");
        }
        setLoading(false);
      }, 150);
    }
  }

  function handleBackspace() {
    setPin((p) => p.slice(0, -1));
    setError(false);
  }

  const digits = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "back"];

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-green-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <Lock className="w-8 h-8 text-green-600" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Tilify</h1>
          <p className="text-sm text-gray-500 mt-1">Enter your PIN to continue</p>
        </div>

        {/* PIN dots */}
        <div className="flex justify-center gap-3 mb-6">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className={`w-4 h-4 rounded-full border-2 transition-all ${
                pin.length > i
                  ? error
                    ? "bg-red-500 border-red-500"
                    : "bg-green-500 border-green-500"
                  : error
                  ? "border-red-300"
                  : "border-gray-300"
              }`}
            />
          ))}
        </div>

        {error && (
          <p className="text-center text-sm text-red-600 mb-4">
            Incorrect PIN. Try again.
          </p>
        )}

        {/* Digit grid */}
        <div className="grid grid-cols-3 gap-3">
          {digits.map((d, i) => {
            if (d === "") return <div key={i} />;
            if (d === "back") {
              return (
                // aria-label rather than a tooltip: this is a touch-first PIN
                // pad, where a hover tooltip would never appear anyway.
                <button
                  key={i}
                  onClick={handleBackspace}
                  aria-label="Delete last digit"
                  className="h-14 rounded-xl flex items-center justify-center text-gray-500 hover:bg-gray-100 transition-colors touch-manipulation"
                >
                  <Delete className="w-6 h-6" />
                </button>
              );
            }
            return (
              <button
                key={i}
                onClick={() => handleDigit(d)}
                disabled={loading}
                className="h-14 rounded-xl bg-gray-50 text-xl font-semibold text-gray-900 hover:bg-gray-100 active:bg-gray-200 transition-colors touch-manipulation disabled:opacity-50"
              >
                {d}
              </button>
            );
          })}
        </div>

        <p className="text-center text-xs text-gray-400 mt-6">
          Admin or Cashier PIN
        </p>
      </div>
    </div>
  );
}
