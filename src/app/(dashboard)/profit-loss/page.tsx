"use client";
import { useState, useEffect } from "react";
import { db } from "@/lib/supabase";
import { formatZAR } from "@/lib/format";
import { FileBarChart } from "lucide-react";
import { LocationFilter, LOCATION_FILTER_ALL } from "@/components/locations/location-filter";
import { useOrg } from "@/lib/org-context";
import { paymentBucket } from "@/lib/payment-buckets";

type Period = "today" | "week" | "month" | "custom";

export default function ProfitLossPage() {
  const { role, assignedLocationId, currentLocationId, locations } = useOrg();
  const [locFilter, setLocFilter] = useState<string>(LOCATION_FILTER_ALL);
  const effectiveLoc = role === "member" ? (assignedLocationId || currentLocationId || LOCATION_FILTER_ALL) : locFilter;
  const isFiltered = effectiveLoc !== LOCATION_FILTER_ALL;
  const filteredLocName = isFiltered ? (locations.find((l) => l.id === effectiveLoc)?.name || "") : "";

  const [period, setPeriod] = useState<Period>("month");
  const [customFrom, setCustomFrom] = useState(() => {
    const d = new Date();
    d.setDate(1);
    return d.toISOString().split("T")[0];
  });
  const [customTo, setCustomTo] = useState(() => new Date().toISOString().split("T")[0]);
  const [loading, setLoading] = useState(true);

  // P&L data
  const [cashRevenue, setCashRevenue] = useState(0);
  const [cardRevenue, setCardRevenue] = useState(0);
  const [creditRevenue, setCreditRevenue] = useState(0);
  const [cogs, setCogs] = useState(0);
  const [operatingExpenses, setOperatingExpenses] = useState(0);
  const [directorWithdrawals, setDirectorWithdrawals] = useState(0);
  const [expenseBreakdown, setExpenseBreakdown] = useState<{ category: string; total: number }[]>([]);

  useEffect(() => {
    loadPnL();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, customFrom, customTo, effectiveLoc, isFiltered]);

  function getDateRange(): { from: string; to: string } {
    const today = new Date().toISOString().split("T")[0];
    if (period === "today") return { from: today, to: today };
    if (period === "week") {
      const d = new Date();
      d.setDate(d.getDate() - d.getDay()); // start of week (Sunday)
      return { from: d.toISOString().split("T")[0], to: today };
    }
    if (period === "month") {
      const d = new Date();
      d.setDate(1);
      return { from: d.toISOString().split("T")[0], to: today };
    }
    return { from: customFrom, to: customTo };
  }

  async function loadPnL() {
    setLoading(true);
    const { from, to } = getDateRange();

    // 1. Revenue by payment method
    let salesQ = db
      .from("sales")
      .select("payment_method, total_amount, quantity, product_id, cost_price")
      .gte("sale_date", from)
      .lte("sale_date", to)
      .eq("voided", false);
    if (isFiltered) salesQ = salesQ.eq("location_id", effectiveLoc);
    const { data: sales } = await salesQ;

    let cash = 0, card = 0, credit = 0;
    ((sales || []) as any[]).forEach((s: any) => {
      const amt = Number(s.total_amount) || 0;
      const bucket = paymentBucket(s.payment_method);
      if (bucket === "cash") cash += amt;
      else if (bucket === "credit") credit += amt;
      else card += amt;
    });
    setCashRevenue(cash);
    setCardRevenue(card);
    setCreditRevenue(credit);

    // 2. COGS: use snapshot cost_price recorded at time of sale
    let totalCogs = 0;
    ((sales || []) as any[]).forEach((s: any) => {
      const cost = Number(s.cost_price) || 0;
      totalCogs += cost * s.quantity;
    });
    setCogs(totalCogs);

    // 3. Expenses
    let expQ = db
      .from("expenses")
      .select("category, amount")
      .gte("expense_date", from)
      .lte("expense_date", to);
    if (isFiltered) expQ = expQ.eq("location_id", effectiveLoc);
    const { data: expenses } = await expQ;

    let opex = 0, dirW = 0;
    const catTotals: Record<string, number> = {};
    ((expenses || []) as any[]).forEach((e: any) => {
      if (e.category === "Director Withdrawal") {
        dirW += e.amount;
      } else {
        opex += e.amount;
      }
      catTotals[e.category] = (catTotals[e.category] || 0) + e.amount;
    });
    setOperatingExpenses(opex);
    setDirectorWithdrawals(dirW);
    setExpenseBreakdown(
      Object.entries(catTotals)
        .map(([category, total]) => ({ category, total }))
        .sort((a, b) => b.total - a.total)
    );

    setLoading(false);
  }

  const totalRevenue = cashRevenue + cardRevenue + creditRevenue;
  const grossProfit = totalRevenue - cogs;
  const grossMargin = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;
  const netProfit = grossProfit - operatingExpenses - directorWithdrawals;
  const netMargin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;

  const periods: { key: Period; label: string }[] = [
    { key: "today", label: "Today" },
    { key: "week", label: "This Week" },
    { key: "month", label: "This Month" },
    { key: "custom", label: "Custom" },
  ];

  return (
    <div>
      <div className="mb-6 flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <FileBarChart className="w-7 h-7 text-green-600" />
            Profit &amp; Loss
            {isFiltered && filteredLocName && (
              <span className="ml-1 text-base font-normal text-gray-500">· {filteredLocName}</span>
            )}
          </h1>
          <p className="text-sm text-gray-500 mt-1">Revenue, costs, expenses, and net profit</p>
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
              period === p.key
                ? "bg-green-600 text-white"
                : "bg-gray-100 text-gray-700 hover:bg-gray-200"
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
        <div className="text-center py-12 text-gray-400">Loading...</div>
      ) : (
        <div className="space-y-4">
          {/* Revenue section */}
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3 bg-green-50 border-b border-green-100">
              <h2 className="font-semibold text-green-800">Revenue</h2>
            </div>
            <div className="divide-y divide-gray-100">
              <PnLRow label="Cash Sales" amount={cashRevenue} />
              <PnLRow label="Card Sales" amount={cardRevenue} />
              <PnLRow label="Credit Sales" amount={creditRevenue} />
              <PnLRow label="Total Revenue" amount={totalRevenue} bold />
            </div>
          </div>

          {/* COGS section */}
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3 bg-amber-50 border-b border-amber-100">
              <h2 className="font-semibold text-amber-800">Cost of Goods Sold</h2>
            </div>
            <div className="divide-y divide-gray-100">
              <PnLRow label="Product Costs (package_price ÷ qty_in_pack × units)" amount={cogs} negative />
              <PnLRow label="Gross Profit" amount={grossProfit} bold highlight={grossProfit >= 0 ? "green" : "red"} />
              <PnLRow label="Gross Margin" amount={grossMargin} percent />
            </div>
          </div>

          {/* Expenses section */}
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3 bg-red-50 border-b border-red-100">
              <h2 className="font-semibold text-red-800">Operating Expenses</h2>
            </div>
            <div className="divide-y divide-gray-100">
              {expenseBreakdown
                .filter((e) => e.category !== "Director Withdrawal")
                .map((e) => (
                  <PnLRow key={e.category} label={e.category} amount={e.total} negative />
                ))}
              {operatingExpenses === 0 && (
                <div className="px-5 py-3 text-sm text-gray-400">No operating expenses recorded</div>
              )}
              <PnLRow label="Total Operating Expenses" amount={operatingExpenses} bold negative />
            </div>
          </div>

          {/* Director Withdrawals */}
          {directorWithdrawals > 0 && (
            <div className="bg-white border border-red-100 rounded-xl overflow-hidden">
              <div className="px-5 py-3 bg-red-50 border-b border-red-100">
                <h2 className="font-semibold text-red-800">Director Withdrawals</h2>
              </div>
              <div className="divide-y divide-gray-100">
                {expenseBreakdown
                  .filter((e) => e.category === "Director Withdrawal")
                  .map((e) => (
                    <PnLRow key={e.category} label="Cash Withdrawals" amount={e.total} negative />
                  ))}
              </div>
            </div>
          )}

          {/* Net Profit */}
          <div className={`rounded-xl overflow-hidden border-2 ${netProfit >= 0 ? "border-green-300 bg-green-50" : "border-red-300 bg-red-50"}`}>
            <div className="px-5 py-4 flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600">Net Profit</p>
                <p className="text-xs text-gray-500 mt-0.5">Revenue − COGS − Expenses − Withdrawals</p>
              </div>
              <div className="text-right">
                <p className={`text-3xl font-bold ${netProfit >= 0 ? "text-green-700" : "text-red-700"}`}>
                  {formatZAR(netProfit)}
                </p>
                <p className={`text-sm ${netProfit >= 0 ? "text-green-600" : "text-red-600"}`}>
                  {netMargin.toFixed(1)}% margin
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PnLRow({
  label,
  amount,
  bold,
  negative,
  highlight,
  percent,
}: {
  label: string;
  amount: number;
  bold?: boolean;
  negative?: boolean;
  highlight?: "green" | "red";
  percent?: boolean;
}) {
  const textColor = highlight
    ? highlight === "green"
      ? "text-green-700"
      : "text-red-700"
    : negative
    ? "text-red-600"
    : "text-gray-900";

  return (
    <div className={`px-5 py-3 flex items-center justify-between ${bold ? "bg-gray-50" : ""}`}>
      <span className={`text-sm ${bold ? "font-semibold text-gray-900" : "text-gray-700"}`}>
        {label}
      </span>
      <span className={`text-sm ${bold ? "font-bold text-lg" : "font-medium"} ${textColor}`}>
        {percent ? `${amount.toFixed(1)}%` : `${negative ? "(" : ""}${formatZAR(Math.abs(amount))}${negative ? ")" : ""}`}
      </span>
    </div>
  );
}
