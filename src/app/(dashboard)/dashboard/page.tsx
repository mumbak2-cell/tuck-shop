"use client";
import { useEffect, useState, useCallback } from "react";
import { db } from "@/lib/supabase";
import { formatZAR } from "@/lib/format";
import Link from "next/link";
import {
  Package,
  ShoppingCart,
  AlertTriangle,
  Users,
  Wallet,
  ArrowRight,
  Banknote,
  CreditCard,
  Download,
  FileSpreadsheet,
  Receipt,
} from "lucide-react";

interface DashboardData {
  totalProducts: number;
  inStockProducts: number;
  lowStockCount: number;
  lowStockItems: { name: string; stock: number; reorder: number }[];
  todaySales: number;
  todayTransactions: number;
  todayCash: number;
  todayCard: number;
  todayCredit: number;
  totalCustomers: number;
  creditOutstanding: number;
  recentSales: { id: string; product_name: string; quantity: number; total_amount: number; payment_method: string; created_at: string }[];
  monthlyExpenses: number;
  monthlyOperating: number;
  monthlyDirectorW: number;
  expenseBreakdown: { category: string; total: number }[];
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  const today = new Date().toISOString().split("T")[0];

  const fetchDashboard = useCallback(async () => {
    setLoading(true);

    // Get first of month for expenses query
    const monthStart = (() => { const d = new Date(); d.setDate(1); return d.toISOString().split("T")[0]; })();

    const [productsRes, salesRes, customersRes, recentRes, expensesRes] = await Promise.all([
      db.from("products").select("name, opening_stock, reorder_level, selling_price, cost_per_unit, discontinued").eq("discontinued", false),
      db.from("sales").select("total_amount, payment_method").eq("sale_date", today).eq("voided", false),
      db.from("customers").select("balance"),
      db.from("sales").select("id, quantity, total_amount, payment_method, created_at, products(name)").eq("sale_date", today).eq("voided", false).order("created_at", { ascending: false }).limit(10),
      db.from("expenses").select("category, amount").gte("expense_date", monthStart).lte("expense_date", today),
    ]);

    const products: any[] = productsRes.data || [];
    const sales: any[] = salesRes.data || [];
    const customers: any[] = customersRes.data || [];
    const recent = (recentRes.data || []) as { id: string; quantity: number; total_amount: number; payment_method: string; created_at: string; products: { name: string } | null }[];

    const lowStockItems = products
      .filter((p: any) => p.opening_stock <= p.reorder_level && p.reorder_level > 0)
      .sort((a: any, b: any) => a.opening_stock - b.opening_stock)
      .slice(0, 8)
      .map((p: any) => ({ name: p.name, stock: p.opening_stock, reorder: p.reorder_level }));

    const cash = sales.filter((s: any) => s.payment_method === "cash").reduce((sum: number, s: any) => sum + s.total_amount, 0);
    const card = sales.filter((s: any) => s.payment_method === "card").reduce((sum: number, s: any) => sum + s.total_amount, 0);
    const credit = sales.filter((s: any) => s.payment_method === "credit").reduce((sum: number, s: any) => sum + s.total_amount, 0);

    // Process expenses
    const expensesData: any[] = expensesRes.data || [];
    let monthlyOperating = 0, monthlyDirectorW = 0;
    const expCatTotals: Record<string, number> = {};
    expensesData.forEach((e: any) => {
      expCatTotals[e.category] = (expCatTotals[e.category] || 0) + e.amount;
      if (e.category === "Director Withdrawal") monthlyDirectorW += e.amount;
      else monthlyOperating += e.amount;
    });
    const expenseBreakdown = Object.entries(expCatTotals)
      .map(([category, total]) => ({ category, total }))
      .sort((a, b) => b.total - a.total);

    setData({
      totalProducts: products.length,
      inStockProducts: products.filter((p: any) => p.opening_stock > 0).length,
      lowStockCount: lowStockItems.length,
      lowStockItems,
      todaySales: cash + card + credit,
      todayTransactions: sales.length,
      todayCash: cash,
      todayCard: card,
      todayCredit: credit,
      totalCustomers: customers.length,
      creditOutstanding: customers.reduce((sum: number, c: any) => sum + c.balance, 0),
      recentSales: recent.map((r) => ({
        id: r.id,
        product_name: r.products?.name || "Unknown",
        quantity: r.quantity,
        total_amount: r.total_amount,
        payment_method: r.payment_method,
        created_at: r.created_at,
      })),
      monthlyExpenses: monthlyOperating + monthlyDirectorW,
      monthlyOperating,
      monthlyDirectorW,
      expenseBreakdown,
    });

    setLoading(false);
  }, [today]);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  if (loading || !data) {
    return <div className="text-center py-12 text-gray-400">Loading...</div>;
  }

