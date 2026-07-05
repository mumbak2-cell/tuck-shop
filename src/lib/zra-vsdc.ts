/**
 * ZRA Smart Invoice — VSDC (Virtual Sales Data Controller) client.
 *
 * The VSDC is a local Java server (WAR) running on the shop's network that
 * bridges between the POS (CIS) and ZRA's backend. This module wraps the
 * three endpoints Tilify needs for Phase 1:
 *
 *   1. selectInitInfo  — one-time device initialisation
 *   2. saveSales       — submit a sales invoice
 *   3. saveItem        — register / update an item in ZRA's item catalogue
 *
 * All calls are made server-side (Next.js API routes → VSDC), never from the
 * browser. The VSDC URL, TPIN, branch ID, and device serial come from the
 * `zra_config` table in Supabase.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Stored in `zra_config` — everything needed to talk to a VSDC instance. */
export interface VsdcCredentials {
  vsdc_url: string;      // e.g. http://192.168.1.100:8080/zravsdc
  tpin: string;           // 10-digit Taxpayer ID
  bhf_id: string;         // Branch ID, "000" = head office
  device_serial: string;  // Device serial from ZRA
}

/** ZRA tax type codes. */
export type TaxCode = "A" | "B" | "C1" | "D" | "E" | "F" | "RVAT" | "TOT";

/** A single item line in a saveSales request. */
export interface VsdcSaleItem {
  /** Item sequence number (1-based). */
  itemSeq: number;
  /** Item classification code from ZRA. Default "5020230100" for general goods. */
  itemClsCd: string;
  /** Item code (your internal product ID / SKU). */
  itemCd: string;
  /** Item name as shown on invoice. */
  itemNm: string;
  /** Packaging unit code. "NT" = unit, "BG" = bag, "BX" = box. */
  pkgUnitCd: string;
  /** Quantity unit code. "U" = unit. */
  qtyUnitCd: string;
  /** Quantity sold. */
  qty: number;
  /** Unit price (VAT inclusive). */
  prc: number;
  /** Supply amount = qty * prc. */
  splyAmt: number;
  /** Discount amount. */
  dcAmt: number;
  /** Discount rate (0-100). */
  dcRt: number;
  /** Taxable amount (after discount). */
  taxblAmt: number;
  /** Tax type code. */
  taxTyCd: TaxCode;
  /** Tax amount. */
  taxAmt: number;
  /** Total amount = taxblAmt + taxAmt (or just splyAmt - dcAmt for VAT-inclusive). */
  totAmt: number;
}

/** Full saveSales request body. */
export interface VsdcSaveSalesRequest {
  tpin: string;
  bhfId: string;
  /** Original invoice number (for credit notes). Null for normal sales. */
  orgInvcNo: number | null;
  /** Receipt type: "S" = sale, "R" = refund/credit. */
  rcptTyCd: "S" | "R";
  /** Payment type: "01" = cash, "02" = cheque, "03" = EFT/card, "04" = mobile. */
  pmtTyCd: "01" | "02" | "03" | "04";
  /** Sales type: "N" = normal, "C" = copy. */
  salesTyCd: "N" | "C";
  /** Sale status: "02" = approved, "04" = cancelled. */
  salesSttsCd: "02" | "04";
  /** Customer TPIN (null for walk-in). */
  custTpin: string | null;
  /** Customer name. */
  custNm: string | null;
  /** Sale date-time string: yyyyMMddHHmmss. */
  salesDt: string;
  /** Cashier / operator name. */
  regrNm: string;
  /** Same as regrNm for creation. */
  modrNm: string;
  /** Receipt number from POS (your internal receipt #). */
  rcptNo: number;
  /** Invoice items. */
  itemList: VsdcSaleItem[];
  /** Total VAT-taxable amount. */
  taxblAmtA?: number;
  taxblAmtB?: number;
  taxblAmtC1?: number;
  taxblAmtD?: number;
  taxblAmtF?: number;
  taxRtA?: number;
  taxRtB?: number;
  taxRtC1?: number;
  taxRtD?: number;
  taxRtF?: number;
  taxAmtA?: number;
  taxAmtB?: number;
  taxAmtC1?: number;
  taxAmtD?: number;
  taxAmtF?: number;
  totTaxblAmt: number;
  totTaxAmt: number;
  totAmt: number;
  /** Total item count. */
  totItemCnt: number;
}

/** VSDC standard response wrapper. */
export interface VsdcResponse<T = Record<string, unknown>> {
  resultCd: string;   // "000" = success
  resultMsg: string;
  resultDt: string;
  data: T | null;
}

