"use client";
import { useState, useEffect } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { formatZAR } from "@/lib/format";
import { db } from "@/lib/supabase";
import { CartItem } from "./cart";
import { Customer } from "@/types/database";
import { Banknote, CreditCard, Users, Check, MessageCircle } from "lucide-react";

type PaymentMethod = "cash" | "card" | "credit";

interface Props {
  open: boolean;
  onClose: () => void;
  items: CartItem[];
  total: number;
  onComplete: () => void;
}

export function PaymentModal({ open, onClose, items, total, onComplete }: Props) {
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<string>("");
  const [processing, setProcessing] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setMethod(null);
      setSelectedCustomer("");
      setSuccess(false);
      setError("");
      // Fetch customers for credit sales
      db.from("customers").select("*").order("name").then(({ data }: { data: any }) => {
        setCustomers(data || []);
      });
    }
  }, [open]);

  async function handlePay() {
    if (!method) return;
    if (method === "credit" && !selectedCustomer) {
      setError("Please select a customer for credit sale.");
      return;
    }

    setProcessing(true);
    setError("");

    try {
      // 1. Insert sale records
      const saleRows = items.map((item) => ({
        sale_date: new Date().toISOString().split("T")[0],
        product_id: item.productId,
        quantity: item.quantity,
        unit_price: item.unitPrice,
        total_amount: item.unitPrice * item.quantity,
        payment_method: method,
        customer_id: method === "credit" ? selectedCustomer : null,
      }));

      const { error: salesError } = await db.from("sales").insert(saleRows);
      if (salesError) throw salesError;

      // 2. Deduct stock via RPC (decrements opening_stock)
      for (const item of items) {
        const { error: stockError } = await db.rpc("deduct_stock", {
          p_product_id: item.productId,
          p_quantity: item.quantity,
        });
        if (stockError) {
          // RPC not yet created — fall back to manual decrement
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

      // 3. If credit sale, update customer balance
      if (method === "credit" && selectedCustomer) {
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

  const methods: { key: PaymentMethod; label: string; icon: React.ElementType; color: string }[] = [
    { key: "cash", label: "Cash", icon: Banknote, color: "border-green-500 bg-green-50 text-green-700" },
    { key: "card", label: "Card (iKhokha)", icon: CreditCard, color: "border-blue-500 bg-blue-50 text-blue-700" },
    { key: "credit", label: "Credit", icon: Users, color: "border-amber-500 bg-amber-50 text-amber-700" },
  ];

  function sendWhatsAppInvoice() {
    const customer = customers.find((c) => c.id === selectedCustomer);
    if (!customer || !customer.phone) return;

    const today = new Date().toLocaleDateString("en-ZA");
    let msg = `*Tuck Shop — Credit Invoice*\nDate: ${today}\nCustomer: ${customer.name}\n\n`;
    items.forEach((item) => {
      msg += `• ${item.name} ×${item.quantity} @ ${formatZAR(item.unitPrice)} = ${formatZAR(item.unitPrice * item.quantity)}\n`;
    });
    msg += `\n*Total: ${formatZAR(total)}*\n`;
    msg += `*Balance Owed: ${formatZAR((customer.balance || 0) + total)}*\n`;

    // Check for iKhokha link
    db.from("app_settings").select("value").eq("key", "ikhokha_link").single().then(({ data }: { data: { value: string } | null }) => {
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
          <p className="text-xl font-bold text-gray-900">{formatZAR(total)}</p>
          <p className="text-sm text-gray-500 mt-1">
            Paid by {method === "card" ? "Card (iKhokha)" : method}
          </p>
          {method === "credit" && selectedCustomer && (
            <Button
              onClick={sendWhatsAppInvoice}
              variant="secondary"
              className="mt-4"
            >
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
          <p className="text-3xl font-bold text-gray-900">{formatZAR(total)}</p>
          <p className="text-xs text-gray-400 mt-1">{items.length} item(s)</p>
        </div>

        {/* Payment method selection */}
        <div>
          <p className="text-sm font-medium text-gray-700 mb-3">Select payment method</p>
          <div className="grid grid-cols-3 gap-3">
            {methods.map((m) => {
              const Icon = m.icon;
              const active = method === m.key;
              return (
                <button
                  key={m.key}
                  onClick={() => setMethod(m.key)}
                  className={`flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all touch-manipulation ${
                    active ? m.color : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
                  }`}
                >
                  <Icon className="w-7 h-7" />
                  <span className="text-sm font-medium">{m.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Credit customer selector */}
        {method === "credit" && (
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
                    {c.name} (owes {formatZAR(c.balance)})
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
          disabled={!method || processing}
          loading={processing}
          size="lg"
          className="w-full text-base py-4"
        >
          Complete Sale — {formatZAR(total)}
        </Button>
      </div>
    </Modal>
  );
}
