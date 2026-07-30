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
  /** Physical cash handed over, funded by the card charge. Not revenue. */
  cashBack?: number | null;
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

/* ── Thermal-receipt text helpers (32-column, 58 mm paper) ───────── */

export const LINE_WIDTH = 32;

export function centerText(text: string): string {
  const t = text.slice(0, LINE_WIDTH);
  const pad = Math.floor((LINE_WIDTH - t.length) / 2);
  return " ".repeat(pad) + t + " ".repeat(LINE_WIDTH - pad - t.length);
}

export function leftRight(left: string, right: string): string {
  const avail = LINE_WIDTH - right.length;
  if (avail < 2) return right.slice(0, LINE_WIDTH).padEnd(LINE_WIDTH);
  const l = left.slice(0, avail - 1);
  return l + " ".repeat(LINE_WIDTH - l.length - right.length) + right;
}

export function rightAligned(text: string): string {
  return text.padStart(LINE_WIDTH);
}

export function dashes(): string {
  return "-".repeat(LINE_WIDTH);
}

export function equals(): string {
  return "=".repeat(LINE_WIDTH);
}

export function wrapCenter(text: string): string[] {
  if (text.length <= LINE_WIDTH) return [centerText(text)];
  const words = text.split(" ");
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && cur.length + 1 + w.length > LINE_WIDTH) {
      out.push(centerText(cur));
      cur = w;
    } else {
      cur = cur ? cur + " " + w : w;
    }
  }
  if (cur) out.push(centerText(cur));
  return out;
}

export function wrapText(text: string): string[] {
  if (text.length <= LINE_WIDTH) return [text.padEnd(LINE_WIDTH)];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += LINE_WIDTH) {
    out.push(text.slice(i, i + LINE_WIDTH).padEnd(LINE_WIDTH));
  }
  return out;
}

export function wrapLeft(text: string): string[] {
  if (text.length <= LINE_WIDTH) return [text.padEnd(LINE_WIDTH)];
  const words = text.split(" ");
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && cur.length + 1 + w.length > LINE_WIDTH) {
      out.push(cur.padEnd(LINE_WIDTH));
      cur = w;
    } else {
      cur = cur ? cur + " " + w : w;
    }
  }
  if (cur) out.push(cur.padEnd(LINE_WIDTH));
  return out;
}

