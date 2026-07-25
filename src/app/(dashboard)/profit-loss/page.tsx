"use client";
import { useState, useEffect } from "react";
import { db } from "@/lib/supabase";
import { fetchAllPaged } from "@/lib/fetch-all";
import { formatZAR } from "@/lib/format";
import { FileBarChart } from "lucide-react";
import { LocationFilter, LOCATION_FILTER_ALL } from "@/components/locations/location-filter";
import { useOrg } from "@/lib/org-context";
import { paymentBucket } from "@/lib/payment-buckets";
import { INVENTORY_EXPENSE_CATEGORIES, type ExpenseCategory } from "@/types/database";

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
  // Sale lines sold with no cost price captured — they book at 100% margin and
  // silently overstate gross profit. Tracked to warn even when COGS is non-zero.
  const [zeroCostLines, setZeroCostLines] = useState(0);
  const [totalSaleLines, setTotalSaleLines] = useState(0);
  // Output VAT collected in the period (snapshot on sales, migration 061). It
  // is part of Total Revenue and owed to the tax authority — not profit. Read
  // only; it does not enter the profit calculation.
  const [outputVat, setOutputVat] = useState(0);
  const [operatingExpenses, setOperatingExpenses] = useState(0);
  const [directorWithdrawals, setDirectorWithdrawals] = useState(0);
  // Buying stock is not an expense — it converts cash into inventory, and only
  // becomes a cost when the item sells, which COGS above already captures from
  // the sale-time snapshot. Counting it here as well charged the same stock
  // twice and understated profit. Held separate so the figure stays visible.
  const [stockPurchases, setStockPurchases] = useState(0);
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

    // 1. Revenue by payment method (H10 fix: use fetchAllPaged to avoid 1000-row cap)
    const sales = await fetchAllPaged<any>(() => {
      let q = db
        .from("sales")
        .select("payment_method, total_amount, quantity, product_id, cost_price, tax_amount")
        .gte("sale_date", from)
        .lte("sale_date", to)
        .eq("voided", false);
      if (isFiltered) q = q.eq("location_id", effectiveLoc);
      return q;
    });

    let cash = 0, card = 0, credit = 0;
    (sales as any[]).forEach((s: any) => {
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
    let zeroCost = 0;
    let totalVat = 0;
    (sales as any[]).forEach((s: any) => {
      const cost = Number(s.cost_price) || 0;
      totalCogs += cost * s.quantity;
      if (cost === 0) zeroCost += 1;
      totalVat += Number(s.tax_amount) || 0;
    });
    setCogs(totalCogs);
    setZeroCostLines(zeroCost);
    setTotalSaleLines((sales as any[]).length);
    setOutputVat(totalVat);

    // 3. Expenses (H10 fix: fetchAllPaged)
    const expenses = await fetchAllPaged<any>(() => {
      let q = db
        .from("expenses")
        .select("category, amount")
        .gte("expense_date", from)
        .lte("expense_date", to);
      if (isFiltered) q = q.eq("location_id", effectiveLoc);
      return q;
    });

    let opex = 0, dirW = 0, stockBought = 0;
    const catTotals: Record<string, number> = {};
    (expenses as any[]).forEach((e: any) => {
      if (e.category === "Director Withdrawal") {
        dirW += e.amount;
      } else if (INVENTORY_EXPENSE_CATEGORIES.includes(e.category)) {
        // Inventory, not an expense — see the note on the state declaration.
        // Covers ingredients too since migration 055 gave prepared items a real
        // cost: leaving them in opex would charge them again through COGS.
        stockBought += e.amount;
      } else {
        opex += e.amount;
      }
      catTotals[e.category] = (catTotals[e.category] || 0) + e.amount;
    });
    setOperatingExpenses(opex);
    setDirectorWithdrawals(dirW);
    setStockPurchases(stockBought);
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
  // Director withdrawals are a distribution of profit, not a business expense,
  // so they must NOT reduce net profit. They are shown separately below the net
  // profit line as money drawn out of that profit.
  const netProfit = grossProfit - operatingExpenses;
  const netMargin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;
  const profitAfterDrawings = netProfit - directorWithdrawals;

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

          {/* Output VAT — read-only. Only shows for VAT-registered orgs (those
              with any VAT captured on sales). It is part of Total Revenue above
              and owed to the tax authority, so it is deliberately NOT subtracted
              from profit here — profit math is unchanged. */}
          {outputVat > 0 && (
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <div className="px-5 py-3 bg-blue-50 border-b border-blue-100">
                <h2 className="font-semibold text-blue-800">VAT</h2>
              </div>
              <div className="divide-y divide-gray-100">
                <PnLRow label="Revenue excl. VAT" amount={totalRevenue - outputVat} />
                <PnLRow label="Output VAT collected" amount={outputVat} />
                <div className="px-5 py-3 text-xs text-gray-500">
                  Output VAT is already inside Total Revenue above and is owed to the tax authority —
                  it is not profit, so it is not subtracted from the profit figures below. A full VAT
                  return also needs input VAT on your purchases, which is the next step.
                </div>
              </div>
            </div>
          )}

          {/* COGS section */}
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3 bg-amber-50 border-b border-amber-100">
              <h2 className="font-semibold text-amber-800">Cost of Goods Sold</h2>
            </div>
            <div className="divide-y divide-gray-100">
              <PnLRow label="Product Costs (package_price ÷ qty_in_pack × units)" amount={cogs} negative />
              <PnLRow label="Gross Profit" amount={grossProfit} bold highlight={grossProfit >= 0 ? "green" : "red"} />
              <PnLRow label="Gross Margin" amount={grossMargin} percent />
              {zeroCostLines > 0 && (
                <div className="px-5 py-3 text-xs text-amber-700 bg-amber-50">
                  <strong>{zeroCostLines} of {totalSaleLines} sales</strong> in this period have no
                  cost price recorded, so they book at zero cost. Cost of Goods Sold is understated
                  and the profit above looks higher than it really is. Set a cost price on those
                  products — or, for prepared food, complete the recipe — so their cost flows into
                  COGS.
                </div>
              )}
            </div>
          </div>

          {/* Expenses section */}
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3 bg-red-50 border-b border-red-100">
              <h2 className="font-semibold text-red-800">Operating Expenses</h2>
            </div>
            <div className="divide-y divide-gray-100">
              {expenseBreakdown
                .filter((e) => e.category !== "Director Withdrawal" && !INVENTORY_EXPENSE_CATEGORIES.includes(e.category as ExpenseCategory))
                .map((e) => (
                  <PnLRow key={e.category} label={e.category} amount={e.total} negative />
                ))}
              {operatingExpenses === 0 && (
                <div className="px-5 py-3 text-sm text-gray-400">No operating expenses recorded</div>
              )}
              <PnLRow label="Total Operating Expenses" amount={operatingExpenses} bold negative />
            </div>
          </div>

          {/* Stock bought — shown, but never subtracted. Buying stock moves cash
              into inventory; it becomes a cost via COGS when the item sells. */}
          {stockPurchases > 0 && (
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <div className="px-5 py-3 bg-gray-50 border-b border-gray-100">
                <h2 className="font-semibold text-gray-700">Inventory Bought (not a cost yet)</h2>
              </div>
              <div className="divide-y divide-gray-100">
                {expenseBreakdown
                  .filter((e) => INVENTORY_EXPENSE_CATEGORIES.includes(e.category as ExpenseCategory))
                  .map((e) => (
                    <PnLRow key={e.category} label={e.category} amount={e.total} />
                  ))}
                <div className="px-5 py-3 text-xs text-gray-500">
                  Not subtracted from profit. Buying stock or ingredients turns cash into
                  inventory — it becomes a cost through Cost of Goods Sold above, on the day the
                  finished item actually sells. Subtracting it here as well would charge the same
                  goods twice.
                  {" "}See Reports → Cash spent for money out.
                </div>
                {cogs === 0 && (
                  <div className="px-5 py-3 text-xs text-amber-700 bg-amber-50">
                    <strong>Check your product costs.</strong> Inventory was bought in this period
                    but Cost of Goods Sold is zero, so nothing is being charged against these
                    sales. That usually means products are missing a cost price — or, for prepared
                    food, that a recipe has not been set up yet. Either way the profit above looks
                    higher than it is.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Net Profit */}
          <div className={`rounded-xl overflow-hidden border-2 ${netProfit >= 0 ? "border-green-300 bg-green-50" : "border-red-300 bg-red-50"}`}>
            <div className="px-5 py-4 flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600">Net Profit</p>
                <p className="text-xs text-gray-500 mt-0.5">Revenue − COGS − Expenses</p>
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

          {/* Director Withdrawals — a distribution of the profit above, shown
              after Net Profit because drawing money out is not a business cost. */}
          {directorWithdrawals > 0 && (
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <div className="px-5 py-3 bg-gray-50 border-b border-gray-100">
                <h2 className="font-semibold text-gray-700">Director Withdrawals (drawn from profit)</h2>
              </div>
              <div className="divide-y divide-gray-100">
                {expenseBreakdown
                  .filter((e) => e.category === "Director Withdrawal")
                  .map((e) => (
                    <PnLRow key={e.category} label="Cash Withdrawals" amount={e.total} negative />
                  ))}
                <PnLRow
                  label="Profit kept in the business"
                  amount={profitAfterDrawings}
                  bold
                  highlight={profitAfterDrawings >= 0 ? "green" : "red"}
                />
                <div className="px-5 py-3 text-xs text-gray-500">
                  Money the director took out is paid <em>out of</em> net profit — it is not a
                  business expense, so it does not reduce the net profit figure above. This shows
                  what is left after those withdrawals.
                </div>
              </div>
            </div>
          )}
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
