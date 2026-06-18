"use client";
import { useState, useEffect } from "react";
import { db } from "@/lib/supabase";
import { formatZAR, formatDate } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { BookOpen, ArrowUpRight, ArrowDownLeft, MessageCircle, Download } from "lucide-react";
import type { Customer } from "@/types/database";

interface LedgerEntry {
  id: string;
  date: string;
  type: "credit_sale" | "payment";
  customerName: string;
  customerId: string;
  amount: number;
  productName: string;
  quantity: number;
  unitPrice: number;
  created_at: string;
}

interface GroupedLine {
  date: string;
  type: "credit_sale" | "payment" | "brought_forward";
  productName: string;
  quantity: number;
  unitPrice: number;
  total: number;
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
  const [broughtForward, setBroughtForward] = useState(0);

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
    setBroughtForward(0);

    // Fetch credit sales with product names
    let salesQuery = db
      .from("sales")
      .select("id, sale_date, customer_id, total_amount, quantity, unit_price, created_at, customers(name), products(name)")
      .eq("payment_method", "credit")
      .eq("voided", false)
      .gte("sale_date", filterFrom)
      .lte("sale_date", filterTo)
      .order("sale_date", { ascending: true })
      .order("created_at", { ascending: true });

    if (filterCustomer !== "all") {
      salesQuery = salesQuery.eq("customer_id", filterCustomer);
    }

    // Fetch customer payments
    let paymentsQuery = db
      .from("customer_payments")
      .select("id, payment_date, customer_id, amount, created_at, customers(name)")
      .gte("payment_date", filterFrom)
      .lte("payment_date", filterTo)
      .order("payment_date", { ascending: true })
      .order("created_at", { ascending: true });

    if (filterCustomer !== "all") {
      paymentsQuery = paymentsQuery.eq("customer_id", filterCustomer);
    }

    const [{ data: sales }, { data: payments }] = await Promise.all([
      salesQuery,
      paymentsQuery,
    ]);

