"use client";
import { useState, useEffect } from "react";
import { db } from "@/lib/supabase";
import { formatZAR, formatDate } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { BookOpen, ArrowUpRight, ArrowDownLeft } from "lucide-react";
import type { Customer } from "@/types/database";

interface LedgerEntry {
  id: string;
  date: string;
  type: "credit_sale" | "payment";
  customerName: string;
  customerId: string;
  amount: number;
  description: string;
  created_at: string;
}

export default function CreditLedgerPage() {
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterCustomer, setFilterCustomer] = useState("all");
  const [filterFrom, setFilterFrom] = useState(() => {
    const d = new Date();
    d.setDate(1);
    return d.toISOString().split("T")[0];
  });
  const [filterTo, setFilterTo] = useState(() => new Date().toISOString().split("T")[0]);

  useEffect(() => {
    loadCustomers();
  }, []);

  useEffect(() => {
    loadLedger();
  }, [filterCustomer, filterFrom, filterTo]);

  async function loadCustomers() {
    const { data } = await db.from("customers").select("*").order("name");
    setCustomers(data || []);
  }

  async function loadLedger() {
    setLoading(true);

    // Fetch credit sales with product names
    let salesQuery = db
      .from("sales")
      .select("id, sale_date, customer_id, total_amount, quantity, unit_price, product_id, created_at, customers(name), products(name)")
      .eq("payment_method", "credit")
      .eq("voided", false)
      .gte("sale_date", filterFrom)
      .lte("sale_date", filterTo)
      .order("created_at", { ascending: false });

    if (filterCustomer !== "all") {
      salesQuery = salesQuery.eq("customer_id", filterCustomer);
    }

    // Fetch customer payments
    let paymentsQuery = db
      .from("customer_payments")
      .select("id, payment_date, customer_id, amount, created_at, customers(name)")
      .gte("payment_date", filterFrom)
      .lte("payment_date", filterTo)
      .order("created_at", { ascending: false });

    if (filterCustomer !== "all") {
      paymentsQuery = paymentsQuery.eq("customer_id", filterCustomer);
    }

    const [{ data: sales }, { data: payments }] = await Promise.all([
      salesQuery,
      paymentsQuery,
    ]);

    const ledger: LedgerEntry[] = [];

    // Map sales
    (sales || []).forEach((s: Record<string, unknown>) => {
      const cust = s.customers as { name: string } | null;
      const prod = s.products as { name: string } | null;
      ledger.push({
        id: s.id as string,
        date: s.sale_date as string,
        type: "credit_sale",
        customerName: cust?.name || "Unknown",
        customerId: s.customer_id as string,
        amount: s.total_amount as number,
        description: `${s.quantity}× ${prod?.name || "Product"} @ ${formatZAR(s.unit_price as number)}`,
        created_at: s.created_at as string,
      });
    });

    // Map payments
    (payments || []).forEach((p: Record<string, unknown>) => {
      const cust = p.customers as { name: string } | null;
      ledger.push({
        id: p.id as string,
        date: p.payment_date as string,
        type: "payment",
        customerName: cust?.name || "Unknown",
        customerId: p.customer_id as string,
        amount: p.amount as number,
        description: "Payment received",
        created_at: p.created_at as string,
      });
    });

    // Sort by date descending
    ledger.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    setEntries(ledger);
    setLoading(false);
  }

  const totalCreditSales = entries
    .filter((e) => e.type === "credit_sale")
    .reduce((sum, e) => sum + e.amount, 0);
  const totalPayments = entries
    .filter((e) => e.type === "payment")
    .reduce((sum, e) => sum + e.amount, 0);
  const totalOutstanding = customers.reduce((sum, c) => sum + c.balance, 0);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <BookOpen className="w-7 h-7 text-green-600" />
          Credit Ledger
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          All credit sales and payments across all customers
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-white border border-red-100 rounded-xl px-5 py-4">
          <p className="text-sm text-red-600">Credit Sales (Period)</p>
          <p className="text-2xl font-bold text-red-700">{formatZAR(totalCreditSales)}</p>
        </div>
        <div className="bg-white border border-green-100 rounded-xl px-5 py-4">
          <p className="text-sm text-green-600">Payments Received (Period)</p>
          <p className="text-2xl font-bold text-green-700">{formatZAR(totalPayments)}</p>
        </div>
        <div className="bg-white border border-amber-100 rounded-xl px-5 py-4">
          <p className="text-sm text-amber-600">Total Outstanding (All Time)</p>
          <p className="text-2xl font-bold text-amber-700">{formatZAR(totalOutstanding)}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4 items-end">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">From</label>
          <input
            type="date"
            value={filterFrom}
            onChange={(e) => setFilterFrom(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">To</label>
          <input
            type="date"
            value={filterTo}
            onChange={(e) => setFilterTo(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Customer</label>
          <select
            value={filterCustomer}
            onChange={(e) => setFilterCustomer(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
          >
            <option value="all">All Customers</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({formatZAR(c.balance)})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Ledger entries */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading...</div>
      ) : entries.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <BookOpen className="w-12 h-12 mx-auto mb-3 opacity-50" />
          <p>No credit transactions for this period.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className={`bg-white border rounded-xl px-5 py-4 flex items-center justify-between ${
                entry.type === "payment" ? "border-green-100" : "border-gray-200"
              }`}
            >
              <div className="flex items-center gap-3">
                <div
                  className={`w-10 h-10 rounded-full flex items-center justify-center ${
                    entry.type === "payment"
                      ? "bg-green-100 text-green-600"
                      : "bg-red-100 text-red-600"
                  }`}
                >
                  {entry.type === "payment" ? (
                    <ArrowDownLeft className="w-5 h-5" />
                  ) : (
                    <ArrowUpRight className="w-5 h-5" />
                  )}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900">{entry.customerName}</span>
                    <Badge color={entry.type === "payment" ? "green" : "red"}>
                      {entry.type === "payment" ? "Payment" : "Credit Sale"}
                    </Badge>
                  </div>
                  <p className="text-sm text-gray-500">{entry.description}</p>
                  <p className="text-xs text-gray-400">{formatDate(entry.date)}</p>
                </div>
              </div>
              <p
                className={`text-lg font-bold ${
                  entry.type === "payment" ? "text-green-700" : "text-red-700"
                }`}
              >
                {entry.type === "payment" ? "+" : "-"}{formatZAR(entry.amount)}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
