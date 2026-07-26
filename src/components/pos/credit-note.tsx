"use client";
import { forwardRef } from "react";
import { formatMoney } from "@/lib/format";

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

/** Print-optimised credit note. Rendered off-screen, printed via window.print(). */
export const CreditNote = forwardRef<HTMLDivElement, { data: CreditNoteData }>(
  function CreditNote({ data }, ref) {
    const {
      orgName,
      locationName,
      tpin,
      vatPercent,
      creditNoteNumber,
      originalReference,
      issuedAt,
      productName,
      quantity,
      unitPrice,
      refundAmount,
      vatReversed,
      reason,
      refundMode,
    } = data;

    const dateStr = issuedAt.toLocaleDateString("en-ZA", { year: "numeric", month: "short", day: "numeric" });
    const timeStr = issuedAt.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" });
    const exclVat = refundAmount - vatReversed;

    return (
      <div ref={ref} className="cn-root">
        <style>{`
          .cn-root {
            font-family: 'Courier New', Courier, monospace;
            font-size: 11px; line-height: 1.5; color: #000; background: #fff;
            width: 72mm; padding: 4mm; box-sizing: border-box;
          }
          .cn-root * { margin: 0; padding: 0; }
          .cn-header { text-align: center; margin-bottom: 6px; }
          .cn-header h1 { font-size: 16px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 2px; }
          .cn-header p { font-size: 11px; line-height: 1.4; }
          .cn-title {
            font-size: 12px; font-weight: bold; letter-spacing: 2px; margin-top: 6px;
            padding: 2px 8px; border-top: 1px solid #000; border-bottom: 1px solid #000; display: inline-block;
          }
          .cn-divider { border: none; border-top: 1px dashed #000; margin: 6px 0; }
          .cn-divider-double { border: none; border-top: 2px solid #000; margin: 6px 0; }
          .cn-row { display: flex; justify-content: space-between; padding: 1px 0; font-size: 11px; }
          .cn-item-name { font-size: 11px; font-weight: bold; }
          .cn-item-detail { display: flex; justify-content: space-between; font-size: 11px; padding-left: 8px; margin-top: 1px; }
          .cn-total-row { display: flex; justify-content: space-between; font-size: 15px; font-weight: bold; padding: 4px 0; letter-spacing: 0.5px; }
          .cn-note { font-size: 10px; margin-top: 6px; }
          .cn-footer { text-align: center; margin-top: 8px; font-size: 11px; }
          @media print {
            @page { size: 80mm auto; margin: 0; }
          }
        `}</style>

        <div className="cn-header">
          <h1>{orgName}</h1>
          <p>{locationName}</p>
          {tpin && <p>TPIN: {tpin}</p>}
          <p className="cn-title">CREDIT NOTE</p>
        </div>

        <hr className="cn-divider" />

        <div>
          <div className="cn-row"><span>{dateStr}</span><span>{timeStr}</span></div>
          <div className="cn-row"><span>Credit note #:</span><span>{creditNoteNumber}</span></div>
          {originalReference && (
            <div className="cn-row"><span>Against sale:</span><span>{originalReference}</span></div>
          )}
        </div>

        <hr className="cn-divider" />

        <div>
          <div className="cn-item-name">{productName}</div>
          <div className="cn-item-detail">
            <span>{quantity} returned × {formatMoney(unitPrice)}</span>
            <span>{formatMoney(refundAmount)}</span>
          </div>
        </div>

        <hr className="cn-divider-double" />

        <div>
          <div className="cn-total-row">
            <span>{refundMode === "cash" ? "REFUNDED" : "CREDITED"}</span>
            <span>{formatMoney(refundAmount)}</span>
          </div>
          {vatPercent != null && vatPercent > 0 && (
            <>
              <div className="cn-row"><span>Excl. VAT:</span><span>{formatMoney(exclVat)}</span></div>
              <div className="cn-row"><span>VAT reversed ({vatPercent}%):</span><span>{formatMoney(vatReversed)}</span></div>
            </>
          )}
          <div className="cn-row">
            <span>Method:</span>
            <span>{refundMode === "cash" ? "Cash refund" : "Account credited"}</span>
          </div>
        </div>

        {reason && (
          <div className="cn-note">
            <hr className="cn-divider" />
            Reason: {reason}
          </div>
        )}

        <div className="cn-footer">
          <p>Keep this credit note for your records.</p>
          <p style={{ marginTop: 4, color: "#666" }}>Powered by Tilify</p>
        </div>
      </div>
    );
  }
);
