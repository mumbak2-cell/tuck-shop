"use client";
import { forwardRef } from "react";
import { formatMoney } from "@/lib/format";
import { CartItem } from "./cart";

/**
 * Fiscal data returned by the VSDC on a successful saveSales. When present, the
 * receipt prints the full ZRA Smart Invoice fiscal block. Absent = ordinary
 * (non-fiscal) Tilify receipt.
 */
export interface ZraFiscalData {
  /** ZRA-assigned invoice number (printed as "Invoice #"). */
  rcptNo: string;
  /** SDC ID, e.g. SDC0030002973. */
  sdcId?: string | null;
  /** Receipt signature, printed verbatim. */
  rcptSign?: string | null;
  /** Internal data string from the VSDC. */
  intrlData?: string | null;
  /** VSDC receipt publish date-time (yyyyMMddHHmmss). */
  vsdcRcptPbctDate?: string | null;
}

export interface ReceiptData {
  orgName: string;
  locationName: string;
  locationAddress?: string | null;
  locationPhone?: string | null;
  items: CartItem[];
  total: number;
  paymentMethod: string;
  cashTendered?: number | null;
  change?: number | null;
  paymentReference?: string | null;
  customerName?: string | null;
  customerTpin?: string | null;
  saleDate: Date;
  tpin?: string | null;
  vatPercent?: number | null;
  receiptNumber?: string | null;
  /** ZRA Smart Invoice fiscal data (present only once submitted to VSDC). */
  zra?: ZraFiscalData | null;
}