  return (
    <div className="max-w-5xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Dashboard</h1>

      {/* Top stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard label="Today's Sales" value={formatZAR(data.todaySales)} sub={`${data.todayTransactions} transactions`} icon={ShoppingCart} color="bg-green-600" />
        <StatCard label="Products" value={`${data.inStockProducts} in stock`} sub={`${data.totalProducts} total`} icon={Package} color="bg-blue-600" />
        <StatCard label="Low Stock" value={data.lowStockCount.toString()} sub="need restocking" icon={AlertTriangle} color={data.lowStockCount > 0 ? "bg-red-600" : "bg-gray-400"} />
        <StatCard label="Credit Owed" value={formatZAR(data.creditOutstanding)} sub={`${data.totalCustomers} customers`} icon={Wallet} color="bg-amber-500" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Sales breakdown */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-gray-900">Today&apos;s Sales Breakdown</h2>
            <Link href="/sales" className="text-sm text-green-600 hover:underline flex items-center gap-1">
              View <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
          {data.todayTransactions === 0 ? (
            <p className="text-sm text-gray-400 py-4 text-center">No sales today yet. Open the <Link href="/pos" className="text-green-600 underline">POS</Link> to start selling.</p>
          ) : (
            <div className="space-y-3">
              <SalesBar label="Cash" amount={data.todayCash} total={data.todaySales} icon={Banknote} color="bg-green-500" />
              <SalesBar label="Card (iKhokha)" amount={data.todayCard} total={data.todaySales} icon={CreditCard} color="bg-blue-500" />
              <SalesBar label="Credit" amount={data.todayCredit} total={data.todaySales} icon={Users} color="bg-amber-500" />
              <div className="pt-3 border-t border-gray-100 flex justify-between text-sm font-semibold">
                <span>Total</span>
                <span>{formatZAR(data.todaySales)}</span>
              </div>
            </div>
          )}
        </div>

        {/* Low stock alerts */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-gray-900">Low Stock Alerts</h2>
            <Link href="/stock" className="text-sm text-green-600 hover:underline flex items-center gap-1">
              Stock Count <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
          {data.lowStockItems.length === 0 ? (
            <p className="text-sm text-gray-400 py-4 text-center">All products are above reorder level.</p>
          ) : (
            <div className="space-y-2">
              {data.lowStockItems.map((item) => (
                <div key={item.name} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                  <span className="text-sm text-gray-900 truncate flex-1">{item.name}</span>
                  <div className="flex items-center gap-3 text-sm">
                    <span className={`font-semibold ${item.stock === 0 ? "text-red-600" : "text-amber-600"}`}>
                      {item.stock} left
                    </span>
                    <span className="text-gray-400 text-xs">min {item.reorder}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Monthly Expenses Summary */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-gray-900">Monthly Expenses</h2>
            <Link href="/expenses" className="text-sm text-green-600 hover:underline flex items-center gap-1">
              View All <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
          {data.monthlyExpenses === 0 ? (
            <p className="text-sm text-gray-400 py-4 text-center">No expenses recorded this month.</p>
          ) : (
            <div className="space-y-4">
              {/* Totals row */}
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-red-50 rounded-lg px-4 py-3">
                  <p className="text-xs text-red-600">Total Outflows</p>
                  <p className="text-lg font-bold text-red-700">{formatZAR(data.monthlyExpenses)}</p>
                </div>
                <div className="bg-gray-50 rounded-lg px-4 py-3">
                  <p className="text-xs text-gray-500">Operating</p>
                  <p className="text-lg font-bold text-gray-900">{formatZAR(data.monthlyOperating)}</p>
                </div>
                <div className="bg-amber-50 rounded-lg px-4 py-3">
                  <p className="text-xs text-amber-600">Director W/D</p>
                  <p className="text-lg font-bold text-amber-700">{formatZAR(data.monthlyDirectorW)}</p>
                </div>
              </div>
              {/* Category breakdown */}
              <div className="space-y-2">
                {data.expenseBreakdown.map((e) => (
                  <div key={e.category} className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <Receipt className="w-3.5 h-3.5 text-gray-400" />
                      <span className="text-gray-700">{e.category}</span>
                    </div>
                    <span className="font-medium text-gray-900">{formatZAR(e.total)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Recent transactions */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-gray-900">Recent Transactions</h2>
            <Link href="/sales" className="text-sm text-green-600 hover:underline flex items-center gap-1">
              All Sales <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
          {data.recentSales.length === 0 ? (
            <p className="text-sm text-gray-400 py-4 text-center">No transactions today.</p>
          ) : (
            <div className="space-y-2">
              {data.recentSales.map((sale) => (
                <div key={sale.id} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{sale.product_name}</p>
                    <p className="text-xs text-gray-500">
                      Qty {sale.quantity} · {sale.payment_method === "card" ? "Card" : sale.payment_method === "credit" ? "Credit" : "Cash"}
                      {" · "}{new Date(sale.created_at).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" })}
                    </p>
                  </div>
                  <span className="text-sm font-semibold text-gray-900">{formatZAR(sale.total_amount)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Reports section */}
      <div className="mt-6 bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center gap-2 mb-4">
          <FileSpreadsheet className="w-5 h-5 text-green-600" />
          <h2 className="font-semibold text-gray-900">Download Reports</h2>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <ReportButton label="Daily Sales" onClick={() => downloadDailySalesReport(today)} />
          <ReportButton label="Stock Levels" onClick={downloadStockReport} />
          <ReportButton label="Credit Outstanding" onClick={downloadCreditReport} />
          <ReportButton label="Full P&L" onClick={() => downloadPnLReport(today)} />
        </div>
      </div>

      {/* Quick actions */}
      <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <QuickAction href="/pos" label="Open POS" icon={ShoppingCart} />
        <QuickAction href="/products" label="Manage Products" icon={Package} />
        <QuickAction href="/stock" label="Stock Count" icon={AlertTriangle} />
        <QuickAction href="/customers" label="Customers" icon={Users} />
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, icon: Icon, color }: {
  label: string;
  value: string;
  sub: string;
  icon: React.ElementType;
  color: string;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="flex items-center gap-3">
        <div className={`p-2.5 rounded-lg ${color}`}>
          <Icon className="w-5 h-5 text-white" />
        </div>
        <div className="min-w-0">
          <p className="text-xs text-gray-500">{label}</p>
          <p className="text-lg font-bold text-gray-900 truncate">{value}</p>
          <p className="text-xs text-gray-400">{sub}</p>
        </div>
      </div>
    </div>
  );
}

function SalesBar({ label, amount, total, icon: Icon, color }: {
  label: string;
  amount: number;
  total: number;
  icon: React.ElementType;
  color: string;
}) {
  const pct = total > 0 ? (amount / total) * 100 : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-sm mb-1">
        <span className="flex items-center gap-2 text-gray-700">
          <Icon className="w-4 h-4" />
          {label}
        </span>
        <span className="font-medium">{formatZAR(amount)}</span>
      </div>
      <div className="w-full bg-gray-100 rounded-full h-2">
        <div className={`${color} h-2 rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ReportButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 bg-gray-50 rounded-lg border border-gray-200 p-3 hover:border-green-300 hover:bg-green-50 transition-colors touch-manipulation text-sm font-medium text-gray-700"
    >
      <Download className="w-4 h-4 text-green-600" />
      {label}
    </button>
  );
}

function downloadCSV(filename: string, header: string, rows: string[]) {
  // BOM for Excel UTF-8 compatibility
  const bom = "﻿";
  const csv = bom + [header, ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function downloadDailySalesReport(date: string) {
  const { data: sales } = await db
    .from("sales")
    .select("sale_date, quantity, unit_price, total_amount, payment_method, created_at, products(name, inventory_id)")
    .eq("sale_date", date)
    .eq("voided", false)
    .order("created_at");

  const header = "Time,Inventory ID,Product,Qty,Unit Price,Total,Payment Method";
  const rows = (sales || []).map((s: Record<string, unknown>) => {
    const prod = s.products as { name: string; inventory_id: string } | null;
    const time = new Date(s.created_at as string).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" });
    return `${time},${prod?.inventory_id || ""},\"${prod?.name || "Unknown"}\",${s.quantity},${(s.unit_price as number).toFixed(2)},${(s.total_amount as number).toFixed(2)},${s.payment_method}`;
  });
  downloadCSV(`daily_sales_${date}.csv`, header, rows);
}

async function downloadStockReport() {
  const { data: products } = await db
    .from("products")
    .select("inventory_id, name, category, opening_stock, reorder_level, selling_price, package_price, qty_in_pack")
    .eq("discontinued", false)
    .order("inventory_id");

  const header = "Inventory ID,Category,Product,Stock,Reorder Level,Selling Price,Package Price,Qty In Pack";
  const rows = ((products || []) as any[]).map((p: any) =>
    `${p.inventory_id},\"${p.category}\",\"${p.name}\",${p.opening_stock},${p.reorder_level},${p.selling_price},${p.package_price || 0},${p.qty_in_pack || 0}`
  );
  downloadCSV(`stock_levels_${new Date().toISOString().split("T")[0]}.csv`, header, rows);
}

async function downloadCreditReport() {
  const { data: customers } = await db
    .from("customers")
    .select("name, phone, credit_limit, balance")
    .gt("balance", 0)
    .order("balance", { ascending: false });

  const header = "Customer,Phone,Credit Limit,Balance Owed";
  const rows = ((customers || []) as any[]).map((c: any) =>
    `\"${c.name}\",${c.phone || ""},${c.credit_limit.toFixed(2)},${c.balance.toFixed(2)}`
  );
  downloadCSV(`credit_outstanding_${new Date().toISOString().split("T")[0]}.csv`, header, rows);
}

async function downloadPnLReport(date: string) {
  // Get first of month to today
  const d = new Date();
  d.setDate(1);
  const from = d.toISOString().split("T")[0];
  const to = date;

  const [{ data: sales }, { data: expenses }, { data: products }] = await Promise.all([
    db.from("sales").select("payment_method, total_amount, quantity, product_id").gte("sale_date", from).lte("sale_date", to).eq("voided", false),
    db.from("expenses").select("category, amount").gte("expense_date", from).lte("expense_date", to),
    db.from("products").select("id, package_price, qty_in_pack"),
  ]);

  let cash = 0, card = 0, credit = 0;
  ((sales || []) as any[]).forEach((s: any) => {
    if (s.payment_method === "cash") cash += s.total_amount;
    else if (s.payment_method === "card") card += s.total_amount;
    else credit += s.total_amount;
  });
  const totalRevenue = cash + card + credit;

  const costMap: Record<string, number> = {};
  ((products || []) as any[]).forEach((p: any) => {
    costMap[p.id] = p.qty_in_pack && p.qty_in_pack > 0 && p.package_price ? p.package_price / p.qty_in_pack : 0;
  });
  let cogs = 0;
  ((sales || []) as any[]).forEach((s: any) => { cogs += (costMap[s.product_id] || 0) * s.quantity; });

  const catTotals: Record<string, number> = {};
  let opex = 0, dirW = 0;
  ((expenses || []) as any[]).forEach((e: any) => {
    catTotals[e.category] = (catTotals[e.category] || 0) + e.amount;
    if (e.category === "Director Withdrawal") dirW += e.amount;
    else opex += e.amount;
  });

  const grossProfit = totalRevenue - cogs;
  const netProfit = grossProfit - opex - dirW;

  const header = "Line Item,Amount (R)";
  const rows = [
    `Cash Sales,${cash.toFixed(2)}`,
    `Card Sales,${card.toFixed(2)}`,
    `Credit Sales,${credit.toFixed(2)}`,
    `Total Revenue,${totalRevenue.toFixed(2)}`,
    ``,
    `Cost of Goods Sold,${cogs.toFixed(2)}`,
    `Gross Profit,${grossProfit.toFixed(2)}`,
    ``,
    ...Object.entries(catTotals).filter(([c]) => c !== "Director Withdrawal").map(([c, a]) => `${c},${a.toFixed(2)}`),
    `Total Operating Expenses,${opex.toFixed(2)}`,
    ``,
    `Director Withdrawals,${dirW.toFixed(2)}`,
    ``,
    `Net Profit,${netProfit.toFixed(2)}`,
  ];
  downloadCSV(`profit_loss_${from}_to_${to}.csv`, header, rows);
}

function QuickAction({ href, label, icon: Icon }: { href: string; label: string; icon: React.ElementType }) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 bg-white rounded-xl border border-gray-200 p-4 hover:border-green-300 hover:bg-green-50 transition-colors touch-manipulation"
    >
      <Icon className="w-5 h-5 text-green-600" />
      <span className="text-sm font-medium text-gray-900">{label}</span>
    </Link>
  );
}
