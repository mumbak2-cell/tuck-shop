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
import { Receipt, ReceiptData } from "./receipt";

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

      // Pre-compute cached copies so we can fall back instantly when offline.
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

      // Offline path — Supabase calls hang indefinitely when offline rather
      // than rejecting, so don't even try the network. Use the cache directly.
      if (!navigator.onLine) {
        setMethods(cachedMethods);
        setCustomers(cachedCustomers);
        setMethodsLoaded(true);
        return;
      }

      // Race the live query against a short timeout so a stalled connection
      // doesn't leave the cashier staring at "Loading..." for ever.
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

      // Customers — same pattern.
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
      saleDate: new Date(),
    };
  }, [currentLocationId, orgState, selectedMethod, selectedKind, cashTendered, customers, selectedCustomer, items, total, paymentReference]);

  function handlePrintReceipt() {
    const el = receiptRef.current;
    if (!el) return;
    const printWindow = window.open("", "_blank", "width=350,height=600");
    if (!printWindow) return;
    printWindow.document.write(`
      <!DOCTYPE html>
      <html><head><title>Receipt</title>
      <style>
        body { margin: 0; padding: 0; }
        @page { size: 80mm auto; margin: 0; }
      </style>
      </head><body>${el.innerHTML}</body></html>
    `);
    printWindow.document.close();
    // Small delay lets styles render before the print dialog opens.
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
    if (selectedKind === "mobile_money" && !paymentReference.trim()) {
      setError("Please enter the mobile money transaction reference.");
      return;
    }
    if (!orgId || !currentLocationId) {
      setError("Shop not loaded yet. Try again in a moment.");
      return;
    }

    setProcessing(true);
    setError("");

    // Use the idempotent batch RPC. Client-generated UUIDs make the call
    // safely retriable, so if we are offline (or the network blips mid-call)
    // the operation lands in the queue and the cashier sees the same
    // "sale complete" outcome — Tilify replays it on reconnect.
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
  }

  // --- Auto-close timer: closes after 3s unless cashier interacts ---
  const autoCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [countdown, setCountdown] = useState(3);

  useEffect(() => {
    if (!success) return;
    setCountdown(3);
    const tick = setInterval(() => setCountdown((c) => c - 1), 1000);
    autoCloseRef.current = setTimeout(() => onComplete(), 3000);
    return () => {
      clearInterval(tick);
      if (autoCloseRef.current) clearTimeout(autoCloseRef.current);
    };
  }, [success, onComplete]);

  function cancelAutoClose() {
    if (autoCloseRef.current) {
      clearTimeout(autoCloseRef.current);
      autoCloseRef.current = null;
    }
    setCountdown(-1); // signals timer is cancelled
  }

  // --- WhatsApp receipt (available for all sales, not just credit) ---
  const [whatsAppPhone, setWhatsAppPhone] = useState("");
  const [showWhatsAppInput, setShowWhatsAppInput] = useState(false);

  function sendWhatsAppReceipt(phone?: string) {
    const customer = selectedKind === "credit"
      ? customers.find((c) => c.id === selectedCustomer)
      : null;

    // Determine phone: credit customer's phone, or manually entered
    const rawPhone = phone || customer?.phone;
    if (!rawPhone) {
      // Show phone input if no number available
      cancelAutoClose();
      setShowWhatsAppInput(true);
      return;
    }

    const today = new Date().toLocaleDateString("en-ZA");
    let msg = selectedKind === "credit"
      ? `*Credit Invoice*\nDate: ${today}\nCustomer: ${customer?.name ?? ""}\n\n`
      : `*Receipt*\nDate: ${today}\n\n`;

    items.forEach((item) => {
      msg += `• ${item.name} ×${item.quantity} @ ${formatMoney(item.unitPrice)} = ${formatMoney(item.unitPrice * item.quantity)}\n`;
    });
    msg += `\n*Total: ${formatMoney(total)}*\n`;

    if (selectedKind === "credit" && customer) {
      msg += `*Balance Owed: ${formatMoney((customer.balance || 0) + total)}*\n`;
    }
    if (selectedMethod) {
      msg += `Paid by: ${selectedMethod.name}\n`;
    }

    // Optional online payment link
    db.from("app_settings").select("value").eq("key", "ikhokha_link").single()
      .then(({ data }: { data: { value: string } | null }) => {
        if (data?.value) {
          msg += `\nPay online: ${data.value}\n`;
        }
        msg += `\nThank you for your purchase!`;
        const cleanPhone = rawPhone.replace(/[^0-9]/g, "");
        const intlPhone = cleanPhone.startsWith("0") ? "27" + cleanPhone.slice(1) : cleanPhone;
        window.open(`https://wa.me/${intlPhone}?text=${encodeURIComponent(msg)}`, "_blank");
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
                Queued — will sync when you&apos;re back online
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
            <Button onClick={() => { cancelAutoClose(); handlePrintReceipt(); }} variant="secondary" className="w-full">
              <Printer className="w-4 h-4 mr-2" />
              Print Receipt
            </Button>
            <Button onClick={() => { cancelAutoClose(); sendWhatsAppReceipt(creditCustomer?.phone ?? undefined); }} variant="secondary" className="w-full">
              <MessageCircle className="w-4 h-4 mr-2" />
              WhatsApp Receipt
            </Button>

            {/* WhatsApp phone input (shown when no customer phone on file) */}
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
              {countdown > 0 ? `Done (${countdown})` : "Done"}
            </Button>
          </div>
        </div>

        {/* Hidden receipt for printing */}
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
        {/* Total */}
        <div className="text-center py-4 bg-gray-50 rounded-xl">
          <p className="text-sm text-gray-500">Amount Due</p>
          <p className="text-3xl font-bold text-gray-900">{formatMoney(total)}</p>
          <p className="text-xs text-gray-400 mt-1">{items.length} item(s)</p>
        </div>

        {/* Offline ribbon: still let the cashier complete the sale (it queues) */}
        {!online && methods.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs flex items-center gap-2">
            <CloudOff className="w-4 h-4 text-amber-600 flex-shrink-0" />
            <span className="text-amber-900">
              <strong>Offline.</strong> This sale will queue locally and sync when you&apos;re back online.
            </span>
          </div>
        )}

        {/* Payment method selection */}
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

        {/* Cash tendered + change */}
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
              placeholder={`Min ${formatMoney(total)}`}
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


        {/* Mobile money transaction reference */}
        {selectedKind === "mobile_money" && (
          <div>
            <p className="text-sm font-medium text-gray-700 mb-2">
              Transaction reference from {selectedMethod?.name}
            </p>
            <input
              type="text"
              value={paymentReference}
              onChange={(e) => setPaymentReference(e.target.value)}
              placeholder="e.g. confirmation code or SMS reference"
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
            />
            <p className="text-xs text-gray-500 mt-1">
              Captured for reconciliation. Will appear on Sales reports.
            </p>
          </div>
        )}

        {/* Card or EFT reference (optional) */}
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

        {/* Credit customer selector */}
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
          disabled={!selectedMethod || processing}
          loading={processing}
          size="lg"
          className="w-full text-base py-4"
        >
          Complete Sale — {formatMoney(total)}
        </Button>
      </div>
    </Modal>
  );
}