export function buildReceiptLines(data: ReceiptData): string[] {
  const {
    orgName, locationName, locationAddress, locationPhone,
    items, total, paymentMethod, cashTendered, change, cashBack,
    paymentReference, customerName, customerTpin,
    saleDate, tpin, vatPercent, receiptNumber, zra,
  } = data;

  const WALK_IN_TPIN = "1000000000";
  const lines: string[] = [];

  const dateStr = saleDate.toLocaleDateString("en-ZA", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const timeStr = saleDate.toLocaleTimeString("en-ZA", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const itemCount = items.reduce((s, i) => s + i.quantity, 0);

  // ── Header ──
  lines.push(...wrapCenter(orgName.toUpperCase()));
  lines.push(centerText(locationName));
  if (locationAddress) lines.push(...wrapCenter(locationAddress));
  if (locationPhone) lines.push(centerText("Tel: " + locationPhone));
  if (tpin) {
    lines.push(centerText("TPIN: " + tpin));
    lines.push(centerText("*** TAX INVOICE ***"));
  }
  if (zra) lines.push(centerText("ORIGINAL"));

  lines.push(dashes());

  // ── Date / time / receipt # ──
  lines.push(leftRight(dateStr, timeStr));
  if (receiptNumber) lines.push(leftRight("Rcpt#", receiptNumber));

  lines.push(dashes());

  // ── Line items ──
  for (const item of items) {
    lines.push(...wrapText(item.name));
    const detail = "  " + item.quantity + " x " + formatMoney(item.unitPrice);
    lines.push(leftRight(detail, formatMoney(item.unitPrice * item.quantity)));
  }
  lines.push(rightAligned(itemCount + " item" + (itemCount !== 1 ? "s" : "")));

  lines.push(equals());

  // ── Total + VAT ──
  lines.push(leftRight("TOTAL", formatMoney(total)));
  if (vatPercent != null && vatPercent > 0) {
    const exclVat = total / (1 + vatPercent / 100);
    lines.push(leftRight("Excl. VAT:", formatMoney(exclVat)));
    lines.push(leftRight("VAT (" + vatPercent + "%):", formatMoney(total - exclVat)));
  }

  lines.push(dashes());

  // ── Payment ──
  lines.push(leftRight("Payment:", paymentMethod));
  // Cash back is not revenue, so it sits below TOTAL and is shown alongside
  // the larger figure actually charged to the card.
  if (cashBack != null && cashBack > 0) {
    lines.push(leftRight("Cash back:", formatMoney(cashBack)));
    lines.push(leftRight("Card charge:", formatMoney(total + cashBack)));
  }
  if (cashTendered != null && cashTendered > 0) {
    lines.push(leftRight("Tendered:", formatMoney(cashTendered)));
  }
  if (change != null && change > 0) {
    lines.push(leftRight("Change:", formatMoney(change)));
  }
  if (paymentReference) {
    lines.push(leftRight("Ref No:", paymentReference));
  }
  if (customerName) {
    lines.push(leftRight("Customer:", customerName));
  }

  // ── ZRA fiscal block ──
  if (zra) {
    lines.push(dashes());
    if (zra.sdcId) lines.push(leftRight("SDC ID:", zra.sdcId));
    lines.push(leftRight("Invoice #:", zra.rcptNo));
    if (zra.rcptSign) {
      lines.push("Signature:".padEnd(LINE_WIDTH));
      lines.push(...wrapText(zra.rcptSign));
    }
    if (zra.intrlData) {
      lines.push("Internal:".padEnd(LINE_WIDTH));
      lines.push(...wrapText(zra.intrlData));
    }
    lines.push(dashes());
    lines.push(leftRight("Client:", customerName || "Cash Sales"));
    lines.push(leftRight("TPIN:", customerTpin || WALK_IN_TPIN));
    lines.push(centerText("*** FISCAL RECEIPT ***"));
  }

  lines.push(dashes());

  // ── Footer ──
  lines.push(centerText("Thank you for your purchase!"));
  lines.push("");
  lines.push(centerText(zra ? "ZRA Smart Invoice" : "Powered by Tilify"));

  return lines;
}

/** Print-optimised receipt. Rendered off-screen, printed via window.print(). */
export const Receipt = forwardRef<HTMLDivElement, { data: ReceiptData }>(
  function Receipt({ data }, ref) {
    const lines = buildReceiptLines(data);

    return (
      <div ref={ref} className="receipt-root">
        <style>{`
          .receipt-root {
            font-family: 'Courier New', Courier, monospace;
            color: #000;
            background: #fff;
            box-sizing: border-box;
          }
          .receipt-pre {
            white-space: pre;
            font-family: 'Courier New', Courier, monospace;
            font-size: 12px;
            line-height: 1.5;
            margin: 0;
            padding: 4mm;
          }
          .receipt-qr {
            margin: 4px auto 8px;
            width: 120px;
            height: 120px;
            border: 1px dashed #000;
            display: flex;
            align-items: center;
            justify-content: center;
            text-align: center;
            font-size: 9px;
            font-family: 'Courier New', Courier, monospace;
            line-height: 1.3;
            box-sizing: border-box;
            padding: 4px;
          }
          @media print {
            @page { size: 80mm auto; margin: 0; }
          }
        `}</style>
        <pre className="receipt-pre">{lines.join("\n")}</pre>
        {data.zra && (
          <div className="receipt-qr">ZRA QR CODE<br />(added at go-live)</div>
        )}
      </div>
    );
  }
);
