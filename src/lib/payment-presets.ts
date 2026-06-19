// Country-aware POS payment method presets, keyed by ISO 4217 currency code.
// The /setup wizard derives the country from the chosen currency and
// suggests the methods customers in that market actually use. The
// operator can add, edit, or delete any of these before saving.

export type PaymentKind = "cash" | "card" | "credit" | "mobile_money" | "eft" | "other";

export interface PaymentMethodPreset {
  name: string;
  kind: PaymentKind;
}

// Generic methods every shop needs, regardless of country.
const UNIVERSAL: PaymentMethodPreset[] = [
  { name: "Cash", kind: "cash" },
  { name: "Card", kind: "card" },
  { name: "Credit Account", kind: "credit" },
  { name: "EFT", kind: "eft" },
];

// Country-specific mobile money providers, keyed by currency code.
// Sources: research on dominant providers per SADC market in 2025/2026.
export const PAYMENT_PRESETS_BY_CURRENCY: Record<string, PaymentMethodPreset[]> = {
  // South Africa - cards dominant, mobile money limited
  ZAR: [
    { name: "Cash", kind: "cash" },
    { name: "iKhokha (Card)", kind: "card" },
    { name: "Yoco (Card)", kind: "card" },
    { name: "SnapScan", kind: "mobile_money" },
    { name: "Zapper", kind: "mobile_money" },
    { name: "Credit Account", kind: "credit" },
    { name: "EFT", kind: "eft" },
  ],

  // Malawi
  MWK: [
    { name: "Cash", kind: "cash" },
    { name: "Airtel Money", kind: "mobile_money" },
    { name: "TNM Mpamba", kind: "mobile_money" },
    { name: "Card", kind: "card" },
    { name: "Credit Account", kind: "credit" },
    { name: "EFT", kind: "eft" },
  ],

  // Zimbabwe
  ZWG: [
    { name: "Cash (USD)", kind: "cash" },
    { name: "EcoCash", kind: "mobile_money" },
    { name: "OneMoney", kind: "mobile_money" },
    { name: "InnBucks", kind: "mobile_money" },
    { name: "Card", kind: "card" },
    { name: "Credit Account", kind: "credit" },
  ],

  // Zambia
  ZMW: [
    { name: "Cash", kind: "cash" },
    { name: "MTN MoMo", kind: "mobile_money" },
    { name: "Airtel Money", kind: "mobile_money" },
    { name: "Zamtel Kwacha", kind: "mobile_money" },
    { name: "Card", kind: "card" },
    { name: "Credit Account", kind: "credit" },
    { name: "EFT", kind: "eft" },
  ],

  // Mozambique
  MZN: [
    { name: "Cash", kind: "cash" },
    { name: "M-Pesa", kind: "mobile_money" },
    { name: "mKesh", kind: "mobile_money" },
    { name: "e-Mola", kind: "mobile_money" },
    { name: "Card", kind: "card" },
    { name: "Credit Account", kind: "credit" },
  ],

  // Botswana
  BWP: [
    { name: "Cash", kind: "cash" },
    { name: "Orange Money", kind: "mobile_money" },
    { name: "Mascom MyZaka", kind: "mobile_money" },
    { name: "Smega", kind: "mobile_money" },
    { name: "Card", kind: "card" },
    { name: "Credit Account", kind: "credit" },
    { name: "EFT", kind: "eft" },
  ],

  // Namibia - card dominant, mobile money emerging
  NAD: [
    { name: "Cash", kind: "cash" },
    { name: "MTC e-Wallet", kind: "mobile_money" },
    { name: "Card", kind: "card" },
    { name: "Credit Account", kind: "credit" },
    { name: "EFT", kind: "eft" },
  ],

  // Tanzania
  TZS: [
    { name: "Cash", kind: "cash" },
    { name: "M-Pesa", kind: "mobile_money" },
    { name: "Tigo Pesa", kind: "mobile_money" },
    { name: "Airtel Money", kind: "mobile_money" },
    { name: "HaloPesa", kind: "mobile_money" },
    { name: "Card", kind: "card" },
    { name: "Credit Account", kind: "credit" },
  ],

  // Lesotho
  LSL: [
    { name: "Cash", kind: "cash" },
    { name: "Vodacom M-Pesa", kind: "mobile_money" },
    { name: "EcoCash", kind: "mobile_money" },
    { name: "Card", kind: "card" },
    { name: "Credit Account", kind: "credit" },
  ],

  // Eswatini
  SZL: [
    { name: "Cash", kind: "cash" },
    { name: "MTN MoMo", kind: "mobile_money" },
    { name: "eMali", kind: "mobile_money" },
    { name: "Card", kind: "card" },
    { name: "Credit Account", kind: "credit" },
  ],

  // Angola
  AOA: [
    { name: "Cash", kind: "cash" },
    { name: "Multicaixa Express", kind: "mobile_money" },
    { name: "Unitel Money", kind: "mobile_money" },
    { name: "Card", kind: "card" },
    { name: "Credit Account", kind: "credit" },
  ],

  // DRC
  CDF: [
    { name: "Cash", kind: "cash" },
    { name: "M-Pesa (Vodacom)", kind: "mobile_money" },
    { name: "Airtel Money", kind: "mobile_money" },
    { name: "Orange Money", kind: "mobile_money" },
    { name: "Card", kind: "card" },
    { name: "Credit Account", kind: "credit" },
  ],

  // Madagascar
  MGA: [
    { name: "Cash", kind: "cash" },
    { name: "Orange Money", kind: "mobile_money" },
    { name: "Mvola", kind: "mobile_money" },
    { name: "Airtel Money", kind: "mobile_money" },
    { name: "Card", kind: "card" },
    { name: "Credit Account", kind: "credit" },
  ],

  // Mauritius - card dominant
  MUR: [
    { name: "Cash", kind: "cash" },
    { name: "MyT Money", kind: "mobile_money" },
    { name: "juice (MCB)", kind: "mobile_money" },
    { name: "Card", kind: "card" },
    { name: "Credit Account", kind: "credit" },
    { name: "EFT", kind: "eft" },
  ],

  // Seychelles - card dominant
  SCR: [
    { name: "Cash", kind: "cash" },
    { name: "Card", kind: "card" },
    { name: "Credit Account", kind: "credit" },
    { name: "EFT", kind: "eft" },
  ],
};

export function getPaymentPresetsForCurrency(currency: string): PaymentMethodPreset[] {
  return PAYMENT_PRESETS_BY_CURRENCY[currency] ?? UNIVERSAL;
}
