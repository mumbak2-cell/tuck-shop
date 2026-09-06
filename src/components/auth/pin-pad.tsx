"use client";
import { useState, useEffect } from "react";
import { useAuth, tillPinLockoutSeconds } from "@/lib/auth-context";
import { Delete } from "lucide-react";

export function PinPad() {
  const { login } = useAuth();
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit() {
    if (pin.length < 4) return;
    setLoading(true);
    setError(null);
    const success = await login(pin);
    if (!success) {
      const lockSecs = await tillPinLockoutSeconds();
      setError(lockSecs != null
        ? "Too many attempts — try again in a minute"
        : "Incorrect PIN. Try again.");
      setPin("");
    }
    setLoading(false);
  }

  function handleDigit(d: string) {
    if (pin.length >= 6) return;
    setError(null);
    const next = pin + d;
    setPin(next);
    // Auto-submit at 4 digits
    if (next.length === 4) {
      setTimeout(async () => {
        setLoading(true);
        const success = await login(next);
        if (!success) {
          const lockSecs = await tillPinLockoutSeconds();
          setError(lockSecs != null
            ? "Too many attempts — try again in a minute"
            : "Incorrect PIN. Try again.");
          setPin("");
        }
        setLoading(false);
      }, 150);
    }
  }

  function handleBackspace() {
    setPin((p) => p.slice(0, -1));
    setError(null);
  }

  // Hardware-keyboard entry. The on-screen pad stays for touch devices, but
  // typing lets a cashier enter their PIN without the digits being visible to
  // anyone watching the screen. Re-binds on pin/loading so handleDigit's
  // auto-submit-at-4 sees the current value.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (loading) return;
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        handleDigit(e.key);
      } else if (e.key === "Backspace") {
        e.preventDefault();
        handleBackspace();
      } else if (e.key === "Enter") {
        e.preventDefault();
        handleSubmit();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin, loading]);

  const digits = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "back"];

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-green-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-sm">
        <div className="text-center mb-8">
          <img src="/logo.png" alt="Tilify" className="h-16 w-auto rounded-xl mx-auto mb-4" />
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
          <p className="text-center text-sm text-red-600 mb-4">{error}</p>
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
