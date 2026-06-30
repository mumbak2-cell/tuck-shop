// Classify a payment method label into one of three reporting buckets.
//
// Background: in early versions of the app payment methods were the literal
// strings "cash", "card", "credit". Slice 3a added country-aware methods so
// the same field now carries values like "Cash", "iKhokha (Card)", "M-Pesa",
// "Airtel Money", "EFT", "Credit Account", "Yoco", etc.
//
// Reporting pages (Dashboard, Sales, P&L) still want a three-way summary —
// Cash vs. Card/Electronic vs. Credit (deferred payment). Anything that
// settles immediately and isn't physical cash falls into Card/Electronic.

export type PaymentBucket = "cash" | "card" | "credit";

export function paymentBucket(method: string | null | undefined): PaymentBucket {
  const m = (method || "").toLowerCase();
  if (!m) return "cash";
  // Credit-account / "owe me" sales settled later.
  if (m.includes("credit")) return "credit";
  // Physical cash.
  if (m.includes("cash")) return "cash";
  // Everything else: card readers, mobile money, EFT, payment links, QR codes.
  return "card";
}