/** Generate a short receipt number from a timestamp: YYMMDD-HHMM-XXXX */
export function generateReceiptNumber(date?: Date): string {
  const d = date ?? new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${yy}${mm}${dd}-${hh}${mi}-${rand}`;
}

/** Print-optimised receipt. Rendered off-screen, printed via window.print(). */
export const Receipt = forwardRef<HTMLDivElement, { data: ReceiptData }>(
  function Receipt({ data }, ref) {
    const {
      orgName,
      locationName,
      locationAddress,
      locationPhone,
      items,
      total,
      paymentMethod,
      cashTendered,
      change,
      paymentReference,
      customerName,
      customerTpin,
      saleDate,
      tpin,
      vatPercent,
      receiptNumber,
      zra,
    } = data;

    // Zambia's walk-in default TPIN when no registered customer is attached.
    const WALK_IN_TPIN = "1000000000";

    const dateStr = saleDate.toLocaleDateString("en-ZA", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    const timeStr = saleDate.toLocaleTimeString("en-ZA", {
      hour: "2-digit",
      minute: "2-digit",
    });

    const itemCount = items.reduce((sum, i) => sum + i.quantity, 0);

    // VAT is charged only on standard-rated lines; a zero-rated item (bread,
    // milk) contributes none. Compute from the taxable subtotal rather than the
    // whole total, so a mixed basket prints the correct VAT — matching the
    // per-line snapshot on `sales` (tax_amount), not a naive back-calc of total.
    const vatRate = vatPercent ?? 0;
    const vatableTotal = items.reduce(
      (sum, i) => sum + (i.zeroRated ? 0 : i.unitPrice * i.quantity),
      0
    );
    const vatAmount = vatRate > 0 ? vatableTotal - vatableTotal / (1 + vatRate / 100) : 0;
    const exclVat = total - vatAmount;

    return (
      <div ref={ref} className="receipt-root">
        <style>{`
          .receipt-root {
            font-family: 'Courier New', Courier, monospace;
            font-size: 11px;
            line-height: 1.5;
            color: #000;
            background: #fff;
            width: 72mm;
            padding: 4mm;
            box-sizing: border-box;
          }
          .receipt-root * { margin: 0; padding: 0; }
          .receipt-header { text-align: center; margin-bottom: 6px; }
          .receipt-header h1 {
            font-size: 16px;
            font-weight: bold;
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 2px;
          }
          .receipt-header p { font-size: 11px; line-height: 1.4; }
          .receipt-subtitle {
            font-size: 11px;
            font-weight: bold;
            letter-spacing: 2px;
            margin-top: 6px;
            padding: 2px 8px;
            border-top: 1px solid #000;
            border-bottom: 1px solid #000;
            display: inline-block;
          }
          .receipt-divider {
            border: none;
            border-top: 1px dashed #000;
            margin: 6px 0;
          }
          .receipt-divider-double {
            border: none;
            border-top: 2px solid #000;
            margin: 6px 0;
          }
          .receipt-meta { font-size: 11px; }
          .receipt-meta-row {
            display: flex;
            justify-content: space-between;
            padding: 1px 0;
          }
          .receipt-items {
            padding: 2px 0;
          }
          .receipt-item {
            padding: 4px 0;
          }
          .receipt-item + .receipt-item {
            border-top: 1px dotted #bbb;
          }
          .receipt-item-name {
            font-size: 11px;
            font-weight: bold;
          }
          .receipt-item-detail {
            display: flex;
            justify-content: space-between;
            font-size: 11px;
            padding-left: 8px;
            margin-top: 1px;
          }
          .receipt-item-count {
            font-size: 10px;
            text-align: right;
            padding-top: 6px;
            margin-top: 4px;
            border-top: 1px dashed #000;
          }
          .receipt-total-section {
            padding: 4px 0;
          }
          .receipt-total-row {
            display: flex;
            justify-content: space-between;
            font-size: 16px;
            font-weight: bold;
            padding: 4px 0;
            letter-spacing: 0.5px;
          }
          .receipt-vat { font-size: 11px; margin-top: 4px; }
          .receipt-vat div {
            display: flex;
            justify-content: space-between;
            padding: 1px 0;
          }
          .receipt-payment { font-size: 11px; }
          .receipt-payment div {
            display: flex;
            justify-content: space-between;
            padding: 1px 0;
          }
          .receipt-footer {
            text-align: center;
            margin-top: 8px;
            font-size: 11px;
          }
          .receipt-footer p { margin-top: 2px; }
          .receipt-receipt-no {
            font-size: 10px;
            margin-top: 6px;
          }
          .receipt-original {
            font-size: 11px;
            font-weight: bold;
            letter-spacing: 3px;
            margin-top: 2px;
          }
          .receipt-fiscal-word {
            font-size: 8px;
            word-break: break-all;
            text-align: right;
          }
          .receipt-fiscal-marker {
            text-align: center;
            font-size: 12px;
            font-weight: bold;
            letter-spacing: 1px;
            margin: 6px 0;
          }
          .receipt-qr {
            margin: 8px auto;
            width: 120px;
            height: 120px;
            border: 1px dashed #000;
            display: flex;
            align-items: center;
            justify-content: center;
            text-align: center;
            font-size: 9px;
            line-height: 1.3;
            box-sizing: border-box;
            padding: 4px;
          }

          @media print {
            @page { size: 80mm auto; margin: 0; }
            body * { visibility: hidden !important; }
            .receipt-print-container,
            .receipt-print-container * { visibility: visible !important; }
            .receipt-print-container {
              position: absolute;
              left: 0;
              top: 0;
              width: 80mm;
            }
          }
        `}</style>

        {/* Header */}
        <div className="receipt-header">
          <h1>{orgName}</h1>
          <p>{locationName}</p>
          {locationAddress && <p>{locationAddress}</p>}
          {locationPhone && <p>Tel: {locationPhone}</p>}
          {tpin && <p>TPIN: {tpin}</p>}
          {tpin && <p className="receipt-subtitle">TAX INVOICE</p>}
          {zra && <p className="receipt-original">ORIGINAL</p>}
        </div>

        <hr className="receipt-divider" />

        {/* Date/Time + Receipt # */}
        <div className="receipt-meta">
          <div className="receipt-meta-row">
            <span>{dateStr}</span>
            <span>{timeStr}</span>
          </div>
          {receiptNumber && (
            <div className="receipt-meta-row">
              <span>Receipt #:</span>
              <span>{receiptNumber}</span>
            </div>
          )}
        </div>

        <hr className="receipt-divider" />

        {/* Line items — no header row, self-evident */}
        <div className="receipt-items">
          {items.map((item, i) => (
            <div key={i} className="receipt-item">
              <div className="receipt-item-name">{item.name}</div>
              <div className="receipt-item-detail">
                <span>{item.quantity} × {formatMoney(item.unitPrice)}</span>
                <span>{formatMoney(item.unitPrice * item.quantity)}</span>
              </div>
            </div>
          ))}
          <div className="receipt-item-count">
            {itemCount} item{itemCount !== 1 ? "s" : ""}
          </div>
        </div>

        <hr className="receipt-divider-double" />

        {/* Total + VAT breakdown */}
        <div className="receipt-total-section">
          <div className="receipt-total-row">
            <span>TOTAL</span>
            <span>{formatMoney(total)}</span>
          </div>
          {vatPercent != null && vatPercent > 0 && (
            <div className="receipt-vat">
              <div>
                <span>Excl. VAT:</span>
                <span>{formatMoney(exclVat)}</span>
              </div>
              <div>
                <span>VAT ({vatPercent}%):</span>
                <span>{formatMoney(vatAmount)}</span>
              </div>
            </div>
          )}
        </div>

        <hr className="receipt-divider" />

        {/* Payment details */}
        <div className="receipt-payment">
          <div>
            <span>Payment:</span>
            <span>{paymentMethod}</span>
          </div>
          {cashTendered != null && cashTendered > 0 && (
            <div>
              <span>Tendered:</span>
              <span>{formatMoney(cashTendered)}</span>
            </div>
          )}
          {change != null && change > 0 && (
            <div style={{ fontWeight: "bold" }}>
              <span>Change:</span>
              <span>{formatMoney(change)}</span>
            </div>
          )}
          {paymentReference && (
            <div>
              <span>Ref No:</span>
              <span>{paymentReference}</span>
            </div>
          )}
          {customerName && (
            <div>
              <span>Customer:</span>
              <span>{customerName}</span>
            </div>
          )}
        </div>

        {/* ZRA Smart Invoice fiscal block — only when submitted to the VSDC */}
        {zra && (
          <>
            <hr className="receipt-divider" />
            <div className="receipt-meta">
              {zra.sdcId && (
                <div className="receipt-meta-row">
                  <span>SDC ID:</span>
                  <span>{zra.sdcId}</span>
                </div>
              )}
              <div className="receipt-meta-row">
                <span>Invoice #:</span>
                <span>{zra.rcptNo}</span>
              </div>
              {zra.rcptSign && (
                <div className="receipt-meta-row">
                  <span>Signature:</span>
                  <span className="receipt-fiscal-word">{zra.rcptSign}</span>
                </div>
              )}
              {zra.intrlData && (
                <div className="receipt-meta-row">
                  <span>Internal:</span>
                  <span className="receipt-fiscal-word">{zra.intrlData}</span>
                </div>
              )}
            </div>

            <hr className="receipt-divider" />
            <div className="receipt-meta">
              <div className="receipt-meta-row">
                <span>Client Name:</span>
                <span>{customerName || "Cash Sales"}</span>
              </div>
              <div className="receipt-meta-row">
                <span>TPIN:</span>
                <span>{customerTpin || WALK_IN_TPIN}</span>
              </div>
            </div>

            <p className="receipt-fiscal-marker">*** FISCAL RECEIPT ***</p>

            {/*
              TODO (ZRA go-live): render the scannable verification QR here.
              The exact payload ZRA expects must be confirmed against a real
              VSDC response during the first live invoice test — until then
              this is a marked placeholder so the layout is final.
            */}
            <div className="receipt-qr">ZRA QR CODE<br />(added at go-live)</div>
          </>
        )}

        <hr className="receipt-divider" />

        {/* Footer */}
        <div className="receipt-footer">
          <p>Thank you for your purchase!</p>
          <p className="receipt-receipt-no">
            {zra ? "Powered by ZRA Smart Invoice" : "Powered by Tilify"}
          </p>
        </div>
      </div>
    );
  }
);