    const ledger: LedgerEntry[] = [];

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
        productName: prod?.name || "Product",
        quantity: s.quantity as number,
        unitPrice: s.unit_price as number,
        created_at: s.created_at as string,
      });
    });

    (payments || []).forEach((p: Record<string, unknown>) => {
      const cust = p.customers as { name: string } | null;
      ledger.push({
        id: p.id as string,
        date: p.payment_date as string,
        type: "payment",
        customerName: cust?.name || "Unknown",
        customerId: p.customer_id as string,
        amount: p.amount as number,
        productName: "",
        quantity: 0,
        unitPrice: 0,
        created_at: p.created_at as string,
      });
    });

    ledger.sort((a, b) => {
      const dateComp = a.date.localeCompare(b.date);
      if (dateComp !== 0) return dateComp;
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });

    setEntries(ledger);

    // Calculate brought-forward balance for selected customer
    if (filterCustomer !== "all") {
      // Get all credit sales BEFORE the filter period
      const { data: priorSales } = await db
        .from("sales")
        .select("total_amount")
        .eq("payment_method", "credit")
        .eq("voided", false)
        .eq("customer_id", filterCustomer)
        .lt("sale_date", filterFrom);

      const priorSalesTotal = ((priorSales || []) as any[]).reduce((sum: number, s: any) => sum + s.total_amount, 0);

      // Get all payments BEFORE the filter period
      const { data: priorPayments } = await db
        .from("customer_payments")
        .select("amount")
        .eq("customer_id", filterCustomer)
        .lt("payment_date", filterFrom);

      const priorPaymentsTotal = ((priorPayments || []) as any[]).reduce((sum: number, p: any) => sum + p.amount, 0);

      setBroughtForward(priorSalesTotal - priorPaymentsTotal);
    }

    setLoading(false);
  }

  // Build grouped lines for table view (when a customer is selected)
  function buildGroupedLines(): GroupedLine[] {
    const lines: GroupedLine[] = [];

    // Group credit sales by date + product
    const groupKey = (e: LedgerEntry) => `${e.date}|${e.productName}`;
    const groups = new Map<string, { date: string; productName: string; quantity: number; unitPrice: number; total: number }>();

    for (const e of entries) {
      if (e.type === "credit_sale") {
        const key = groupKey(e);
        const existing = groups.get(key);
        if (existing) {
          existing.quantity += e.quantity;
          existing.total += e.amount;
        } else {
          groups.set(key, {
            date: e.date,
            productName: e.productName,
            quantity: e.quantity,
            unitPrice: e.unitPrice,
            total: e.amount,
          });
        }
      } else if (e.type === "payment") {
        // Payments don't group — add as-is with a unique key
        lines.push({
          date: e.date,
          type: "payment",
          productName: "Payment received",
          quantity: 0,
          unitPrice: 0,
          total: e.amount,
        });
      }
    }

    // Convert groups to lines
    for (const g of groups.values()) {
      lines.push({
        date: g.date,
        type: "credit_sale",
        productName: g.productName,
        quantity: g.quantity,
        unitPrice: g.unitPrice,
        total: g.total,
      });
    }

    // Sort by date, then type (brought_forward first, then sales, then payments)
    lines.sort((a, b) => {
      const dateComp = a.date.localeCompare(b.date);
      if (dateComp !== 0) return dateComp;
      if (a.type === "payment" && b.type !== "payment") return 1;
      if (a.type !== "payment" && b.type === "payment") return -1;
      return a.productName.localeCompare(b.productName);
    });

    return lines;
  }

  const totalCreditSales = entries
    .filter((e) => e.type === "credit_sale")
    .reduce((sum, e) => sum + e.amount, 0);
  const totalPayments = entries
    .filter((e) => e.type === "payment")
    .reduce((sum, e) => sum + e.amount, 0);
  const totalOutstanding = customers.reduce((sum, c) => sum + c.balance, 0);

  const selectedCustomer = customers.find((c) => c.id === filterCustomer);
  const groupedLines = filterCustomer !== "all" ? buildGroupedLines() : [];
  const periodBalance = broughtForward + totalCreditSales - totalPayments;

  async function sendWhatsAppStatement() {
    if (!selectedCustomer?.phone) return;
    const today = new Date().toLocaleDateString("en-ZA");
    let msg = `*Statement*\nDate: ${today}\nCustomer: ${selectedCustomer.name}\n\n`;

    if (broughtForward > 0) {
      msg += `Brought forward: ${formatZAR(broughtForward)}\n\n`;
    }

    for (const line of groupedLines) {
      if (line.type === "credit_sale") {
        msg += `${formatDate(line.date)} — ${line.quantity}× ${line.productName} @ ${formatZAR(line.unitPrice)} = ${formatZAR(line.total)}\n`;
      } else if (line.type === "payment") {
        msg += `${formatDate(line.date)} — Payment received: +${formatZAR(line.total)}\n`;
      }
    }

    msg += `\n*Total Outstanding: ${formatZAR(selectedCustomer.balance)}*\n`;

    const { data } = await db.from("app_settings").select("value").eq("key", "ikhokha_link").single();
    if (data?.value) {
      msg += `\nPay online: ${data.value}\n`;
    }
    msg += `\nPlease settle your account at your earliest convenience. Thank you!`;

    const phone = selectedCustomer.phone.replace(/[^0-9]/g, "");
    const intlPhone = phone.startsWith("0") ? "27" + phone.slice(1) : phone;
    window.open(`https://wa.me/${intlPhone}?text=${encodeURIComponent(msg)}`, "_blank");
  }

  function exportToExcel() {
    const bom = "﻿";
    const lines: string[] = [];

    if (filterCustomer !== "all" && selectedCustomer) {
      // Single customer export
      lines.push(`Credit Ledger Statement`);
      lines.push(`Customer,${selectedCustomer.name}`);
      lines.push(`Period,${filterFrom} to ${filterTo}`);
      lines.push(`Exported,${new Date().toLocaleDateString("en-ZA")}`);
      lines.push(``);
      lines.push(`Date,Description,Qty,Unit Price,Total`);

      if (broughtForward > 0) {
        lines.push(`Before ${filterFrom},Balance brought forward,,,${broughtForward.toFixed(2)}`);
      }

      for (const line of groupedLines) {
        if (line.type === "payment") {
          lines.push(`${line.date},Payment received,,,${(-line.total).toFixed(2)}`);
        } else {
          lines.push(`${line.date},"${line.productName}",${line.quantity},${line.unitPrice.toFixed(2)},${line.total.toFixed(2)}`);
        }
      }

      lines.push(``);
      lines.push(`,,,,`);
      lines.push(`,Total Outstanding,,,${Math.max(periodBalance, 0).toFixed(2)}`);
    } else {
      // All customers export
      lines.push(`Credit Ledger`);
      lines.push(`Period,${filterFrom} to ${filterTo}`);
      lines.push(`Exported,${new Date().toLocaleDateString("en-ZA")}`);
      lines.push(``);
      lines.push(`Date,Customer,Type,Description,Amount`);

      for (const entry of entries) {
        const desc = entry.type === "credit_sale"
          ? `${entry.quantity}x ${entry.productName} @ ${formatZAR(entry.unitPrice)}`
          : "Payment received";
        const amt = entry.type === "payment" ? entry.amount.toFixed(2) : (-entry.amount).toFixed(2);
        lines.push(`${entry.date},"${entry.customerName}",${entry.type === "payment" ? "Payment" : "Credit Sale"},"${desc}",${amt}`);
      }

      lines.push(``);
      lines.push(`,,,,`);
      lines.push(`,,,Total Credit Sales,${(-totalCreditSales).toFixed(2)}`);
      lines.push(`,,,Total Payments,${totalPayments.toFixed(2)}`);
    }

    const csv = bom + lines.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const customerName = selectedCustomer ? selectedCustomer.name.replace(/\s+/g, "_") : "all_customers";
    a.download = `credit_ledger_${customerName}_${filterFrom}_to_${filterTo}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

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
        <button
          onClick={exportToExcel}
          disabled={entries.length === 0 && broughtForward <= 0}
          className="flex items-center gap-1.5 px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Download className="w-4 h-4" />
          Export
        </button>
      </div>

      {/* Ledger content */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading...</div>
      ) : filterCustomer !== "all" && selectedCustomer ? (
        /* ── TABLE VIEW: specific customer selected ── */
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          {/* Customer header */}
          <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center text-red-600 font-semibold text-sm">
                {selectedCustomer.name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()}
              </div>
              <div>
                <p className="font-semibold text-gray-900">{selectedCustomer.name}</p>
                <p className="text-xs text-gray-500">Balance: {formatZAR(selectedCustomer.balance)}</p>
              </div>
            </div>
            {selectedCustomer.phone && selectedCustomer.balance > 0 && (
              <button
                onClick={sendWhatsAppStatement}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-green-50 hover:border-green-300 transition-colors"
              >
                <MessageCircle className="w-4 h-4 text-green-600" />
                Statement
              </button>
            )}
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Date</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Description</th>
                  <th className="text-right px-3 py-3 font-medium text-gray-500">Qty</th>
                  <th className="text-right px-3 py-3 font-medium text-gray-500">Unit price</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-500">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {/* Brought forward line */}
                {broughtForward > 0 && (
                  <tr className="bg-amber-50/50">
                    <td className="px-4 py-3 text-gray-500 text-xs">Before {formatDate(filterFrom)}</td>
                    <td className="px-4 py-3 font-medium text-amber-800">
                      <ArrowUpRight className="w-3.5 h-3.5 inline mr-1.5 -mt-0.5" />
                      Balance brought forward
                    </td>
                    <td className="px-3 py-3 text-right"></td>
                    <td className="px-3 py-3 text-right"></td>
                    <td className="px-4 py-3 text-right font-semibold text-amber-700">{formatZAR(broughtForward)}</td>
                  </tr>
                )}

                {/* Grouped lines */}
                {groupedLines.map((line, idx) => (
                  <tr
                    key={idx}
                    className={line.type === "payment" ? "bg-green-50/30" : ""}
                  >
                    <td className="px-4 py-3 text-gray-500">{formatDate(line.date)}</td>
                    {line.type === "payment" ? (
                      <>
                        <td className="px-4 py-3 font-medium text-green-700">
                          <ArrowDownLeft className="w-3.5 h-3.5 inline mr-1.5 -mt-0.5" />
                          Payment received
                        </td>
                        <td className="px-3 py-3 text-right"></td>
                        <td className="px-3 py-3 text-right"></td>
                        <td className="px-4 py-3 text-right font-semibold text-green-700">+{formatZAR(line.total)}</td>
                      </>
                    ) : (
                      <>
                        <td className="px-4 py-3 text-gray-900">{line.productName}</td>
                        <td className="px-3 py-3 text-right text-gray-900">{line.quantity}</td>
                        <td className="px-3 py-3 text-right text-gray-500">{formatZAR(line.unitPrice)}</td>
                        <td className="px-4 py-3 text-right font-semibold text-red-700">{formatZAR(line.total)}</td>
                      </>
                    )}
                  </tr>
                ))}

                {groupedLines.length === 0 && !broughtForward && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                      No transactions for this period.
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-300 bg-gray-50">
                  <td colSpan={4} className="px-4 py-3 text-right font-semibold text-gray-700">Total outstanding</td>
                  <td className="px-4 py-3 text-right font-bold text-lg text-red-700">{formatZAR(Math.max(periodBalance, 0))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      ) : entries.length === 0 ? (
        /* ── EMPTY STATE ── */
        <div className="text-center py-12 text-gray-400">
          <BookOpen className="w-12 h-12 mx-auto mb-3 opacity-50" />
          <p>No credit transactions for this period.</p>
        </div>
      ) : (
        /* ── CARD VIEW: all customers ── */
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
                  <p className="text-sm text-gray-500">
                    {entry.type === "credit_sale"
                      ? `${entry.quantity}× ${entry.productName} @ ${formatZAR(entry.unitPrice)}`
                      : "Payment received"}
                  </p>
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
