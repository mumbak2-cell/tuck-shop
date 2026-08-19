"use client";
// Free reporting page — no API calls, no LLM, no per-question cost.
//
// Every query runs client-side through `db` (the anon Supabase client), so RLS
// scopes reads to the user's org automatically, and the location filter scopes
// them to a branch. Cashiers (role="member") are pinned to their assigned
// location by org-context and by LocationFilter, so their reports are limited
// to their own shop; revenue/profit figures are gated behind a manager check
// so they never see branch- or org-wide takings.
//
// Revenue reads the snapshotted `sales.total_amount` and cost reads
// `sales.cost_price` (both captured at sale time via submit_sale_batch) —
// never recomputed from products.selling_price — per the sales-snapshot
// invariant in CLAUDE.md.
import { useState, useEffect } from "react";
import { db } from "@/lib/supabase";
import { fetchAllPaged } from "@/lib/fetch-all";
import { formatZAR } from "@/lib/format";
import {
  BarChart3,
  TrendingDown,
  PackageX,
  Trophy,
  Download,
  Store,
  ChevronDown,
  ArrowUpRight,
  ArrowDownRight,
  Banknote,
  Wallet,
} from "lucide-react";
import { paymentBucket } from "@/lib/payment-buckets";
import { LocationFilter, LOCATION_FILTER_ALL } from "@/components/locations/location-filter";
import { useOrg } from "@/lib/org-context";
import { localToday, localMonthStart, localWeekStart } from "@/lib/date-utils";

type Period = "today" | "week" | "month" | "custom";

interface SellerRow {
  productId: string;
  name: string;
  qty: number;
  revenue: number;
}

interface StockRow {
  productId: string;
  name: string;
  quantity: number;
}

interface DayRevenue {
  date: string;
  revenue: number;
}

interface MoverRow {
  productId: string;
  name: string;
  stock: number;
  sold: number;
}

interface BranchRow {
  locationId: string;
  name: string;
  revenue: number;
}

// One day of money actually received. Credit SALES are deliberately absent:
// a sale on account is a receivable, not intake, and counting it would
// overstate the till. It arrives later as a repayment instead.
// Money leaving the business. Deliberately cash-basis, unlike Profit & Loss:
// a delivery is money out the day it is paid for, whether or not the stock has
// sold. Stock bought on account is excluded until settled.
interface SpendRow {
  label: string;
  amount: number;
}

interface IntakeRow {
  date: string;
  cash: number;
  electronic: number;
  repayments: number;
}

