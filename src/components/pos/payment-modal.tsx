"use client";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/format";
import { db } from "@/lib/supabase";
import { useOrg } from "@/lib/org-context";
import { useOnline } from "@/lib/use-online";
import { readCache } from "@/lib/offline-store";
import { submitSaleBatch } from "@/lib/offline-ops";
import { toInternationalPhone } from "@/lib/currency";
import { CartItem } from "./cart";
import { Customer } from "@/types/database";
import {
  Banknote,
  CreditCard,
  Users,
  Check,
  MessageCircle,
  Smartphone,
  Building2,
  CircleDollarSign,
  CloudOff,
  Printer,
} from "lucide-react";
import { Receipt, ReceiptData, ZraFiscalData, generateReceiptNumber } from "./receipt";

type PaymentKind = "cash" | "card" | "credit" | "mobile_money" | "eft" | "other";

interface PaymentMethodRow {
  id: string;
  name: string;
  kind: PaymentKind;
  sort_order: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  items: CartItem[];
  total: number;
  onComplete: () => void;
}

const KIND_ICON: Record<PaymentKind, React.ElementType> = {
  cash: Banknote,
  card: CreditCard,
  credit: Users,
  mobile_money: Smartphone,
  eft: Building2,
  other: CircleDollarSign,
};

const KIND_COLOR: Record<PaymentKind, string> = {
  cash: "border-green-500 bg-green-50 text-green-700",
  card: "border-blue-500 bg-blue-50 text-blue-700",
  credit: "border-amber-500 bg-amber-50 text-amber-700",
  mobile_money: "border-purple-500 bg-purple-50 text-purple-700",
  eft: "border-indigo-500 bg-indigo-50 text-indigo-700",
  other: "border-gray-500 bg-gray-50 text-gray-700",
};

