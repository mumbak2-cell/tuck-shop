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
import { localToday, localMonthStart, localWeekStart } from "@/lib/date-utils";

type Period = "today" | "week" | "month" | "custom";

export default function ProfitLossPage() {
  const { role, assignedLocationId, currentLocationId, locations, vatPercent } = useOrg();
  const [locFilter, setLocFilter] = useState<string>(LOCATION_FILTER_ALL);
  const effectiveLoc = role === "member" ? (assignedLocationId || currentLocationId || LOCATION_FILTER_ALL) : locFilter;
  const isFiltered = effectiveLoc !== LOCATION_FILTER_ALL;
  const filteredLocName = isFiltered ? (locations.find((l) => l.id === effectiveLoc)?.name || "") : "";

  const [period, setPeriod] = useState<Period>("month");
  const [customFrom, setCustomFrom] = useState(localMonthStart);
  const [customTo, setCustomTo] = useState(localToday);
  const [loading, setLoading] = useState(true);

  // P&L data
  const [cashRevenue, setCashRevenue] = useState(0);
  const [cardRevenue, setCardRevenue] = useState(0);
  const [creditRevenue, setCreditRevenue] = useState(0);
  const [cogs, setCogs] = useState(0);
  const [operatingExpenses, setOperatingExpenses] = useState(0);
  const [directorWithdrawals, setDirectorWithdrawals] = useState(0);
  // Buying stock is not an expense — it converts cash into inventory, and only
  // becomes a cost when the item sells, which COGS above already captures from
  // the sale-time snapshot. Counting it here as well charged the same stock
  // twice and understated profit. Held separate so the figure stays visible.
  const [stockPurchases, setStockPurchases] = useState(0);
  const [expenseBreakdown, setExpenseBreakdown] = useState<{ category: string; total: number }[]>([]);
  const [shrinkageCost, setShrinkageCost] = useState(0);
  const [shrinkageUncosted, setShrinkageUncosted] = useState(0);
  const [inventoryValue, setInventoryValue] = useState(0);
  const [inventoryUncosted, setInventoryUncosted] = useState(0);
  const [inventoryUnits, setInventoryUnits] = useState(0);
  const [inventoryRetail, setInventoryRetail] = useState(0);

  useEffect(() => {
    loadPnL();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, customFrom, customTo, effectiveLoc, isFiltered]);

  function getDateRange(): { from: string; to: string } {
    const today = localToday();
    if (period === "today") return { from: today, to: today };
    if (period === "week") return { from: localWeekStart(), to: today };
    if (period === "month") return { from: localMonthStart(), to: today };
    return { from: customFrom, to: customTo };
  }

  async function loadPnL() {
    setLoading(true);
    const { from, to } = getDateRange();

    // 1. Revenue by payment method (H10 fix: use fetchAllPaged to avoid 1000-row cap)
    const sales = await fetchAllPaged<any>(() => {
      let q = db
        .from("sales")
        .select("payment_method, total_amount, quantity, product_id, cost_price")
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
    (sales as any[]).forEach((s: any) => {
      const cost = Number(s.cost_price) || 0;
      totalCogs += cost * s.quantity;
    });
    setCogs(totalCogs);

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

    // 4. Shrinkage: stock adjustments (decrease) for loss reasons, valued at cost
    const LOSS_REASONS = ["Breakage", "Expired", "Theft", "Damaged", "Samples"];
    let adjQ = db
      .from("stock_adjustments")
      .select("quantity, cost_price, reason")
      .eq("direction", "decrease")
      .in("reason", LOSS_REASONS)
      .gte("adjustment_date", from)
      .lte("adjustment_date", to);
    if (isFiltered) adjQ = adjQ.eq("location_id", effectiveLoc);
    const { data: adjRows } = await adjQ;

    let shrinkTotal = 0;
    let uncosted = 0;
    ((adjRows || []) as { quantity: number; cost_price: number | null; reason: string }[]).forEach((a) => {
      if (a.cost_price != null) {
        shrinkTotal += a.cost_price * a.quantity;
      } else {
        uncosted++;
      }
    });
    setShrinkageCost(shrinkTotal);
    setShrinkageUncosted(uncosted);

    // 5. Inventory on hand (point-in-time, not period-dependent)
    let stockQ = db
      .from("product_stock")
      .select("quantity, product_id, products(cost_per_unit, selling_price)")
      .gt("quantity", 0);
    if (isFiltered) stockQ = stockQ.eq("location_id", effectiveLoc);
    const { data: stockRows } = await stockQ;

    let invValue = 0;
    let invRetail = 0;
    let invUncosted = 0;
    let invUnits = 0;
    ((stockRows || []) as { quantity: number; product_id: string; products: { cost_per_unit: number | null; selling_price: number | null } | null }[]).forEach((r) => {
      const cost = r.products?.cost_per_unit;
      const sell = r.products?.selling_price;
      invUnits += r.quantity;
      if (sell != null && sell > 0) {
        invRetail += sell * r.quantity;
      }
      if (cost != null && cost > 0) {
        invValue += cost * r.quantity;
      } else {
        invUncosted += r.quantity;
      }
    });
    setInventoryValue(invValue);
    setInventoryRetail(invRetail);
    setInventoryUncosted(invUncosted);
    setInventoryUnits(invUnits);

    setLoading(false);
  }

  const vatRate = vatPercent != null ? vatPercent / 100 : 0;
  const isVatRegistered = vatPercent != null && vatPercent > 0;
  const exVat = (amount: number) => isVatRegistered ? amount / (1 + vatRate) : amount;

  const totalRevenueInc = cashRevenue + cardRevenue + creditRevenue;
  const totalRevenue = exVat(totalRevenueInc);
  const exVatCogs = exVat(cogs);
  const outputVat = totalRevenueInc - totalRevenue;
  const inputVat = cogs - exVatCogs;
  const grossProfit = totalRevenue - exVatCogs - shrinkageCost;
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
              <h2 className="font-semibold text-green-800">
                Revenue{isVatRegistered ? " (ex-VAT)" : ""}
              </h2>
            </div>
            <div className="divide-y divide-gray-100">
              <PnLRow label="Cash Sales" amount={exVat(cashRevenue)} />
              <PnLRow label="Card Sales" amount={exVat(cardRevenue)} />
              <PnLRow label="Credit Sales" amount={exVat(creditRevenue)} />
              <PnLRow label="Total Revenue" amount={totalRevenue} bold />
            </div>
          </div>

          {/* COGS section */}
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3 bg-amber-50 border-b border-amber-100">
              <h2 className="font-semibold text-amber-800">
                Cost of Goods Sold{isVatRegistered ? " (ex-VAT)" : ""}
              </h2>
            </div>
            <div className="divide-y divide-gray-100">
              <PnLRow label="Product Costs" amount={exVatCogs} negative />
              {shrinkageCost > 0 && (
                <PnLRow label="Shrinkage & Losses" amount={shrinkageCost} negative />
              )}
              {shrinkageUncosted > 0 && (
                <div className="px-5 py-2 text-xs text-amber-700 bg-amber-50">
                  {shrinkageUncosted} older adjustment{shrinkageUncosted > 1 ? "s" : ""} not costed (recorded before cost tracking).
                </div>
              )}
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

          {/* VAT summary — only for VAT-registered orgs */}
          {isVatRegistered && (
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <div className="px-5 py-3 bg-blue-50 border-b border-blue-100">
                <h2 className="font-semibold text-blue-800">VAT Summary ({vatPercent}%)</h2>
              </div>
              <div className="divide-y divide-gray-100">
                <PnLRow label="Output VAT (collected on sales)" amount={outputVat} />
                <PnLRow label="Input VAT (paid on stock purchases)" amount={inputVat} />
                <PnLRow label="Net VAT Payable" amount={outputVat - inputVat} bold highlight={outputVat - inputVat > 0 ? "red" : "green"} />
                <div className="px-5 py-3 text-xs text-gray-500">
                  VAT has been extracted from revenue and COGS above. This section shows the
                  VAT portion for reference — the net payable is what you owe (or are owed by)
                  the tax authority for this period.
                </div>
              </div>
            </div>
          )}

          {/* Inventory on Hand — point-in-time, not a period figure */}
          {inventoryUnits > 0 && (
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <div className="px-5 py-3 bg-indigo-50 border-b border-indigo-100">
                <h2 className="font-semibold text-indigo-800">Inventory on Hand</h2>
              </div>
              <div className="divide-y divide-gray-100">
                <PnLRow label="Stock Value (at cost)" amount={inventoryValue} />
                {inventoryRetail > 0 && (
                  <PnLRow label="Stock Value (at selling price)" amount={inventoryRetail} />
                )}
                {inventoryRetail > 0 && inventoryValue > 0 && (
                  <PnLRow label="Profit in Stock" amount={inventoryRetail - inventoryValue} bold highlight={inventoryRetail - inventoryValue >= 0 ? "green" : "red"} />
                )}
                <div className="px-5 py-3 flex items-center justify-between">
                  <span className="text-sm text-gray-700">Total Units</span>
                  <span className="text-sm font-medium text-gray-900">{inventoryUnits.toLocaleString()}</span>
                </div>
                {inventoryRetail > 0 && inventoryValue > 0 && (
                  <div className="px-5 py-3 flex items-center justify-between">
                    <span className="text-sm text-gray-700">Average Markup</span>
                    <span className="text-sm font-medium text-gray-900">
                      {((inventoryRetail / inventoryValue - 1) * 100).toFixed(1)}%
                    </span>
                  </div>
                )}
                {inventoryUncosted > 0 && (
                  <div className="px-5 py-2 text-xs text-amber-700 bg-amber-50">
                    {inventoryUncosted.toLocaleString()} unit{inventoryUncosted > 1 ? "s" : ""} have no cost price —
                    actual inventory value is higher than shown.
                  </div>
                )}
                <div className="px-5 py-3 text-xs text-gray-500">
                  Current stock × price. A snapshot, not a period figure — it always
                  reflects stock levels right now{isFiltered ? ` at ${filteredLocName}` : ""}.
                  Profit in Stock is what you&apos;d earn if everything sold at its selling price.
                </div>
              </div>
            </div>
          )}

          {/* Net Profit */}
          <div className={`rounded-xl overflow-hidden border-2 ${netProfit >= 0 ? "border-green-300 bg-green-50" : "border-red-300 bg-red-50"}`}>
            <div className="px-5 py-4 flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600">Net Profit</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  Revenue − COGS − Shrinkage − Expenses − Withdrawals{isVatRegistered ? " (all ex-VAT)" : ""}
                </p>
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

          {/* Shop Value — stock + profit combined */}
          {inventoryUnits > 0 && (
            <div className="rounded-xl overflow-hidden border-2 border-indigo-300 bg-indigo-50">
              <div className="px-5 py-3 border-b border-indigo-200">
                <h2 className="font-semibold text-indigo-800">What&apos;s In Your Shop</h2>
                <p className="text-xs text-gray-500 mt-0.5">Stock value + profit earned this period</p>
              </div>
              <div className="divide-y divide-indigo-100">
                <div className="px-5 py-3 flex items-center justify-between">
                  <span className="text-sm text-gray-700">Stock (at cost)</span>
                  <span className="text-sm font-medium text-gray-900">{formatZAR(inventoryValue)}</span>
                </div>
                {inventoryRetail > 0 && (
                  <div className="px-5 py-3 flex items-center justify-between">
                    <span className="text-sm text-gray-700">Profit in Stock (unsold markup)</span>
                    <span className="text-sm font-medium text-green-700">{formatZAR(inventoryRetail - inventoryValue)}</span>
                  </div>
                )}
                <div className="px-5 py-3 flex items-center justify-between">
                  <span className="text-sm text-gray-700">Net Profit (earned this period)</span>
                  <span className={`text-sm font-medium ${netProfit >= 0 ? "text-green-700" : "text-red-700"}`}>{formatZAR(netProfit)}</span>
                </div>
                <div className="px-5 py-4 flex items-center justify-between bg-indigo-100/50">
                  <span className="text-sm font-semibold text-indigo-900">Total Shop Value</span>
                  <span className="text-2xl font-bold text-indigo-800">
                    {formatZAR(inventoryValue + (inventoryRetail > inventoryValue ? inventoryRetail - inventoryValue : 0) + netProfit)}
                  </span>
                </div>
                <div className="px-5 py-2 text-xs text-gray-500">
                  Stock at cost + profit sitting on shelves + profit earned. Shows how much value is in your business right now.
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