/** Data returned from saveSales on success. */
export interface SaveSalesResult {
  rcptNo: number;      // ZRA-assigned receipt number
  intrlData: string;   // Internal data (for QR code)
  rcptSign: string;    // Receipt signature
  vsdcRcptPbctDate: string;
  sdcId: string;
  mrcNo: string;
}

/** Data returned from selectInitInfo on success. */
export interface InitDeviceResult {
  info: {
    tin: string;
    taxprNm: string;
    bsnsActv: string;
    bhfId: string;
    bhfNm: string;
    dvcSrlNo: string;
  };
}

// ---------------------------------------------------------------------------
// VSDC Client
// ---------------------------------------------------------------------------

const VSDC_TIMEOUT_MS = 15_000;

export class VsdcError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly endpoint: string,
  ) {
    super(`VSDC ${endpoint} [${code}]: ${message}`);
    this.name = "VsdcError";
  }
}

/**
 * Low-level POST to a VSDC endpoint. Handles timeout and error mapping.
 */
async function vsdcPost<T>(
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
): Promise<VsdcResponse<T>> {
  const url = `${baseUrl.replace(/\/+$/, "")}${path}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VSDC_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new VsdcError(
        String(res.status),
        `HTTP ${res.status} ${res.statusText}`,
        path,
      );
    }

    const json = (await res.json()) as VsdcResponse<T>;

    if (json.resultCd !== "000") {
      throw new VsdcError(json.resultCd, json.resultMsg, path);
    }

    return json;
  } catch (err) {
    if (err instanceof VsdcError) throw err;
    if ((err as Error).name === "AbortError") {
      throw new VsdcError("TIMEOUT", "VSDC did not respond within 15s", path);
    }
    throw new VsdcError(
      "NETWORK",
      `Cannot reach VSDC at ${url}: ${(err as Error).message}`,
      path,
    );
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * One-time device initialisation. Call once after first ZRA registration.
 * Returns taxpayer info and confirms the device is registered.
 */
export async function initDevice(
  creds: VsdcCredentials,
): Promise<VsdcResponse<InitDeviceResult>> {
  return vsdcPost<InitDeviceResult>(creds.vsdc_url, "/initializer/selectInitInfo", {
    tpin: creds.tpin,
    bhfId: creds.bhf_id,
    dvcSrlNo: creds.device_serial,
  });
}

/**
 * Submit a sales invoice to ZRA via VSDC.
 * Returns the ZRA receipt number (`rcptNo`) and signature data.
 */
export async function saveSales(
  creds: VsdcCredentials,
  sale: VsdcSaveSalesRequest,
): Promise<VsdcResponse<SaveSalesResult>> {
  return vsdcPost<SaveSalesResult>(creds.vsdc_url, "/trnsSales/saveSales", sale);
}

/**
 * Register or update an item in ZRA's item catalogue.
 * Should be called when a product is created or its tax code changes.
 */
export async function saveItem(
  creds: VsdcCredentials,
  item: {
    itemCd: string;
    itemClsCd: string;
    itemNm: string;
    itemTyCd: "1" | "2" | "3"; // 1=raw, 2=finished, 3=service
    pkgUnitCd: string;
    qtyUnitCd: string;
    taxTyCd: TaxCode;
    dftPrc: number;
    isrcAplcbYn: "Y" | "N"; // insurance applicable
    useYn: "Y" | "N";
  },
): Promise<VsdcResponse> {
  return vsdcPost(creds.vsdc_url, "/items/saveItem", {
    tpin: creds.tpin,
    bhfId: creds.bhf_id,
    ...item,
    regrNm: "Tilify",
    modrNm: "Tilify",
    regrId: "Tilify",
    modrId: "Tilify",
  });
}

// ---------------------------------------------------------------------------
// Helpers — build a saveSales payload from Tilify sale data
// ---------------------------------------------------------------------------

/** Map Tilify payment methods to VSDC payment type codes. */
export function toVsdcPaymentType(
  method: string,
): "01" | "02" | "03" | "04" {
  const m = method.toLowerCase();
  if (m === "cash") return "01";
  if (m === "card" || m === "eft") return "03";
  if (m.includes("mobile") || m.includes("momo") || m.includes("airtel")) return "04";
  return "01"; // default to cash
}

/** Format a JS Date to VSDC's yyyyMMddHHmmss format. */
export function toVsdcDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/**
 * Calculate VAT breakdown for a VAT-inclusive amount.
 * Zambia standard VAT = 16% (tax code B).
 */
export function vatBreakdown(
  inclusiveAmount: number,
  vatRate: number = 16,
): { taxableAmt: number; taxAmt: number } {
  const taxableAmt = Math.round((inclusiveAmount / (1 + vatRate / 100)) * 100) / 100;
  const taxAmt = Math.round((inclusiveAmount - taxableAmt) * 100) / 100;
  return { taxableAmt, taxAmt };
}
