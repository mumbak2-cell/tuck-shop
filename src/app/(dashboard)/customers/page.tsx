"use client";
import { useEffect, useState, useCallback } from "react";
import { db } from "@/lib/supabase";
import { useOrg } from "@/lib/org-context";
import { Customer, CustomerPayment, Sale } from "@/types/database";
import { formatZAR, formatDate } from "@/lib/format";
import { toInternationalPhone } from "@/lib/currency";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Badge } from "@/components/ui/badge";
import {
  Users,
  Plus,
  Phone,
  Wallet,
  ArrowDownCircle,
  History,
  Search,
  Edit2,
  MessageCircle,
  CloudOff,
} from "lucide-react";
import { insertOrQueue } from "@/lib/offline-ops";

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  // Modals
  const [showForm, setShowForm] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [showPayment, setShowPayment] = useState(false);
  const [paymentCustomer, setPaymentCustomer] = useState<Customer | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [historyCustomer, setHistoryCustomer] = useState<Customer | null>(null);

  const { currentLocationId, currentLocationName, currency } = useOrg();

  const fetchCustomers = useCallback(async () => {
    setLoading(true);
    let q = db.from("customers").select("*").order("name");
    if (currentLocationId) {
      // Per-location credit book: only show this shop's customers.
      q = q.eq("location_id", currentLocationId);
    }
    const { data } = await q;
    setCustomers(data || []);
    setLoading(false);
  }, [currentLocationId]);

  useEffect(() => {
    fetchCustomers();
  }, [fetchCustomers]);

  const filtered = customers.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    (c.phone && c.phone.includes(search))
  );

  const totalOwed = customers.reduce((sum, c) => sum + c.balance, 0);

  function openAdd() {
    setEditingCustomer(null);
    setShowForm(true);
  }

  function openEdit(customer: Customer) {
    setEditingCustomer(customer);
    setShowForm(true);
  }

  function openPayment(customer: Customer) {
    setPaymentCustomer(customer);
    setShowPayment(true);
  }

  function openHistory(customer: Customer) {
    setHistoryCustomer(customer);
    setShowHistory(true);
  }

  async function sendStatement(customer: Customer) {
    if (!customer.phone) return;

    // Open the WhatsApp window immediately (synchronous with user click)
    // so the browser doesn't block it as a popup.
    const intlPhone = toInternationalPhone(customer.phone, currency);
    const waWindow = window.open("about:blank", "_blank");

    const today = new Date().toLocaleDateString("en-ZA");
    let msg = `*Statement*\nDate: ${today}\nCustomer: ${customer.name}\n\n`;
    msg += `*Outstanding Balance: ${formatZAR(customer.balance)}*\n`;

    // Check for iKhokha link
    const { data } = await db.from("app_settings").select("value").eq("key", "ikhokha_link").single();
    if (data?.value) {
      msg += `\nPay online: ${data.value}\n`;
    }
    msg += `\nPlease settle your account at your earliest convenience. Thank you!`;

    const waUrl = `https://wa.me/${intlPhone}?text=${encodeURIComponent(msg)}`;
    if (waWindow) {
      waWindow.location.href = waUrl;
    } else {
      // Fallback if popup was still blocked
      window.location.href = waUrl;
    }
  }

  if (loading) {
    return <div className="text-center py-12 text-gray-400">Loading...</div>;
  }

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Customers</h1>
        <Button onClick={openAdd}>
          <Plus className="w-4 h-4 mr-2" />
          Add Customer
        </Button>
      </div>

      {/* Summary bar */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-600">
              <Users className="w-5 h-5 text-white" />
            </div>
            <div>
              <p className="text-xs text-gray-500">Total Customers</p>
              <p className="text-lg font-bold text-gray-900">{customers.length}</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-red-600">
              <Wallet className="w-5 h-5 text-white" />
            </div>
            <div>
              <p className="text-xs text-gray-500">Total Owed</p>
              <p className="text-lg font-bold text-gray-900">{formatZAR(totalOwed)}</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-amber-500">
              <Users className="w-5 h-5 text-white" />
            </div>
            <div>
              <p className="text-xs text-gray-500">With Balance</p>
              <p className="text-lg font-bold text-gray-900">
                {customers.filter((c) => c.balance > 0).length}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Search */}
      <div className="mb-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search by name or phone..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 bg-white border border-gray-200 rounded-lg text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
          />
        </div>
      </div>

      {/* Customer list */}
      {filtered.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <Users className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500">
            {search ? "No customers match your search" : "No customers yet. Add your first customer to enable credit sales."}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((customer) => (
            <div
              key={customer.id}
              className="bg-white rounded-xl border border-gray-200 p-4"
            >
              <div className="flex items-center justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-gray-900">{customer.name}</h3>
                    {customer.balance > 0 && (
                      <Badge color="red">Owes {formatZAR(customer.balance)}</Badge>
                    )}
                    {customer.balance === 0 && (
                      <Badge color="green">Paid up</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-4 mt-1 text-sm text-gray-500">
                    {customer.phone && (
                      <span className="flex items-center gap-1">
                        <Phone className="w-3.5 h-3.5" />
                        {customer.phone}
                      </span>
                    )}
                    <span>Limit: {formatZAR(customer.credit_limit)}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {customer.phone && customer.balance > 0 && (
                    <button
                      onClick={() => sendStatement(customer)}
                      className="p-2 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded-lg touch-manipulation"
                      title="WhatsApp Statement"
                    >
                      <MessageCircle className="w-5 h-5" />
                    </button>
                  )}
                  <button
                    onClick={() => openHistory(customer)}
                    className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg touch-manipulation"
                    title="History"
                  >
                    <History className="w-5 h-5" />
                  </button>
                  <button
                    onClick={() => openPayment(customer)}
                    className="p-2 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded-lg touch-manipulation"
                    title="Record payment"
                  >
                    <ArrowDownCircle className="w-5 h-5" />
                  </button>
                  <button
                    onClick={() => openEdit(customer)}
                    className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-50 rounded-lg touch-manipulation"
                    title="Edit"
                  >
                    <Edit2 className="w-5 h-5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add/Edit Customer Modal */}
      <CustomerFormModal
        open={showForm}
        onClose={() => setShowForm(false)}
        customer={editingCustomer}
        onSaved={fetchCustomers}
      />

      {/* Record Payment Modal */}
      {paymentCustomer && (
        <PaymentModal
          open={showPayment}
          onClose={() => {
            setShowPayment(false);
            setPaymentCustomer(null);
          }}
          customer={paymentCustomer}
          onSaved={fetchCustomers}
        />
      )}

      {/* History Modal */}
      {historyCustomer && (
        <HistoryModal
          open={showHistory}
          onClose={() => {
            setShowHistory(false);
            setHistoryCustomer(null);
          }}
          customer={historyCustomer}
        />
      )}
    </div>
  );
}

/* ── Add / Edit Customer Form ── */
function CustomerFormModal({
  open,
  onClose,
  customer,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  customer: Customer | null;
  onSaved: () => void;
}) {
  const { currentLocationId, currentLocationName, orgId } = useOrg();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [creditLimit, setCreditLimit] = useState("500");
  const [balance, setBalance] = useState("0");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [queuedNote, setQueuedNote] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(customer?.name || "");
      setPhone(customer?.phone || "");
      setCreditLimit(customer?.credit_limit?.toString() || "500");
      setBalance(customer?.balance?.toString() || "0");
      setError("");
    }
  }, [open, customer]);

  async function handleSave() {
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setSaving(true);
    setError("");

    const payload: Record<string, unknown> = {
      name: name.trim(),
      phone: phone.trim() || null,
      credit_limit: parseFloat(creditLimit) || 500,
    };

    let dbError: { message: string } | null = null;
    let queued = false;
    if (customer) {
      // Include balance when editing (allows setting carried-forward amount)
      payload.balance = parseFloat(balance) || 0;
      const res = await db
        .from("customers")
        .update(payload)
        .eq("id", customer.id);
      dbError = res.error;
    } else {
      payload.balance = parseFloat(balance) || 0;
      // Customers are per-location: each shop has its own credit book.
      payload.location_id = currentLocationId;
      if (!orgId) {
        setError("Shop not loaded yet.");
        setSaving(false);
        return;
      }
      const result = await insertOrQueue({
        org_id: orgId,
        table: "customers",
        cacheKind: "customers",
        queueKind: "insert_customer",
        row: payload as { id?: string } & Record<string, unknown>,
      });
      if (!result.ok) dbError = { message: result.error || "unknown" };
      else queued = result.queued;
    }

    setSaving(false);

    if (dbError) {
      setError(dbError.message);
      return;
    }

    if (queued) {
      setQueuedNote(`Customer added offline — will sync when you're back online.`);
      setTimeout(() => {
        setQueuedNote(null);
        onSaved();
        onClose();
      }, 1500);
    } else {
      onSaved();
      onClose();
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={customer ? "Edit Customer" : "Add Customer"}>
      <div className="space-y-4">
        <Input
          label="Customer Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. John Mokoena"
        />
        <Input
          label="Phone Number (optional)"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="e.g. 072 123 4567"
        />
        <Input
          label="Credit Limit (R)"
          type="number"
          step="50"
          value={creditLimit}
          onChange={(e) => setCreditLimit(e.target.value)}
        />
        <div>
          <Input
            label={customer ? "Balance Owed (R) — Carried Forward" : "Opening Balance (R)"}
            type="number"
            step="0.01"
            value={balance}
            onChange={(e) => setBalance(e.target.value)}
          />
          {customer && (
            <p className="text-xs text-gray-500 mt-1">
              Set this to carry forward a balance from a previous month. Current system balance: {formatZAR(customer.balance)}
            </p>
          )}
        </div>
        {error && (
          <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>
        )}
        {queuedNote && (
          <div className="bg-amber-50 border border-amber-200 text-amber-900 px-4 py-2 rounded-lg text-sm inline-flex items-center gap-2">
            <CloudOff className="w-4 h-4" /> {queuedNote}
          </div>
        )}
        <Button onClick={handleSave} loading={saving} className="w-full">
          {customer ? "Update Customer" : "Add Customer"}
        </Button>
      </div>
    </Modal>
  );
}

/* ── Record Payment Modal ── */
function PaymentModal({
  open,
  onClose,
  customer,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  customer: Customer;
  onSaved: () => void;
}) {
  const { orgId } = useOrg();
  const [amount, setAmount] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [queuedNote, setQueuedNote] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setAmount("");
      setError("");
      setQueuedNote(null);
    }
  }, [open]);

  async function handleRecord() {
    const val = parseFloat(amount);
    if (!val || val <= 0) {
      setError("Enter a valid amount");
      return;
    }
    if (val > customer.balance) {
      setError(`Payment exceeds balance of ${formatZAR(customer.balance)}`);
      return;
    }
    if (!orgId) {
      setError("Shop not loaded yet.");
      return;
    }

    setSaving(true);
    setError("");

    // Queue or send the payment row. The replay handler for
    // insert_customer_payment also decrements the customer's balance once
    // online, atomically with the payment insert.
    const result = await insertOrQueue({
      org_id: orgId,
      table: "customer_payments",
      queueKind: "insert_customer_payment",
      row: {
        customer_id: customer.id,
        payment_date: new Date().toISOString().split("T")[0],
        amount: val,
        location_id: (customer as { location_id?: string | null }).location_id ?? null,
      } as { id?: string } & Record<string, unknown>,
    });

    if (!result.ok) {
      setError(result.error || "Unknown error");
      setSaving(false);
      return;
    }

    // If we're online the insert already landed; decrement balance atomically (H1 fix).
    // If we're offline, the replay handler will decrement on sync.
    if (!result.queued) {
      const { error: balErr } = await db.rpc("adjust_customer_balance", {
        p_customer_id: customer.id,
        p_delta: -val,
      });
      if (balErr) {
        setError(balErr.message);
        setSaving(false);
        return;
      }
    }

    setSaving(false);

    if (result.queued) {
      setQueuedNote(`Payment recorded offline — balance will adjust when you're back online.`);
      setTimeout(() => {
        setQueuedNote(null);
        onSaved();
        onClose();
      }, 1800);
    } else {
      onSaved();
      onClose();
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Payment — ${customer.name}`}>
      <div className="space-y-4">
        <div className="bg-gray-50 rounded-lg px-4 py-3">
          <div className="flex justify-between text-sm">
            <span className="text-gray-600">Current balance</span>
            <span className="font-semibold text-red-600">{formatZAR(customer.balance)}</span>
          </div>
        </div>

        <Input
          label="Payment Amount (R)"
          type="number"
          step="0.01"
          placeholder="How much is the customer paying?"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />

        {amount && parseFloat(amount) > 0 && (
          <div className="bg-green-50 rounded-lg px-4 py-3 text-sm text-green-700">
            New balance after payment:{" "}
            <span className="font-semibold">
              {formatZAR(Math.max(customer.balance - (parseFloat(amount) || 0), 0))}
            </span>
          </div>
        )}

        {error && (
          <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>
        )}
        {queuedNote && (
          <div className="bg-amber-50 border border-amber-200 text-amber-900 px-4 py-2 rounded-lg text-sm inline-flex items-center gap-2">
            <CloudOff className="w-4 h-4" /> {queuedNote}
          </div>
        )}

        <Button onClick={handleRecord} loading={saving} className="w-full">
          Record Payment
        </Button>
      </div>
    </Modal>
  );
}

/* ── Customer History Modal ── */
function HistoryModal({
  open,
  onClose,
  customer,
}: {
  open: boolean;
  onClose: () => void;
  customer: Customer;
}) {
  const [payments, setPayments] = useState<CustomerPayment[]>([]);
  const [sales, setSales] = useState<(Sale & { product_name?: string })[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"sales" | "payments">("sales");

  useEffect(() => {
    if (open) {
      setLoading(true);
      Promise.all([
        db
          .from("customer_payments")
          .select("*")
          .eq("customer_id", customer.id)
          .order("payment_date", { ascending: false })
          .limit(50),
        db
          .from("sales")
          .select("*, products(name)")
          .eq("customer_id", customer.id)
          .order("created_at", { ascending: false })
          .limit(50),
      ]).then(([payRes, saleRes]: [any, any]) => {
        setPayments(payRes.data || []);
        const salesData = (saleRes.data || []).map((s: Record<string, unknown>) => ({
          ...s,
          product_name: (s.products as { name: string } | null)?.name || "Unknown",
        })) as (Sale & { product_name?: string })[];
        setSales(salesData);
        setLoading(false);
      });
    }
  }, [open, customer.id]);

  return (
    <Modal open={open} onClose={onClose} title={`History — ${customer.name}`} wide>
      <div className="space-y-4">
        <div className="bg-gray-50 rounded-lg px-4 py-3 flex justify-between text-sm">
          <span className="text-gray-600">Current balance</span>
          <span className={`font-semibold ${customer.balance > 0 ? "text-red-600" : "text-green-600"}`}>
            {formatZAR(customer.balance)}
          </span>
        </div>

        {/* Tab switcher */}
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
          <button
            onClick={() => setTab("sales")}
            className={`flex-1 py-2 text-sm font-medium rounded-md transition-colors ${
              tab === "sales" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"
            }`}
          >
            Credit Purchases ({sales.length})
          </button>
          <button
            onClick={() => setTab("payments")}
            className={`flex-1 py-2 text-sm font-medium rounded-md transition-colors ${
              tab === "payments" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"
            }`}
          >
            Payments ({payments.length})
          </button>
        </div>

        {loading ? (
          <div className="text-center py-8 text-gray-400">Loading...</div>
        ) : tab === "sales" ? (
          sales.length === 0 ? (
            <p className="text-center py-8 text-gray-400 text-sm">No credit purchases yet</p>
          ) : (
            <div className="max-h-64 overflow-y-auto space-y-2">
              {sales.map((sale) => (
                <div key={sale.id} className="flex justify-between items-center py-2 border-b border-gray-100 last:border-0 text-sm">
                  <div>
                    <p className="font-medium text-gray-900">{sale.product_name}</p>
                    <p className="text-xs text-gray-500">
                      {formatDate(sale.sale_date)} · Qty {sale.quantity}
                    </p>
                  </div>
                  <span className="font-semibold text-red-600">
                    {formatZAR(sale.total_amount)}
                  </span>
                </div>
              ))}
            </div>
          )
        ) : payments.length === 0 ? (
          <p className="text-center py-8 text-gray-400 text-sm">No payments recorded</p>
        ) : (
          <div className="max-h-64 overflow-y-auto space-y-2">
            {payments.map((p) => (
              <div key={p.id} className="flex justify-between items-center py-2 border-b border-gray-100 last:border-0 text-sm">
                <div>
                  <p className="font-medium text-gray-900">Payment received</p>
                  <p className="text-xs text-gray-500">{formatDate(p.payment_date)}</p>
                </div>
                <span className="font-semibold text-green-600">
                  {formatZAR(p.amount)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
