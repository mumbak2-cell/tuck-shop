"use client";
import { forwardRef } from "react";
import { formatMoney } from "@/lib/format";
import { CartItem } from "./cart";

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
  saleDate: Date;
  tpin?: string | null;
  vatPercent?: number | null;
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
      saleDate,
      tpin,
      vatPercent,
    } = data;

    const dateStr = saleDate.toLocaleDateString("en-ZA", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    const timeStr = saleDate.toLocaleTimeString("en-ZA", {
      hour: "2-digit",
      minute: "2-digit",
    });

    return (
      <div ref={ref} className="receipt-root">
        <style>{`
          .receipt-root {
            font-family: 'Courier New', Courier, monospace;
            font-size: 12px;
            line-height: 1.4;
            color: #000;
            background: #fff;
            width: 72mm;
            padding: 4mm;
            box-sizing: border-box;
          }
          .receipt-root * { margin: 0; padding: 0; }
          .receipt-header { text-align: center; margin-bottom: 8px; }
          .receipt-header h1 { font-size: 16px; font-weight: bold; margin-bottom: 2px; }
          .receipt-header p { font-size: 11px; color: #333; }
          .receipt-divider { border: none; border-top: 1px dashed #000; margin: 6px 0; }
          .receipt-meta { font-size: 11px; display: flex; justify-content: space-between; }
          .receipt-items { width: 100%; border-collapse: collapse; margin: 4px 0; }
          .receipt-items th { text-align: left; font-size: 11px; border-bottom: 1px solid #000; padding: 2px 0; }
          .receipt-items th:last-child { text-align: right; }
          .receipt-items td { font-size: 11px; padding: 2px 0; vertical-align: top; }
          .receipt-items td:last-child { text-align: right; white-space: nowrap; }
          .receipt-items .item-detail { font-size: 10px; color: #555; }
          .receipt-total-row { display: flex; justify-content: space-between; font-size: 13px; font-weight: bold; padding: 4px 0; }
          .receipt-payment { font-size: 11px; margin-top: 4px; }
          .receipt-payment div { display: flex; justify-content: space-between; padding: 1px 0; }
          .receipt-footer { text-align: center; margin-top: 10px; font-size: 11px; }
          .receipt-footer p { margin-top: 2px; }

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
        </div>

        <hr className="receipt-divider" />

        {/* Date/Time */}
        <div className="receipt-meta">
          <span>{dateStr}</span>
          <span>{timeStr}</span>
        </div>

        <hr className="receipt-divider" />

        {/* Line items */}
        <table className="receipt-items">
          <thead>
            <tr>
              <th>Item</th>
              <th style={{ textAlign: "right" }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, i) => (
              <tr key={i}>
                <td>
                  {item.name}
                  <br />
                  <span className="item-detail">
                    {item.quantity} × {formatMoney(item.unitPrice)}
                  </span>
                </td>
                <td>{formatMoney(item.unitPrice * item.quantity)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <hr className="receipt-divider" />

        {/* Total + VAT breakdown */}
        <div className="receipt-total-row">
          <span>TOTAL</span>
          <span>{formatMoney(total)}</span>
        </div>
        {vatPercent != null && vatPercent > 0 && (
          <div className="receipt-payment" style={{ marginTop: 0 }}>
            <div>
              <span>Excl. VAT:</span>
              <span>{formatMoney(total / (1 + vatPercent / 100))}</span>
            </div>
            <div>
              <span>VAT ({vatPercent}%):</span>
              <span>{formatMoney(total - total / (1 + vatPercent / 100))}</span>
            </div>
          </div>
        )}

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
              <span>Ref:</span>
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

        <hr className="receipt-divider" />

        {/* Footer */}
        <div className="receipt-footer">
          <p>Thank you for your purchase!</p>
          <p style={{ fontSize: "10px", color: "#888", marginTop: "6px" }}>
            Powered by Tilify
          </p>
        </div>
      </div>
    );
  }
);