export function PaymentModal({ open, onClose, items, total, onComplete }: Props) {
  const orgState = useOrg();
  const { currentLocationId, orgId } = orgState;
  const online = useOnline();
  const [methods, setMethods] = useState<PaymentMethodRow[]>([]);
  const [methodsLoaded, setMethodsLoaded] = useState(false);
  const [methodsError, setMethodsError] = useState(false);
  const [queuedToast, setQueuedToast] = useState(false);
  const [selectedMethodId, setSelectedMethodId] = useState<string | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<string>("");
  const [cashTendered, setCashTendered] = useState<string>("");
  const [paymentReference, setPaymentReference] = useState<string>("");
  const [processing, setProcessing] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");

  // --- WhatsApp receipt state ---
  const [whatsAppPhone, setWhatsAppPhone] = useState("");
  const [showWhatsAppInput, setShowWhatsAppInput] = useState(false);
  const [zraFiscal, setZraFiscal] = useState<ZraFiscalData | null>(null);

  useEffect(() => {
    if (open) {
      setSelectedMethodId(null);
      setSelectedCustomer("");
      setCashTendered("");
      setPaymentReference("");
      setSuccess(false);
      setError("");
      setMethodsLoaded(false);
      setMethodsError(false);
      setQueuedToast(false);
      setShowWhatsAppInput(false);
      setWhatsAppPhone("");
      setZraFiscal(null);

      const cachedMethods = orgId
        ? (readCache<PaymentMethodRow>(orgId, "payment_methods") ?? [])
            .filter((m) => (m as PaymentMethodRow & { active?: boolean }).active !== false)
            .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
        : [];
      const cachedCustomers = orgId
        ? (readCache<Customer & { location_id?: string | null }>(orgId, "customers") ?? [])
            .filter((c) => !currentLocationId || !c.location_id || c.location_id === currentLocationId)
            .sort((a, b) => a.name.localeCompare(b.name))
        : [];

      if (!navigator.onLine) {
        setMethods(cachedMethods);
        setCustomers(cachedCustomers);
        setMethodsLoaded(true);
        return;
      }

      const methodsRequest = db
        .from("payment_methods")
        .select("id, name, kind, sort_order")
        .eq("active", true)
        .order("sort_order");
      const timeout = new Promise<{ data: null; error: { message: string } }>((resolve) => {
        setTimeout(() => resolve({ data: null, error: { message: "timeout" } }), 4000);
      });

      Promise.race([methodsRequest, timeout]).then((result) => {
        const { data, error: err } = result as { data: PaymentMethodRow[] | null; error: { message: string } | null };
        if (err && cachedMethods.length > 0) {
          setMethods(cachedMethods);
        } else if (err) {
          setMethodsError(true);
        } else {
          setMethods(data && data.length > 0 ? data : cachedMethods);
        }
        setMethodsLoaded(true);
      });

      let customerQuery = db.from("customers").select("*").order("name");
      if (currentLocationId) customerQuery = customerQuery.eq("location_id", currentLocationId);
      const customerTimeout = new Promise<{ data: null }>((resolve) => {
        setTimeout(() => resolve({ data: null }), 4000);
      });
      Promise.race([customerQuery, customerTimeout]).then((result) => {
        const { data } = result as { data: Customer[] | null };
        setCustomers(data && data.length > 0 ? data : cachedCustomers);
      });
    }
  }, [open, currentLocationId, orgId]);

  const receiptRef = useRef<HTMLDivElement>(null);

  const selectedMethod = methods.find((m) => m.id === selectedMethodId) || null;
  const selectedKind = selectedMethod?.kind ?? null;

  const buildReceiptData = useCallback((): ReceiptData | null => {
    const loc = (currentLocationId && orgState.locations)
      ? orgState.locations.find((l: { id: string }) => l.id === currentLocationId)
      : null;
    if (!selectedMethod) return null;
    const tendered = cashTendered ? parseFloat(cashTendered) : null;
    const customer = selectedKind === "credit"
      ? customers.find((c) => c.id === selectedCustomer)
      : null;
    return {
      orgName: orgState.orgName ?? "Shop",
      locationName: loc?.name ?? "",
      locationAddress: loc?.address,
      locationPhone: loc?.phone,
      items,
      total,
      paymentMethod: selectedMethod.name,
      cashTendered: tendered,
      change: tendered != null && tendered > total ? tendered - total : null,
      paymentReference: paymentReference || null,
      customerName: customer?.name ?? null,
      customerTpin: (customer as { tpin?: string | null } | null | undefined)?.tpin ?? null,
      saleDate: new Date(),
      tpin: orgState.tpin,
      vatPercent: orgState.vatPercent,
      receiptNumber: generateReceiptNumber(),
      zra: zraFiscal,
    };
  }, [currentLocationId, orgState, selectedMethod, selectedKind, cashTendered, customers, selectedCustomer, items, total, paymentReference, zraFiscal]);

  function handlePrintReceipt() {
    const el = receiptRef.current;
    if (!el) return;
    const printWindow = window.open("", "_blank", "width=350,height=600");
    if (!printWindow) return;
    printWindow.document.write(
      "<!DOCTYPE html><html><head><title>Receipt</title>" +
      "<style>body{margin:0;padding:0}@page{size:80mm auto;margin:0}</style>" +
      "</head><body>" + el.innerHTML + "</body></html>"
    );
    printWindow.document.close();
    setTimeout(() => {
      printWindow.print();
      printWindow.close();
    }, 300);
  }

  async function handlePay() {
    if (!selectedMethod) return;
    if (selectedKind === "credit" && !selectedCustomer) {
      setError("Please select a customer for credit sale.");
      return;
    }
    if (!orgId || !currentLocationId) {
      setError("Shop not loaded yet. Try again in a moment.");
      return;
    }

    setProcessing(true);
    setError("");

    const result = await submitSaleBatch({
      org_id: orgId,
      location_id: currentLocationId,
      payment_method: selectedMethod.name,
      payment_reference: paymentReference.trim() || null,
      customer_id: selectedKind === "credit" ? selectedCustomer : null,
      sale_date: new Date().toISOString().split("T")[0],
      created_at: new Date().toISOString(),
      lines: items.map((item) => ({
        product_id: item.productId,
        quantity: item.quantity,
        unit_price: item.unitPrice,
        total_amount: item.unitPrice * item.quantity,
        cost_price: item.costPrice,
      })),
    });

    setProcessing(false);

    if (!result.ok) {
      setError(result.error || "Failed to process sale");
      return;
    }

    if (result.queued) {
      setQueuedToast(true);
    }

    setSuccess(true);

    // --- ZRA Smart Invoice submission (non-blocking) ---
    // Fire after the sale succeeds. If VSDC is unreachable, the sale still
    // stands — the ZRA invoice can be retried from the admin panel.
    if (online && !result.queued && result.sale_ids?.[0]) {
      const saleId = result.sale_ids[0];
      const receiptNo = generateReceiptNumber();
      submitToZra({
        saleId,
        items: items.map((item) => ({
          productId: item.productId,
          name: item.name,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        })),
        total,
        paymentMethod: selectedMethod.name,
        customerName: selectedKind === "credit"
          ? customers.find((c) => c.id === selectedCustomer)?.name ?? null
          : null,
        saleDate: new Date().toISOString(),
        receiptNo,
      }).then((fiscal) => {
        if (fiscal) setZraFiscal(fiscal);
      }).catch(() => {
        // Silently fail — sale is already recorded, ZRA can be retried
      });
    }
  }

  /** Submit sale to ZRA via the server-side proxy. Returns the fiscal data or null. */
  async function submitToZra(payload: {
    saleId: string;
    items: { productId: string; name: string; quantity: number; unitPrice: number }[];
    total: number;
    paymentMethod: string;
    customerName?: string | null;
    saleDate: string;
    receiptNo: string;
  }): Promise<ZraFiscalData | null> {
    try {
      const { data: { session } } = await db.auth.getSession();
      if (!session?.access_token) return null;

      const res = await fetch("/api/zra/submit-sale", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!json?.rcptNo) return null;
      return {
        rcptNo: String(json.rcptNo),
        sdcId: json.sdcId ?? null,
        rcptSign: json.rcptSign ?? null,
        intrlData: json.intrlData ?? null,
        vsdcRcptPbctDate: json.vsdcRcptPbctDate ?? null,
      };
    } catch {
      return null;
    }
  }

  /** Generate a receipt-sized PNG, download it, then open WhatsApp so the
   *  user can attach the file. Works with WhatsApp for Windows / mobile. */
  function sendWhatsAppReceipt(phone?: string) {
    const customer = selectedKind === "credit"
      ? customers.find((c) => c.id === selectedCustomer)
      : null;

    const rawPhone = phone || customer?.phone;
    if (!rawPhone) {
      setShowWhatsAppInput(true);
      return;
    }

    // Open WhatsApp window immediately (user-gesture context) so the browser doesn't block it
    const intlPhone = toInternationalPhone(rawPhone, orgState.currency);
    const waWindow = window.open("about:blank", "_blank");

    generateReceiptImage().then((blob) => {
      if (!blob) return;

      // Download the receipt image
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "receipt-" + Date.now() + ".png";
      a.click();
      URL.revokeObjectURL(url);

      // Navigate the already-opened window to WhatsApp
      const shortMsg = "Please find your receipt attached.";
      const waUrl = "https://wa.me/" + intlPhone + "?text=" + encodeURIComponent(shortMsg);
      if (waWindow) {
        waWindow.location.href = waUrl;
      } else {
        window.location.href = waUrl;
      }
    });
  }

  /** Generate a receipt image matching thermal-print dimensions using Canvas. */
  function generateReceiptImage(): Promise<Blob | null> {
    return new Promise((resolve) => {
      const loc = (currentLocationId && orgState.locations)
        ? orgState.locations.find((l: { id: string }) => l.id === currentLocationId)
        : null;
      const shopName = (orgState.orgName ?? "Shop").toUpperCase();
      const locName = loc?.name ?? "";
      const locAddr = loc?.address ?? "";
      const locTel = loc?.phone ?? "";
      const tpin = orgState.tpin ?? "";
      const vatPct = orgState.vatPercent;
      const receiptNo = generateReceiptNumber();
      const now = new Date();
      const dateStr = now.toLocaleDateString("en-ZA", { year: "numeric", month: "short", day: "numeric" });
      const timeStr = now.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" });
      const customer = selectedKind === "credit"
        ? customers.find((c) => c.id === selectedCustomer)
        : null;
      const fiscal = zraFiscal;
      const itemCount = items.reduce((sum, i) => sum + i.quantity, 0);

      const CW = 302;
      const FSM = "11px 'Courier New', monospace";
      const FLG = "bold 15px 'Courier New', monospace";
      const FTL = "bold 16px 'Courier New', monospace";
      const FSS = "10px 'Courier New', monospace";
      const FBL = "bold 11px 'Courier New', monospace";
      const PD = 16;
      const LH = 16;

      // Calculate height
      let lc = 0;
      lc += 3; // shop name, location, address
      if (locTel) lc += 1;
      if (tpin) lc += 2; // TPIN + "TAX INVOICE"
      lc += 1; // dash
      lc += 2; // date/time + receipt#
      lc += 1; // dash
      lc += items.length * 2; // name + qty line
      lc += 1; // item count
      lc += 1; // double line
      lc += 1; // TOTAL
      if (vatPct != null && vatPct > 0) lc += 2;
      lc += 1; // dash
      lc += 1; // payment
      if (selectedKind === "cash" && cashTendered && parseFloat(cashTendered) > total) lc += 2;
      if (customer) lc += 1;
      // ZRA fiscal block
      let qrPx = 0;
      if (fiscal) {
        lc += 1; // ORIGINAL (header)
        lc += 1; // dash before fiscal meta
        if (fiscal.sdcId) lc += 1;
        lc += 1; // Invoice #
        if (fiscal.rcptSign) lc += 1;
        if (fiscal.intrlData) lc += 1;
        lc += 1; // dash before client
        lc += 2; // Client Name + TPIN
        lc += 1; // *** FISCAL RECEIPT ***
        qrPx = 132; // 120px QR box + margins
      }
      lc += 1; // dash
      lc += 3; // footer

      const CH = PD * 2 + lc * LH + 30 + qrPx;

      const canvas = document.createElement("canvas");
      canvas.width = CW;
      canvas.height = CH;
      const ctx = canvas.getContext("2d");
      if (!ctx) { resolve(null); return; }

      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, CW, CH);

      let y = PD;
      const mw = CW - PD * 2;

      function center(text: string, font: string) {
        ctx!.font = font;
        ctx!.fillStyle = "#000";
        ctx!.textAlign = "center";
        ctx!.fillText(text, CW / 2, y, mw);
        y += LH;
      }
      function row(left: string, right: string, font: string) {
        ctx!.font = font;
        ctx!.fillStyle = "#000";
        ctx!.textAlign = "left";
        ctx!.fillText(left, PD, y, mw - 80);
        ctx!.textAlign = "right";
        ctx!.fillText(right, CW - PD, y, 80);
        y += LH;
      }
      function dash() {
        ctx!.font = FSM;
        ctx!.fillStyle = "#000";
        ctx!.textAlign = "center";
        ctx!.fillText("- ".repeat(20), CW / 2, y, mw);
        y += LH;
      }
      function doubleLine() {
        ctx!.strokeStyle = "#000";
        ctx!.lineWidth = 2;
        ctx!.beginPath();
        ctx!.moveTo(PD, y - 6);
        ctx!.lineTo(CW - PD, y - 6);
        ctx!.stroke();
        y += 4;
      }
      // Placeholder QR box — the scannable ZRA verification QR is finalized at
      // go-live once the exact VSDC payload is confirmed (see receipt.tsx TODO).
      function qrBox() {
        const size = 120;
        const bx = (CW - size) / 2;
        ctx!.save();
        ctx!.strokeStyle = "#000";
        ctx!.lineWidth = 1;
        ctx!.setLineDash([3, 3]);
        ctx!.strokeRect(bx, y, size, size);
        ctx!.restore();
        ctx!.fillStyle = "#000";
        ctx!.textAlign = "center";
        ctx!.font = FSS;
        ctx!.fillText("ZRA QR CODE", CW / 2, y + size / 2 - 4, size - 8);
        ctx!.fillText("(added at go-live)", CW / 2, y + size / 2 + 12, size - 8);
        y += size + 12;
      }

      // Header
      center(shopName, FTL);
      center(locName, FSM);
      if (locAddr) center(locAddr, FSM);
      if (locTel) center("Tel: " + locTel, FSM);
      if (tpin) center("TPIN: " + tpin, FSM);
      if (tpin) center("TAX INVOICE", FBL);
      if (fiscal) center("ORIGINAL", FBL);

      dash();

      // Meta
      row(dateStr, timeStr, FSM);
      row("Receipt #:", receiptNo, FSM);

      dash();

      // Line items — no "Item"/"Amount" header
      items.forEach((item) => {
        ctx!.font = FBL;
        ctx!.fillStyle = "#000";
        ctx!.textAlign = "left";
        ctx!.fillText(item.name, PD, y, mw);
        y += LH;
        row("   " + item.quantity + " × " + formatMoney(item.unitPrice), formatMoney(item.unitPrice * item.quantity), FSM);
      });

      // Item count
      ctx!.font = FSS;
      ctx!.fillStyle = "#000";
      ctx!.textAlign = "right";
      ctx!.fillText(itemCount + " item" + (itemCount !== 1 ? "s" : ""), CW - PD, y, mw);
      y += LH;

      // Double line before total
      doubleLine();

      // Total
      row("TOTAL", formatMoney(total), FLG);
      if (vatPct != null && vatPct > 0) {
        y += 2;
        const exclVat = total / (1 + vatPct / 100);
        row("Excl. VAT:", formatMoney(exclVat), FSM);
        row("VAT (" + vatPct + "%):", formatMoney(total - exclVat), FSM);
      }

      dash();

      // Payment
      if (selectedMethod) {
        row("Payment:", selectedMethod.name, FSM);
      }
      if (selectedKind === "cash" && cashTendered && parseFloat(cashTendered) > total) {
        row("Tendered:", formatMoney(parseFloat(cashTendered)), FSM);
        row("Change:", formatMoney(parseFloat(cashTendered) - total), FBL);
      }
      if (customer) {
        row("Customer:", customer.name, FSM);
      }

      // ZRA fiscal block
      if (fiscal) {
        dash();
        if (fiscal.sdcId) row("SDC ID:", fiscal.sdcId, FSM);
        row("Invoice #:", fiscal.rcptNo, FSM);
        if (fiscal.rcptSign) row("Signature:", fiscal.rcptSign, FSS);
        if (fiscal.intrlData) row("Internal:", fiscal.intrlData, FSS);
        dash();
        const clientTpin = (customer as { tpin?: string | null } | null | undefined)?.tpin || "1000000000";
        row("Client Name:", customer?.name || "Cash Sales", FSM);
        row("TPIN:", clientTpin, FSM);
        y += 2;
        center("*** FISCAL RECEIPT ***", FBL);
        qrBox();
      }

      dash();

      // Footer
      center("Thank you for your purchase!", FSM);
      y += 4;
      center(fiscal ? "Powered by ZRA Smart Invoice" : "Powered by Tilify", FSS);

      canvas.toBlob((blob) => resolve(blob), "image/png");
    });
  }

  // Resolve customer for display in success screen
  const creditCustomer = useMemo(
    () => selectedKind === "credit" ? customers.find((c) => c.id === selectedCustomer) : null,
    [selectedKind, customers, selectedCustomer]
  );

  if (success) {
    const receiptData = buildReceiptData();
    return (
      <Modal open={open} onClose={onComplete} title="Sale Complete">
        <div className="flex flex-col items-center py-8">
          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mb-4">
            <Check className="w-8 h-8 text-green-600" />
          </div>
          <p className="text-xl font-bold text-gray-900">{formatMoney(total)}</p>
          <p className="text-sm text-gray-500 mt-1">
            Paid by {selectedMethod?.name ?? "—"}
          </p>
          {queuedToast && (
            <div className="mt-3 inline-flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-full px-3 py-1.5">
              <CloudOff className="w-4 h-4 text-amber-700" />
              <span className="text-xs text-amber-900">
                Queued &mdash; will sync when you&apos;re back online
              </span>
            </div>
          )}
          {selectedKind === "cash" && cashTendered && parseFloat(cashTendered) > total && (
            <div className="mt-3 bg-green-50 border border-green-200 rounded-xl px-6 py-3 text-center">
              <p className="text-sm text-green-600">Change Due</p>
              <p className="text-3xl font-bold text-green-700">{formatMoney(parseFloat(cashTendered) - total)}</p>
            </div>
          )}
          {paymentReference && (
            <p className="text-xs text-gray-500 mt-3">Ref: {paymentReference}</p>
          )}

          {/* Action buttons */}
          <div className="flex flex-col gap-2 mt-6 w-full max-w-xs">
            <Button onClick={handlePrintReceipt} variant="secondary" className="w-full">
              <Printer className="w-4 h-4 mr-2" />
              Print Receipt
            </Button>
            <Button onClick={() => sendWhatsAppReceipt(creditCustomer?.phone ?? undefined)} variant="secondary" className="w-full">
              <MessageCircle className="w-4 h-4 mr-2" />
              WhatsApp Receipt
            </Button>

            {showWhatsAppInput && (
              <div className="flex gap-2">
                <input
                  type="tel"
                  inputMode="tel"
                  value={whatsAppPhone}
                  onChange={(e) => setWhatsAppPhone(e.target.value)}
                  placeholder="Phone number"
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
                  autoFocus
                />
                <Button
                  onClick={() => whatsAppPhone.trim() && sendWhatsAppReceipt(whatsAppPhone.trim())}
                  disabled={!whatsAppPhone.trim()}
                  size="sm"
                >
                  Send
                </Button>
              </div>
            )}

            <Button onClick={onComplete} className="w-full">
              Done
            </Button>
          </div>
        </div>

        {receiptData && (
          <div style={{ position: "absolute", left: "-9999px", top: 0 }}>
            <div ref={receiptRef} className="receipt-print-container">
              <Receipt data={receiptData} />
            </div>
          </div>
        )}
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={onClose} title="Payment" wide>
      <div className="space-y-6">
        <div className="text-center py-4 bg-gray-50 rounded-xl">
          <p className="text-sm text-gray-500">Amount Due</p>
          <p className="text-3xl font-bold text-gray-900">{formatMoney(total)}</p>
          <p className="text-xs text-gray-400 mt-1">{items.length} item(s)</p>
        </div>

        {!online && methods.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs flex items-center gap-2">
            <CloudOff className="w-4 h-4 text-amber-600 flex-shrink-0" />
            <span className="text-amber-900">
              <strong>Offline.</strong> This sale will queue locally and sync when you&apos;re back online.
            </span>
          </div>
        )}

        <div>
          <p className="text-sm font-medium text-gray-700 mb-3">Select payment method</p>
          {!methodsLoaded ? (
            <div className="text-sm text-gray-400 italic py-6 text-center border border-dashed border-gray-200 rounded-lg">
              Loading payment methods...
            </div>
          ) : methods.length === 0 ? (
            <div className="text-sm text-gray-400 italic py-6 text-center border border-dashed border-gray-200 rounded-lg">
              No payment methods configured. Re-run shop setup or add methods in Settings.
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {methods.map((m) => {
                const Icon = KIND_ICON[m.kind] ?? CircleDollarSign;
                const active = selectedMethodId === m.id;
                return (
                  <button
                    key={m.id}
                    onClick={() => setSelectedMethodId(m.id)}
                    className={`flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all touch-manipulation ${
                      active
                        ? KIND_COLOR[m.kind]
                        : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
                    }`}
                  >
                    <Icon className="w-7 h-7" />
                    <span className="text-sm font-medium text-center leading-tight">{m.name}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {selectedKind === "cash" && (
          <div>
            <p className="text-sm font-medium text-gray-700 mb-2">Cash tendered</p>
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={cashTendered}
              onChange={(e) => setCashTendered(e.target.value)}
              placeholder={"Min " + formatMoney(total)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-lg font-semibold text-center focus:border-green-500 focus:ring-1 focus:ring-green-500"
            />
            {cashTendered && parseFloat(cashTendered) >= total && (
              <div className="mt-3 bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-center">
                <p className="text-sm text-green-600">Change</p>
                <p className="text-2xl font-bold text-green-700">{formatMoney(parseFloat(cashTendered) - total)}</p>
              </div>
            )}
            {cashTendered && parseFloat(cashTendered) > 0 && parseFloat(cashTendered) < total && (
              <p className="mt-2 text-sm text-red-600 text-center">
                Short by {formatMoney(total - parseFloat(cashTendered))}
              </p>
            )}
          </div>
        )}

        {(selectedKind === "card" || selectedKind === "eft") && (
          <div>
            <p className="text-sm font-medium text-gray-700 mb-2">
              Reference (optional)
            </p>
            <input
              type="text"
              value={paymentReference}
              onChange={(e) => setPaymentReference(e.target.value)}
              placeholder="Approval / transaction code"
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
            />
          </div>
        )}

        {selectedKind === "credit" && (
          <div>
            <p className="text-sm font-medium text-gray-700 mb-2">Select customer</p>
            {customers.length === 0 ? (
              <p className="text-sm text-gray-400">
                No customers found. Add customers in the Customers module first.
              </p>
            ) : (
              <select
                value={selectedCustomer}
                onChange={(e) => setSelectedCustomer(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
              >
                <option value="">Choose a customer...</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} (owes {formatMoney(c.balance)})
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        {error && (
          <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>
        )}

        <Button
          onClick={handlePay}
          disabled={
            !selectedMethod ||
            processing ||
            (selectedKind === "cash" && (!cashTendered || parseFloat(cashTendered) < total))
          }
          loading={processing}
          size="lg"
          className="w-full text-base py-4"
        >
          {"Complete Sale — " + formatMoney(total)}
        </Button>
      </div>
    </Modal>
  );
}
