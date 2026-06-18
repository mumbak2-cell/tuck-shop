import { getCurrency, DEFAULT_CURRENCY } from "./currency";

// Active currency symbol, mutated by CurrencyProvider on app boot.
// Default ZAR ("R") preserves the historic behaviour for users who
// have not yet picked a currency in Settings.
let activeSymbol: string = DEFAULT_CURRENCY.symbol;

export function setActiveCurrency(code: string | null | undefined): void {
  activeSymbol = getCurrency(code).symbol;
}

export function getActiveSymbol(): string {
  return activeSymbol;
}

export function formatMoney(amount: number): string {
  return `${activeSymbol}${amount.toFixed(2)}`;
}

// Backwards-compatible alias. Historic name; now multi-currency aware.
export const formatZAR = formatMoney;

export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

export function formatDate(date: string | Date): string {
  return new Date(date).toLocaleDateString("en-ZA", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