export default function ReportsPage() {
  const { role, assignedLocationId, currentLocationId, currentLocationName, locations, lowStockThreshold, can } = useOrg();
  const isManager = can("view_reports");

  const [locFilter, setLocFilter] = useState<string>(LOCATION_FILTER_ALL);
  const effectiveLoc = role === "member" ? (assignedLocationId || currentLocationId || LOCATION_FILTER_ALL) : locFilter;
  const isFiltered = effectiveLoc !== LOCATION_FILTER_ALL;
  const filteredLocName = isFiltered ? (locations.find((l) => l.id === effectiveLoc)?.name || "") : "";

  const [period, setPeriod] = useState<Period>("month");
  const [customFrom, setCustomFrom] = useState(localMonthStart);
  const [customTo, setCustomTo] = useState(localToday);
  const [loading, setLoading] = useState(true);

  const [revenue, setRevenue] = useState(0);
  const [cogs, setCogs] = useState(0);
  const [txnCount, setTxnCount] = useState(0);
  const [prevRevenue, setPrevRevenue] = useState(0);
  const [prevTxn, setPrevTxn] = useState(0);
  const [topSellers, setTopSellers] = useState<SellerRow[]>([]);
  const [slowestMovers, setSlowestMovers] = useState<MoverRow[]>([]);
  const [revenueByDay, setRevenueByDay] = useState<DayRevenue[]>([]);
  const [allProductSales, setAllProductSales] = useState<SellerRow[]>([]); // full breakdown for CSV
  const [branchPerf, setBranchPerf] = useState<BranchRow[]>([]);
  const [intakeByDay, setIntakeByDay] = useState<IntakeRow[]>([]);
  const [creditSales, setCreditSales] = useState(0);
  const [repaymentsFailed, setRepaymentsFailed] = useState(false);
  const [stockCashOut, setStockCashOut] = useState(0);
  const [stockOnAccount, setStockOnAccount] = useState(0);
  const [stockElectronic, setStockElectronic] = useState(0);
  const [expenseSpend, setExpenseSpend] = useState<SpendRow[]>([]);
  const [stockPurchaseExpenses, setStockPurchaseExpenses] = useState(0);
  const [lowStock, setLowStock] = useState<StockRow[]>([]);

  useEffect(() => {
    loadReports();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, customFrom, customTo, effectiveLoc, isFiltered, isManager, lowStockThreshold]);

  function getDateRange(): { from: string; to: string } {
    const today = localToday();
    if (period === "today") return { from: today, to: today };
    if (period === "week") return { from: localWeekStart(), to: today };
    if (period === "month") return { from: localMonthStart(), to: today };
    return { from: customFrom, to: customTo };
  }

  async function loadReports() {
    setLoading(true);
    setRepaymentsFailed(false);

    // --- Stock (everyone) — aggregated per product across the scoped branch(es).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stockRows = await fetchAllPaged<any>(() => {
      let q = db.from("product_stock").select("product_id, quantity, products(name)");
      if (isFiltered) q = q.eq("location_id", effectiveLoc);
      return q;
    });
    const stockByProduct = new Map<string, StockRow>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (stockRows as any[]).forEach((r: any) => {
      const cur = stockByProduct.get(r.product_id) ?? {
        productId: r.product_id,
        name: r.products?.name || "—",
        quantity: 0,
      };
      cur.quantity += Number(r.quantity) || 0;
      stockByProduct.set(r.product_id, cur);
    });
    const stockList = [...stockByProduct.values()];
    setLowStock(
      stockList
        .filter((r) => r.quantity >= 0 && r.quantity <= lowStockThreshold)
        .sort((a, b) => a.quantity - b.quantity)
    );

    // --- Sales (managers only) — revenue, profit, trend, movers, branch mix.
    if (!isManager) {
      setRevenue(0);
      setCogs(0);
      setTxnCount(0);
      setPrevRevenue(0);
      setPrevTxn(0);
      setTopSellers([]);
      setSlowestMovers([]);
      setRevenueByDay([]);
      setAllProductSales([]);
      setBranchPerf([]);
      setIntakeByDay([]);
      setCreditSales(0);
      setStockCashOut(0);
      setStockOnAccount(0);
      setStockElectronic(0);
      setExpenseSpend([]);
      setStockPurchaseExpenses(0);
      setLoading(false);
      return;
    }

    const { from, to } = getDateRange();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sales = await fetchAllPaged<any>(() => {
      let q = db
        .from("sales")
        .select("sale_date, product_id, quantity, total_amount, cost_price, location_id, payment_method, products(name)")
        .gte("sale_date", from)
        .lte("sale_date", to)
        .eq("voided", false);
      if (isFiltered) q = q.eq("location_id", effectiveLoc);
      return q;
    });

    const byProduct = new Map<string, SellerRow>();
    const dayMap = new Map<string, number>();
    const locMap = new Map<string, number>();
    const cashByDay = new Map<string, number>();
    const electronicByDay = new Map<string, number>();
    let totalRevenue = 0;
    let totalCogs = 0;
    let totalCreditSales = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sales as any[]).forEach((s: any) => {
      const rev = Number(s.total_amount) || 0;
      totalRevenue += rev;
      totalCogs += (Number(s.cost_price) || 0) * (Number(s.quantity) || 0);
      dayMap.set(s.sale_date, (dayMap.get(s.sale_date) ?? 0) + rev);
      if (s.location_id) locMap.set(s.location_id, (locMap.get(s.location_id) ?? 0) + rev);

      // Split the day's takings by how the customer actually paid. `sales` holds
      // one row per line item, each carrying its own total_amount, so summing
      // rows is the sale total — no double counting.
      const bucket = paymentBucket(s.payment_method);
      if (bucket === "cash") {
        cashByDay.set(s.sale_date, (cashByDay.get(s.sale_date) ?? 0) + rev);
      } else if (bucket === "card") {
        electronicByDay.set(s.sale_date, (electronicByDay.get(s.sale_date) ?? 0) + rev);
      } else {
        totalCreditSales += rev;
      }
      const cur = byProduct.get(s.product_id) ?? {
        productId: s.product_id,
        name: s.products?.name || "—",
        qty: 0,
        revenue: 0,
      };
      cur.qty += Number(s.quantity) || 0;
      cur.revenue += rev;
      byProduct.set(s.product_id, cur);
    });

    const sorted = [...byProduct.values()].sort((a, b) => b.revenue - a.revenue);
    setRevenue(totalRevenue);
    setCogs(totalCogs);
    setTxnCount(sales.length);
    setTopSellers(sorted.slice(0, 10));
    setAllProductSales(sorted);
    setRevenueByDay(enumerateDays(from, to).map((date) => ({ date, revenue: dayMap.get(date) ?? 0 })));

    // Slowest movers: in-stock products that sold the fewest units (dead stock first).
    setSlowestMovers(
      stockList
        .filter((s) => s.quantity > 0)
        .map((s) => ({ productId: s.productId, name: s.name, stock: s.quantity, sold: byProduct.get(s.productId)?.qty ?? 0 }))
        .sort((a, b) => a.sold - b.sold || b.stock - a.stock)
        .slice(0, 10)
    );

    // Branch performance — only meaningful when viewing all branches of a chain.
    if (locations.length > 1 && !isFiltered) {
      setBranchPerf(
        [...locMap.entries()]
          .map(([locationId, rev]) => ({
            locationId,
            name: locations.find((l) => l.id === locationId)?.name || "—",
            revenue: rev,
          }))
          .sort((a, b) => b.revenue - a.revenue)
      );
    } else {
      setBranchPerf([]);
    }

    // Credit repayments — money through the door that never appears in `sales`.
    // Without these a cash-intake figure won't reconcile with the till on any
    // day a customer settles their account. customer_payments records no
    // payment method, so these are reported as their own line rather than
    // folded into cash, which would be a guess.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repayments = await fetchAllPaged<any>(() => {
      let q = db
        .from("customer_payments")
        .select("payment_date, amount")
        .gte("payment_date", from)
        .lte("payment_date", to);
      if (isFiltered) q = q.eq("location_id", effectiveLoc);
      return q;
    }).catch(() => {
      // Keep the page usable, but never let a failed read masquerade as
      // "no repayments" — an understated intake figure is worse than a gap.
      setRepaymentsFailed(true);
      return [];
    });

    const repaymentByDay = new Map<string, number>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (repayments as any[]).forEach((p: any) => {
      repaymentByDay.set(p.payment_date, (repaymentByDay.get(p.payment_date) ?? 0) + (Number(p.amount) || 0));
    });

    setCreditSales(totalCreditSales);
    setIntakeByDay(
      enumerateDays(from, to).map((date) => ({
        date,
        cash: cashByDay.get(date) ?? 0,
        electronic: electronicByDay.get(date) ?? 0,
        repayments: repaymentByDay.get(date) ?? 0,
      }))
    );

    // --- Cash spent: stock deliveries + operating expenses ---
    //
    // stock_receipts has no location_id, so these figures are org-wide even
    // when a branch filter is on. Labelled as such in the UI rather than
    // silently reporting one branch's expenses against every branch's stock.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const receipts = await fetchAllPaged<any>(() =>
      db
        .from("stock_receipts")
        .select("total_cost, paid_by")
        .gte("receipt_date", from)
        .lte("receipt_date", to)
    ).catch(() => []);

    let cashStock = 0, accountStock = 0, electronicStock = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (receipts as any[]).forEach((r: any) => {
      const amt = Number(r.total_cost) || 0;
      // Rows written before migration 054 have no paid_by; the migration
      // backfills them to 'cash', so an unread value here means the migration
      // has not run yet. Treat it as cash to match that backfill.
      if (r.paid_by === "account") accountStock += amt;
      else if (r.paid_by === "electronic") electronicStock += amt;
      else cashStock += amt;
    });
    setStockCashOut(cashStock);
    setStockOnAccount(accountStock);
    setStockElectronic(electronicStock);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spendExpenses = await fetchAllPaged<any>(() => {
      let q = db
        .from("expenses")
        .select("category, amount")
        .gte("expense_date", from)
        .lte("expense_date", to);
      if (isFiltered) q = q.eq("location_id", effectiveLoc);
      return q;
    }).catch(() => []);

    // "Stock Purchases" is held out of the total. Receive Stock writes that
    // expense automatically alongside the stock_receipts row (the checkbox
    // defaults to on), so counting both would double every delivery.
    //
    // "Ingredient Purchases" is deliberately NOT excluded here, even though
    // Profit & Loss excludes both. This report is cash basis: an ingredient
    // typed into Expenses has no stock_receipts row to duplicate, and the money
    // genuinely left the till that day. Do not "unify" these two lists.
    const spendByCategory = new Map<string, number>();
    let stockPurchaseTotal = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (spendExpenses as any[]).forEach((e: any) => {
      const amt = Number(e.amount) || 0;
      if (e.category === "Stock Purchases") {
        stockPurchaseTotal += amt;
        return;
      }
      spendByCategory.set(e.category, (spendByCategory.get(e.category) ?? 0) + amt);
    });
    setStockPurchaseExpenses(stockPurchaseTotal);
    setExpenseSpend(
      [...spendByCategory.entries()]
        .map(([label, amount]) => ({ label, amount }))
        .sort((a, b) => b.amount - a.amount)
    );

    // Previous equal-length window (momentum indicator).
    const prev = prevRange(from, to);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prevSales = await fetchAllPaged<any>(() => {
      let q = db
        .from("sales")
        .select("total_amount")
        .gte("sale_date", prev.from)
        .lte("sale_date", prev.to)
        .eq("voided", false);
      if (isFiltered) q = q.eq("location_id", effectiveLoc);
      return q;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setPrevRevenue((prevSales as any[]).reduce((sum: number, s: any) => sum + (Number(s.total_amount) || 0), 0));
    setPrevTxn(prevSales.length);

    setLoading(false);
  }

  function locSuffix() {
    return isFiltered && filteredLocName ? `-${slug(filteredLocName)}` : "";
  }

  function exportSales() {
    const { from, to } = getDateRange();
    downloadCsv(
      `tilify-sales-${from}_to_${to}${locSuffix()}.csv`,
      ["Product", "Units Sold", "Revenue"],
      allProductSales.map((s) => [s.name, String(s.qty), s.revenue.toFixed(2)])
    );
  }

  function exportSlowest() {
    const { from, to } = getDateRange();
    downloadCsv(
      `tilify-slowest-movers-${from}_to_${to}${locSuffix()}.csv`,
      ["Product", "Units Sold", "Current Stock"],
      slowestMovers.map((m) => [m.name, String(m.sold), String(m.stock)])
    );
  }

  function exportIntake() {
    const { from, to } = getDateRange();
    downloadCsv(
      `tilify-cash-intake-${from}_to_${to}${locSuffix()}.csv`,
      ["Date", "Cash", "Card / Electronic", "Credit Repayments", "Total Received"],
      intakeByDay.map((d) => [
        d.date,
        d.cash.toFixed(2),
        d.electronic.toFixed(2),
        d.repayments.toFixed(2),
        (d.cash + d.electronic + d.repayments).toFixed(2),
      ])
    );
  }

  function exportSpend() {
    const { from, to } = getDateRange();
    downloadCsv(
      `tilify-cash-spent-${from}_to_${to}${locSuffix()}.csv`,
      ["Item", "Amount", "Counted in total"],
      [
        ["Stock deliveries — cash", stockCashOut.toFixed(2), "yes"],
        ["Stock deliveries — EFT / card", stockElectronic.toFixed(2), "yes"],
        ...expenseSpend.map((r) => [r.label, r.amount.toFixed(2), "yes"]),
        ["Stock deliveries — on account (unpaid)", stockOnAccount.toFixed(2), "no"],
        ["\"Stock Purchases\" expenses (duplicates)", stockPurchaseExpenses.toFixed(2), "no"],
        ["TOTAL CASH SPENT", totalSpent.toFixed(2), ""],
      ]
    );
  }

  function exportLowStock() {
    downloadCsv(
      `tilify-low-stock-${localToday()}${locSuffix()}.csv`,
      ["Product", "Quantity"],
      lowStock.map((r) => [r.name, String(r.quantity)])
    );
  }

  const periods: { key: Period; label: string }[] = [
    { key: "today", label: "Today" },
    { key: "week", label: "This Week" },
    { key: "month", label: "This Month" },
    { key: "custom", label: "Custom" },
  ];

  const scopeLabel = isFiltered ? filteredLocName : currentLocationName || "your shop";
  const maxDayRevenue = revenueByDay.reduce((m, d) => Math.max(m, d.revenue), 0);

  // Derived exec metrics.
  const grossProfit = revenue - cogs;
  const margin = revenue > 0 ? (grossProfit / revenue) * 100 : 0;
  const avgSale = txnCount > 0 ? revenue / txnCount : 0;
  const top5Revenue = topSellers.slice(0, 5).reduce((s, p) => s + p.revenue, 0);
  const top5Share = revenue > 0 ? (top5Revenue / revenue) * 100 : 0;
  const productsSold = allProductSales.length;
  const totalCashIn = intakeByDay.reduce((s, d) => s + d.cash, 0);
  const totalElectronicIn = intakeByDay.reduce((s, d) => s + d.electronic, 0);
  const totalRepaymentsIn = intakeByDay.reduce((s, d) => s + d.repayments, 0);
  const totalReceived = totalCashIn + totalElectronicIn + totalRepaymentsIn;
  const totalOperatingSpend = expenseSpend.reduce((s, r) => s + r.amount, 0);
  // Cash basis: what actually left. Stock on account is excluded — it has not
  // been paid yet — and "Stock Purchases" expenses are excluded as duplicates
  // of the stock_receipts rows.
  const totalSpent = stockCashOut + stockElectronic + totalOperatingSpend;
  const zeroSellers = slowestMovers.filter((m) => m.sold === 0).length;

  return (
    <div>
      <div className="mb-6 flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <BarChart3 className="w-7 h-7 text-green-600" />
            Reports
            {isFiltered && filteredLocName && (
              <span className="ml-1 text-base font-normal text-gray-500">· {filteredLocName}</span>
            )}
          </h1>
          <p className="text-sm text-gray-500 mt-1">Organisation sales overview</p>
        </div>
        <LocationFilter value={locFilter} onChange={setLocFilter} />
      </div>

      {/* Period selector */}
      <div className="flex flex-wrap gap-2 mb-4">
        {periods.map((p) => (
          <button
            key={p.key}
            onClick={() => setPeriod(p.key)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              period === p.key ? "bg-green-600 text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {period === "custom" && (
        <div className="flex gap-3 mb-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">From</label>
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">To</label>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
            />
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading…</div>
      ) : (
        <div className="space-y-6">
          {/* Exec KPI band — managers only */}
          {isManager && (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <Kpi label="Revenue" value={formatZAR(revenue)} caption="vs previous period">
                  <Delta current={revenue} previous={prevRevenue} />
                </Kpi>
                <Kpi label="Gross profit" value={formatZAR(grossProfit)} caption={`${margin.toFixed(1)}% margin`} />
                <Kpi label="Transactions" value={String(txnCount)} caption="vs previous period">
                  <Delta current={txnCount} previous={prevTxn} />
                </Kpi>
                <Kpi label="Avg sale" value={formatZAR(avgSale)} caption={`${productsSold} products sold`} />
              </div>

              {revenue > 0 && (
                <p className="text-xs text-gray-500 -mt-2">
                  Top 5 products drive{" "}
                  <span className="font-semibold text-gray-700">{top5Share.toFixed(0)}%</span> of revenue at {scopeLabel}.
                </p>
              )}
            </>
          )}

          {/* Revenue per day mini chart — managers only */}
          {isManager && (
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2 mb-3">
                <BarChart3 className="w-4 h-4 text-green-600" />
                Revenue per day
              </h2>
              {maxDayRevenue === 0 ? (
                <p className="text-sm text-gray-400 py-2">No sales in this period.</p>
              ) : (
                <>
                  <div className="flex items-end gap-0.5 h-28">
                    {revenueByDay.map((d) => {
                      const pct = d.revenue > 0 ? Math.max(2, Math.round((d.revenue / maxDayRevenue) * 100)) : 0;
                      return (
                        <div
                          key={d.date}
                          className="flex-1 h-full flex items-end"
                          title={`${d.date}: ${formatZAR(d.revenue)}`}
                        >
                          <div
                            className="w-full bg-green-500 hover:bg-green-600 rounded-t transition-colors"
                            style={{ height: `${pct}%` }}
                          />
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex justify-between text-xs text-gray-400 mt-1.5">
                    <span>{revenueByDay[0]?.date}</span>
                    <span>Peak {formatZAR(maxDayRevenue)}</span>
                    <span>{revenueByDay[revenueByDay.length - 1]?.date}</span>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Cash intake — managers only. Money actually received, day by day. */}
          {isManager && (
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <div className="flex items-center justify-between gap-3 mb-1">
                <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                  <Banknote className="w-4 h-4 text-green-600" />
                  Cash intake
                </h2>
                <CsvButton onClick={exportIntake} disabled={intakeByDay.length === 0} />
              </div>
              <p className="text-xs text-gray-500 mb-4">
                What actually came in at {scopeLabel}, by how it was paid.
              </p>

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
                <IntakeTile label="Cash" value={formatZAR(totalCashIn)} tone="green" />
                <IntakeTile label="Card / electronic" value={formatZAR(totalElectronicIn)} tone="blue" />
                <IntakeTile label="Credit repayments" value={formatZAR(totalRepaymentsIn)} tone="amber" />
                <IntakeTile label="Total received" value={formatZAR(totalReceived)} tone="gray" />
              </div>

              {totalReceived === 0 ? (
                <p className="text-sm text-gray-400 py-2">Nothing received in this period.</p>
              ) : (
                <div className="overflow-x-auto -mx-5 px-5">
                  <table className="w-full text-sm min-w-[30rem]">
                    <thead>
                      <tr className="text-xs text-gray-500 border-b border-gray-100">
                        <th className="text-left font-medium py-2">Date</th>
                        <th className="text-right font-medium py-2">Cash</th>
                        <th className="text-right font-medium py-2">Card / electronic</th>
                        <th className="text-right font-medium py-2">Repayments</th>
                        <th className="text-right font-medium py-2">Total in</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {intakeByDay
                        .filter((d) => d.cash + d.electronic + d.repayments > 0)
                        .map((d) => (
                          <tr key={d.date}>
                            <td className="py-2 text-gray-700">{d.date}</td>
                            <td className="py-2 text-right font-semibold text-green-700">{formatZAR(d.cash)}</td>
                            <td className="py-2 text-right text-gray-600">{formatZAR(d.electronic)}</td>
                            <td className="py-2 text-right text-gray-600">{formatZAR(d.repayments)}</td>
                            <td className="py-2 text-right font-medium text-gray-900">
                              {formatZAR(d.cash + d.electronic + d.repayments)}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="mt-4 pt-3 border-t border-gray-100 space-y-1">
                {repaymentsFailed && (
                  <p className="text-xs text-amber-700">
                    Credit repayments could not be read, so they are missing from these figures.
                    Cash and card totals above are unaffected.
                  </p>
                )}
                {creditSales > 0 && (
                  <p className="text-xs text-gray-500">
                    Excludes {formatZAR(creditSales)} of sales on account — that money has not come in
                    yet. It appears here as a repayment on the day the customer settles.
                  </p>
                )}
                {totalRepaymentsIn > 0 && (
                  <p className="text-xs text-gray-500">
                    Repayments are listed separately because the app does not record whether a
                    customer settled in cash or electronically.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Cash spent — managers only. Money out, on a cash basis. */}
          {isManager && (
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <div className="flex items-center justify-between gap-3 mb-1">
                <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                  <Wallet className="w-4 h-4 text-red-500" />
                  Cash spent
                </h2>
                <CsvButton onClick={exportSpend} disabled={totalSpent === 0 && stockOnAccount === 0} />
              </div>
              <p className="text-xs text-gray-500 mb-4">
                What actually went out — stock you paid for, plus running costs.
              </p>

              <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
                <IntakeTile label="Stock — cash" value={formatZAR(stockCashOut)} tone="amber" />
                <IntakeTile label="Stock — EFT / card" value={formatZAR(stockElectronic)} tone="blue" />
                <IntakeTile label="Running costs" value={formatZAR(totalOperatingSpend)} tone="gray" />
              </div>

              <div className="flex items-baseline justify-between border-t border-gray-100 pt-3 mb-4">
                <span className="text-sm font-semibold text-gray-900">Total cash spent</span>
                <span className="text-xl font-bold text-red-600">{formatZAR(totalSpent)}</span>
              </div>

              {expenseSpend.length > 0 && (
                <div className="space-y-2 mb-4">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                    Running costs by category
                  </p>
                  {expenseSpend.map((r) => (
                    <div key={r.label} className="flex justify-between text-sm">
                      <span className="text-gray-600">{r.label}</span>
                      <span className="font-medium text-gray-900">{formatZAR(r.amount)}</span>
                    </div>
                  ))}
                </div>
              )}

              {totalSpent === 0 && stockOnAccount === 0 && (
                <p className="text-sm text-gray-400 py-2">Nothing spent in this period.</p>
              )}

              <div className="border-t border-gray-100 pt-3 space-y-1.5">
                {stockOnAccount > 0 && (
                  <p className="text-xs text-gray-500">
                    Excludes {formatZAR(stockOnAccount)} of stock taken on account — not paid for
                    yet, so it is not money out. It counts on the day you settle with the supplier.
                  </p>
                )}
                {stockPurchaseExpenses > 0 && (
                  <p className="text-xs text-amber-700">
                    Also excludes {formatZAR(stockPurchaseExpenses)} logged as
                    &quot;Stock Purchases&quot; expenses. Receive Stock records that automatically
                    alongside the delivery, so counting both would double every delivery. Untick
                    that box on Receive Stock if you want the expense row to stop being created.
                  </p>
                )}
                {isFiltered && (
                  <p className="text-xs text-gray-500">
                    Stock deliveries are not recorded per branch, so those figures cover the whole
                    business. Running costs are filtered to {filteredLocName}.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Branch performance — managers, chain-wide view only */}
          {isManager && branchPerf.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2 mb-3">
                <Store className="w-4 h-4 text-green-600" />
                Revenue by branch
              </h2>
              <div className="space-y-2.5">
                {branchPerf.map((b) => {
                  const share = revenue > 0 ? (b.revenue / revenue) * 100 : 0;
                  return (
                    <div key={b.locationId}>
                      <div className="flex items-center justify-between text-sm mb-1">
                        <span className="font-medium text-gray-900 truncate">{b.name}</span>
                        <span className="text-gray-600 shrink-0 ml-3">
                          {formatZAR(b.revenue)} <span className="text-gray-400">· {share.toFixed(0)}%</span>
                        </span>
                      </div>
                      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div className="h-full bg-green-500 rounded-full" style={{ width: `${share}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Top sellers — managers only, collapsed by default */}
          {isManager && (
            <CollapsibleCard
              icon={Trophy}
              iconColor="text-green-600"
              title="Top sellers"
              summary={topSellers.length === 0 ? "No sales" : `${productsSold} products · ${formatZAR(top5Revenue)} from top 5`}
              action={<CsvButton onClick={exportSales} disabled={allProductSales.length === 0} />}
            >
              {topSellers.length === 0 ? (
                <p className="text-sm text-gray-400 py-2">No sales recorded in this period.</p>
              ) : (
                <div className="divide-y divide-gray-100">
                  {topSellers.map((s, i) => (
                    <div key={s.productId} className="flex items-center justify-between py-2.5">
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="text-xs font-semibold text-gray-400 w-5 shrink-0">{i + 1}</span>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">{s.name}</p>
                          <p className="text-xs text-gray-500">{s.qty} sold</p>
                        </div>
                      </div>
                      <p className="text-sm font-semibold text-gray-900 shrink-0 ml-3">{formatZAR(s.revenue)}</p>
                    </div>
                  ))}
                </div>
              )}
            </CollapsibleCard>
          )}

          {/* Slowest movers — managers only, collapsed by default */}
          {isManager && (
            <CollapsibleCard
              icon={TrendingDown}
              iconColor="text-amber-600"
              title="Slowest movers"
              summary={slowestMovers.length === 0 ? "No stock" : `${slowestMovers.length} shown · ${zeroSellers} not selling`}
              action={<CsvButton onClick={exportSlowest} disabled={slowestMovers.length === 0} />}
            >
              <p className="text-xs text-gray-500 mb-3">In-stock products that sold the fewest units at {scopeLabel} this period — watch for dead stock.</p>
              {slowestMovers.length === 0 ? (
                <p className="text-sm text-gray-400 py-2">No stocked products to show.</p>
              ) : (
                <div className="divide-y divide-gray-100">
                  {slowestMovers.map((m) => (
                    <div key={m.productId} className="flex items-center justify-between py-2.5">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{m.name}</p>
                        <p className="text-xs text-gray-500">{m.sold} sold</p>
                      </div>
                      <span className="text-sm text-gray-500 shrink-0 ml-3">{m.stock} in stock</span>
                    </div>
                  ))}
                </div>
              )}
            </CollapsibleCard>
          )}

          {/* Low stock — everyone, collapsed by default */}
          <CollapsibleCard
            icon={PackageX}
            iconColor="text-amber-600"
            title="Low stock"
            summary={lowStock.length === 0 ? "All good" : `${lowStock.length} low`}
            summaryTone={lowStock.length > 0 ? "warn" : "muted"}
            action={<CsvButton onClick={exportLowStock} disabled={lowStock.length === 0} />}
          >
            <p className="text-xs text-gray-500 mb-3">
              In-stock products at or below {lowStockThreshold} units at {scopeLabel}.
            </p>
            {lowStock.length === 0 ? (
              <p className="text-sm text-gray-400 py-2">Nothing is running low — good stock levels.</p>
            ) : (
              <div className="divide-y divide-gray-100">
                {lowStock.map((r) => (
                  <div key={r.productId} className="flex items-center justify-between py-2.5">
                    <p className="text-sm font-medium text-gray-900 truncate">{r.name}</p>
                    <span className="text-sm font-semibold shrink-0 ml-3 text-amber-600">
                      {r.quantity} left
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CollapsibleCard>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Kpi({
  label,
  value,
  caption,
  children,
}: {
  label: string;
  value: string;
  caption?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl px-5 py-4">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="text-2xl font-bold text-gray-900 mt-1">{value}</p>
      <div className="flex items-center gap-2 mt-1">
        {children}
        {caption && <span className="text-xs text-gray-400">{caption}</span>}
      </div>
    </div>
  );
}

// Compact figure for the cash-intake band. Smaller than Kpi, which carries a
// caption and delta this section has no use for.
function IntakeTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "green" | "blue" | "amber" | "gray";
}) {
  const toneClass = {
    green: "text-green-700",
    blue: "text-blue-700",
    amber: "text-amber-700",
    gray: "text-gray-900",
  }[tone];
  return (
    <div className="bg-gray-50 rounded-lg px-3 py-2.5">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`text-lg font-bold mt-0.5 ${toneClass}`}>{value}</p>
    </div>
  );
}

// Period-over-period change indicator.
function Delta({ current, previous }: { current: number; previous: number }) {
  if (previous <= 0) {
    return <span className="text-xs text-gray-400">no prior data</span>;
  }
  const pct = ((current - previous) / previous) * 100;
  const up = pct >= 0;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-semibold ${up ? "text-green-600" : "text-red-600"}`}>
      {up ? <ArrowUpRight className="w-3.5 h-3.5" /> : <ArrowDownRight className="w-3.5 h-3.5" />}
      {Math.abs(pct).toFixed(0)}%
    </span>
  );
}

// Collapsible card: summary in the header, details on click. Collapsed by default.
function CollapsibleCard({
  icon: Icon,
  iconColor,
  title,
  summary,
  summaryTone = "muted",
  action,
  children,
}: {
  icon: React.ElementType;
  iconColor: string;
  title: string;
  summary: string;
  summaryTone?: "muted" | "warn";
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-white border border-gray-200 rounded-xl">
      <div className="flex items-center justify-between px-5 py-4 gap-3">
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex items-center gap-2 min-w-0 flex-1 text-left"
        >
          <Icon className={`w-4 h-4 shrink-0 ${iconColor}`} />
          <span className="text-sm font-semibold text-gray-900">{title}</span>
          <ChevronDown className={`w-4 h-4 text-gray-400 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        <div className="flex items-center gap-3 shrink-0">
          <span className={`text-sm font-medium ${summaryTone === "warn" ? "text-amber-600" : "text-gray-500"}`}>
            {summary}
          </span>
          {action}
        </div>
      </div>
      {open && <div className="px-5 pb-4 pt-1 border-t border-gray-100">{children}</div>}
    </div>
  );
}

function CsvButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1 text-xs font-medium text-green-600 hover:text-green-700 disabled:text-gray-300 disabled:cursor-not-allowed"
    >
      <Download className="w-3.5 h-3.5" />
      Export
    </button>
  );
}

// ---------------------------------------------------------------------------

// Local-date formatter (avoids the UTC shift that toISOString would introduce).
function fmtLocalDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Every day from `from` to `to` inclusive, as YYYY-MM-DD strings.
function enumerateDays(from: string, to: string): string[] {
  const days: string[] = [];
  const d = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  let guard = 0;
  while (d <= end && guard < 1000) {
    days.push(fmtLocalDate(d));
    d.setDate(d.getDate() + 1);
    guard += 1;
  }
  return days;
}

// The equal-length window immediately before [from, to] — for momentum deltas.
function prevRange(from: string, to: string): { from: string; to: string } {
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  const lenDays = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  const prevEnd = new Date(start);
  prevEnd.setDate(prevEnd.getDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setDate(prevStart.getDate() - (lenDays - 1));
  return { from: fmtLocalDate(prevStart), to: fmtLocalDate(prevEnd) };
}

// Build a CSV from a header + rows and trigger a client-side download.
// Prepends a UTF-8 BOM so Excel opens it with the correct encoding.
function downloadCsv(filename: string, header: string[], rows: string[][]) {
  const csv = "﻿" + [header, ...rows].map((r) => r.map(csvEscape).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// RFC-4180 CSV field escaping.
function csvEscape(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

// Filename-safe slug for the export filename.
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "branch";
}
