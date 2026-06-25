"use client";
import { useState, useEffect } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/format";
import { db } from "@/lib/supabase";
import { useOrg } from "@/lib/org-context";
import { useOnline } from "@/lib/use-online";
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
  WifiOff,
} from "lucide-react";

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
  const { currentLocationId } = useOrg();
  const online = useOnline();
  const [methods, setMethods] = useState<PaymentMethodRow[]>([]);
  const [methodsLoaded, setMethodsLoaded] = useState(false);
  const [methodsError, setMethodsError] = useState(false);
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
      // Load this org's payment methods (RLS scopes automatically). Track
      // whether the query actually completed so we can distinguish a true
      // "no methods configured" state from a "request failed because we
      // are offline" state when the modal renders below.
      db.from("payment_methods")
        .select("id, name, kind, sort_order")
        .eq("active", true)
        .order("sort_order")
        .then(({ data, error: err }: { data: PaymentMethodRow[] | null; error: { message: string } | null }) => {
          if (err) {
            setMethodsError(true);
          } else {
            setMethods(data || []);
          }
          setMethodsLoaded(true);
        });
      // Load customers for credit sales - scoped to the current location.
      let customerQuery = db.from("customers").select("*").order("name");
      if (currentLocationId) {
        customerQuery = customerQuery.eq("location_id", currentLocationId);
      }
      customerQuery.then(({ data }: { data: Customer[] | null }) => {
        setCustomers(data || []);
      });
    }
  }, [open, currentLocationId]);

  const selectedMethod = methods.find((m) => m.id === selectedMethodId) || null;
  const selectedKind = selectedMethod?.kind ?? null;

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

    setProcessing(true);
    setError("");

    try {
      // 1. Insert sale records using the method NAME (legacy column kept as TEXT)
      const saleRows = items.map((item) => ({
        sale_date: new Date().toISOString().split("T")[0],
        product_id: item.productId,
        quantity: item.quantity,
        unit_price: item.unitPrice,
        total_amount: item.unitPrice * item.quantity,
        payment_method: selectedMethod.name,
        payment_reference: paymentReference.trim() || null,
        customer_id: selectedKind === "credit" ? selectedCustomer : null,
        // Multi-location: tag every sale with the currently-selected location.
        location_id: currentLocationId,
      }));

      const { error: salesError } = await db.from("sales").insert(saleRows);
      if (salesError) throw salesError;

      // 2. Deduct stock from the CURRENT LOCATION's per-location stock.
      // Falls back to the org-wide deduct_stock RPC if the new RPC is not
      // present (e.g. migration 024 has not run on this database yet).
      for (const item of items) {
        if (currentLocationId) {
          const { error: locErr } = await db.rpc("deduct_stock_at_location", {
            p_product_id: item.productId,
            p_quantity: item.quantity,
            p_location_id: currentLocationId,
          });
          if (!locErr) continue;
        }
        // Fallback: legacy org-wide deduct (central stock mode)
        const { error: stockError } = await db.rpc("deduct_stock", {
          p_product_id: item.productId,
          p_quantity: item.quantity,
        });
        if (stockError) {
          const { data: prod } = await db
            .from("products")
            .select("opening_stock")
            .eq("id", item.productId)
            .single();
          if (prod) {
            await db
              .from("products")
              .update({
                opening_stock: Math.max((prod.opening_stock || 0) - item.quantity, 0),
              })
              .eq("id", item.productId);
          }
        }
      }

      // 3. Update customer balance on credit sales
      if (selectedKind === "credit" && selectedCustomer) {
        const customer = customers.find((c) => c.id === selectedCustomer);
        if (customer) {
          await db
            .from("customers")
            .update({ balance: customer.balance + total })
            .eq("id", selectedCustomer);
        }
      }

      setSuccess(true);
      setTimeout(() => {
        onComplete();
      }, 1500);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to process sale";
      setError(message);
    } finally {
      setProcessing(false);
    }
  }

  function sendWhatsAppInvoice() {
    const customer = customers.find((c) => c.id === selectedCustomer);
    if (!customer || !customer.phone) return;

    const today = new Date().toLocaleDateString("en-ZA");
    let msg = `*Credit Invoice*\nDate: ${today}\nCustomer: ${customer.name}\n\n`;
    items.forEach((item) => {
      msg += `• ${item.name} ×${item.quantity} @ ${formatMoney(item.unitPrice)} = ${formatMoney(item.unitPrice * item.quantity)}\n`;
    });
    msg += `\n*Total: ${formatMoney(total)}*\n`;
    msg += `*Balance Owed: ${formatMoney((customer.balance || 0) + total)}*\n`;

    // Optional online payment link
    db.from("app_settings").select("value").eq("key", "ikhokha_link").single()
      .then(({ data }: { data: { value: string } | null }) => {
        if (data?.value) {
          msg += `\nPay online: ${data.value}\n`;
        }
        msg += `\nThank you for your business!`;
        const phone = customer.phone!.replace(/[^0-9]/g, "");
        const intlPhone = phone.startsWith("0") ? "27" + phone.slice(1) : phone;
        window.open(`https://wa.me/${intlPhone}?text=${encodeURIComponent(msg)}`, "_blank");
      });
  }

  if (success) {
    return (
      <Modal open={open} onClose={onClose} title="Sale Complete">
        <div className="flex flex-col items-center py-8">
          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mb-4">
            <Check className="w-8 h-8 text-green-600" />
          </div>
          <p className="text-xl font-bold text-gray-900">{formatMoney(total)}</p>
          <p className="text-sm text-gray-500 mt-1">
            Paid by {selectedMethod?.name ?? "—"}
          </p>
          {selectedKind === "cash" && cashTendered && parseFloat(cashTendered) > total && (
            <div className="mt-3 bg-green-50 border border-green-200 rounded-xl px-6 py-3 text-center">
              <p className="text-sm text-green-600">Change Due</p>
              <p className="text-3xl font-bold text-green-700">{formatMoney(parseFloat(cashTendered) - total)}</p>
            </div>
          )}
          {paymentReference && (
            <p className="text-xs text-gray-500 mt-3">Ref: {paymentReference}</p>
          )}
          {selectedKind === "credit" && selectedCustomer && (
            <Button onClick={sendWhatsAppInvoice} variant="secondary" className="mt-4">
              <MessageCircle className="w-4 h-4 mr-2" />
              WhatsApp Invoice
            </Button>
          )}
        </div>
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

        {/* Payment method selection */}
        <div>
          <p className="text-sm font-medium text-gray-700 mb-3">Select payment method</p>
          {!methodsLoaded ? (
            <div className="text-sm text-gray-400 italic py-6 text-center border border-dashed border-gray-200 rounded-lg">
              Loading payment methods...
            </div>
          ) : !online || methodsError ? (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-5 text-center">
              <WifiOff className="w-6 h-6 text-amber-600 mx-auto mb-2" />
              <p className="text-sm font-medium text-amber-900">You&apos;re offline</p>
              <p className="text-xs text-amber-700 mt-1">
                Payment methods can&apos;t load right now. Close this modal and retry once the
                connection is back. Your cart is preserved.
              </p>
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
