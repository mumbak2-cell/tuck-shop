// SADC currency catalog. Symbol-only display, symbol before amount.
// Source: ISO 4217. Symbols selected for in-country recognition.

export type CurrencyCode =
  | "ZAR" | "BWP" | "NAD" | "ZMW" | "MZN"
  | "MWK" | "ZWG" | "LSL" | "SZL" | "AOA"
  | "CDF" | "MGA" | "MUR" | "SCR" | "TZS";

export interface Currency {
  code: CurrencyCode;
  symbol: string;
  name: string;
  country: string;
}

export const SADC_CURRENCIES: Currency[] = [
  { code: "ZAR", symbol: "R",   name: "South African Rand",   country: "South Africa" },
  { code: "BWP", symbol: "P",   name: "Botswana Pula",        country: "Botswana" },
  { code: "NAD", symbol: "N$",  name: "Namibian Dollar",      country: "Namibia" },
  { code: "ZMW", symbol: "K",   name: "Zambian Kwacha",       country: "Zambia" },
  { code: "MZN", symbol: "MT",  name: "Mozambican Metical",   country: "Mozambique" },
  { code: "MWK", symbol: "MK",  name: "Malawian Kwacha",      country: "Malawi" },
  { code: "ZWG", symbol: "ZiG", name: "Zimbabwe Gold",        country: "Zimbabwe" },
  { code: "LSL", symbol: "L",   name: "Lesotho Loti",         country: "Lesotho" },
  { code: "SZL", symbol: "E",   name: "Eswatini Lilangeni",   country: "Eswatini" },
  { code: "AOA", symbol: "Kz",  name: "Angolan Kwanza",       country: "Angola" },
  { code: "CDF", symbol: "FC",  name: "Congolese Franc",      country: "DR Congo" },
  { code: "MGA", symbol: "Ar",  name: "Malagasy Ariary",      country: "Madagascar" },
  { code: "MUR", symbol: "₨", name: "Mauritian Rupee",   country: "Mauritius" },
  { code: "SCR", symbol: "₨", name: "Seychellois Rupee", country: "Seychelles" },
  { code: "TZS", symbol: "TSh", name: "Tanzanian Shilling",   country: "Tanzania" },
];

export const DEFAULT_CURRENCY: Currency = SADC_CURRENCIES[0]; // ZAR

export function getCurrency(code: string | null | undefined): Currency {
  return SADC_CURRENCIES.find((c) => c.code === code) || DEFAULT_CURRENCY;
}

// H7 fix: derive phone country code from currency so WhatsApp links
// go to the right country instead of hardcoding +27 (South Africa).
const CURRENCY_TO_PHONE_CODE: Record<string, string> = {
  ZAR: "27",
  BWP: "267",
  NAD: "264",
  ZMW: "260",
  MZN: "258",
  MWK: "265",
  ZWG: "263",
  LSL: "266",
  SZL: "268",
  AOA: "244",
  CDF: "243",
  MGA: "261",
  MUR: "230",
  SCR: "248",
  TZS: "255",
};

/**
 * Convert a local phone number to international format using the org's currency.
 * If the number already starts with the country code or '+', it's returned as-is
 * (digits only). Falls back to +27 (SA) if currency is unknown.
 */
export function toInternationalPhone(localPhone: string, currencyCode: string | null | undefined): string {
  const digits = localPhone.replace(/[^0-9]/g, "");
  const countryCode = CURRENCY_TO_PHONE_CODE[currencyCode ?? ""] ?? "27";
  // If the number starts with 0, replace with the country code
  if (digits.startsWith("0")) return countryCode + digits.slice(1);
  // If it already looks international, return as-is
  return digits;
}
