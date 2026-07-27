"use client";
import { forwardRef } from "react";
import { formatMoney } from "@/lib/format";
import {
  centerText,
  leftRight,
  dashes,
  equals,
  wrapCenter,
  wrapText,
  wrapLeft,
} from "./receipt";

/** Short credit-note number: CN-YYMMDD-HHMM-XXXX (mirrors the receipt number). */
export function generateCreditNoteNumber(date?: Date): string {
  const d = date ?? new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `CN-${yy}${mm}${dd}-${hh}${mi}-${rand}`;
}

export interface CreditNoteData {
  orgName: string;
  locationName: string;
  tpin?: string | null;
  vatPercent?: number | null;
  creditNoteNumber: string;
  /** Time of the original sale, printed as the reference. */
  originalReference?: string | null;
  issuedAt: Date;
  productName: string;
  /** Returned quantity, printed as a positive number. */
  quantity: number;
  unitPrice: number;
  /** Total refunded / credited (positive). */
  refundAmount: number;
  /** Output VAT reversed by this credit note (positive). */
  vatReversed: number;
  reason?: string | null;
  /** "cash" = paid out of the till; "account" = customer balance reduced. */
  refundMode: "cash" | "account";
}

function buildCreditNoteLines(data: CreditNoteData): string[] {
  const {
    orgName, locationName, tpin, vatPercent,
    creditNoteNumber, originalReference, issuedAt,
    productName, quantity, unitPrice, refundAmount,
    vatReversed, reason, refundMode,
  } = data;

  const lines: string[] = [];
  const dateStr = issuedAt.toLocaleDateString("en-ZA", {
    year: "numeric", month: "short", day: "numeric",
  });
  const timeStr = issuedAt.toLocaleTimeString("en-ZA", {
    hour: "2-digit", minute: "2-digit",
  });

  // ── Header ──
  lines.push(...wrapCenter(orgName.toUpperCase()));
  lines.push(centerText(locationName));
  if (tpin) lines.push(centerText("TPIN: " + tpin));
  lines.push(centerText("*** CREDIT NOTE ***"));

  lines.push(dashes());

  // ── Meta ──
  lines.push(leftRight(dateStr, timeStr));
  lines.push(leftRight("CN#", creditNoteNumber));
  if (originalReference) lines.push(leftRight("Sale#", originalReference));

  lines.push(dashes());

  // ── Returned item ──
  lines.push(...wrapText(productName));
  const detail = "  " + quantity + " x " + formatMoney(unitPrice);
  lines.push(leftRight(detail, formatMoney(refundAmount)));

  lines.push(equals());

  // ── Total ──
  const label = refundMode === "cash" ? "REFUNDED" : "CREDITED";
  lines.push(leftRight(label, formatMoney(refundAmount)));
  if (vatPercent != null && vatPercent > 0) {
    const exclVat = refundAmount - vatReversed;
    lines.push(leftRight("Excl. VAT:", formatMoney(exclVat)));
    lines.push(leftRight("VAT reversed (" + vatPercent + "%):", formatMoney(vatReversed)));
  }
  lines.push(leftRight("Method:", refundMode === "cash" ? "Cash refund" : "Account credited"));

  // ── Reason ──
  if (reason) {
    lines.push(dashes());
    lines.push(...wrapLeft("Reason: " + reason));
  }

  lines.push(dashes());

  // ── Footer ──
  lines.push(...wrapCenter("Keep this credit note for your records."));
  lines.push(centerText("Powered by Tilify"));

  return lines;
}

/** Print-optimised credit note. Rendered off-screen, printed via window.print(). */
export const CreditNote = forwardRef<HTMLDivElement, { data: CreditNoteData }>(
  function CreditNote({ data }, ref) {
    const lines = buildCreditNoteLines(data);

    return (
      <div ref={ref} className="cn-root">
        <style>{`
          .cn-root {
            font-family: 'Courier New', Courier, monospace;
            color: #000;
            background: #fff;
            box-sizing: border-box;
          }
          .cn-pre {
            white-space: pre;
            font-family: 'Courier New', Courier, monospace;
            font-size: 12px;
            line-height: 1.5;
            margin: 0;
            padding: 4mm;
          }
          @media print {
            @page { size: 80mm auto; margin: 0; }
          }
        `}</style>
        <pre className="cn-pre">{lines.join("\n")}</pre>
      </div>
    );
  }
);
