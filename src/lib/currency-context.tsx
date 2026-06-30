"use client";
import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { db } from "@/lib/supabase";
import { setActiveCurrency } from "@/lib/format";
import {
  SADC_CURRENCIES,
  DEFAULT_CURRENCY,
  getCurrency,
  type CurrencyCode,
} from "@/lib/currency";

const CACHE_KEY = "tilify_currency";

interface CurrencyState {
  code: CurrencyCode;
  symbol: string;
}

const CurrencyContext = createContext<CurrencyState>({
  code: DEFAULT_CURRENCY.code,
  symbol: DEFAULT_CURRENCY.symbol,
});

export function useCurrency() {
  return useContext(CurrencyContext);
}

export function CurrencyProvider({ children }: { children: ReactNode }) {
  // Read cached choice synchronously so the first render uses the right symbol.
  const [state, setState] = useState<CurrencyState>(() => {
    if (typeof window === "undefined") {
      return { code: DEFAULT_CURRENCY.code, symbol: DEFAULT_CURRENCY.symbol };
    }
    const cached = window.localStorage.getItem(CACHE_KEY);
    const c = getCurrency(cached);
    setActiveCurrency(c.code);
    return { code: c.code, symbol: c.symbol };
  });

  // Refresh from app_settings in case the operator changed it on another device.
  useEffect(() => {
    db.from("app_settings")
      .select("value")
      .eq("key", "currency")
      .single()
      .then(({ data }: { data: { value: string } | null }) => {
        const code = (data?.value as CurrencyCode) || DEFAULT_CURRENCY.code;
        if (code !== state.code) {
          const c = getCurrency(code);
          setActiveCurrency(c.code);
          setState({ code: c.code, symbol: c.symbol });
          try {
            window.localStorage.setItem(CACHE_KEY, c.code);
          } catch {
            // ignore
          }
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <CurrencyContext.Provider value={state}>{children}</CurrencyContext.Provider>
  );
}

export { SADC_CURRENCIES };
export const CURRENCY_CACHE_KEY = CACHE_KEY;
