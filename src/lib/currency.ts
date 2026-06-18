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
