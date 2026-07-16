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
} from "lucide-react";
import { LocationFilter, LOCATION_FILTER_ALL } from "@/components/locations/location-filter";
import { useOrg } from "@/lib/org-context";

type Period = "today" | "week" | "month" | "custom";

const LOW_STOCK_THRESHOLD = 5;

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

export default function ReportsPage() {
  const { role, assignedLocationId, currentLocationId, currentLocationName, locations } = useOrg();
  const isManager = role === "owner" || role === "admin"; // cashiers are role "member"

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
  const [lowStock, setLowStock] = useState<StockRow[]>([]);

  useEffect(() => {
    loadReports();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, customFrom, customTo, effectiveLoc, isFiltered, isManager]);

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

  async function loadReports() {
    setLoading(true);

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
      stockList.filter((r) => r.quantity <= LOW_STOCK_THRESHOLD).sort((a, b) => a.quantity - b.quantity)
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
      setLoading(false);
      return;
    }

    const { from, to } = getDateRange();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sales = await fetchAllPaged<any>(() => {
      let q = db
        .from("sales")
        .select("sale_date, product_id, quantity, total_amount, cost_price, location_id, products(name)")
        .gte("sale_date", from)
        .lte("sale_date", to)
        .eq("voided", false);
      if (isFiltered) q = q.eq("location_id", effectiveLoc);
      return q;
    });

    const byProduct = new Map<string, SellerRow>();
    const dayMap = new Map<string, number>();
    const locMap = new Map<string, number>();
    let totalRevenue = 0;
    let totalCogs = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sales as any[]).forEach((s: any) => {
      const rev = Number(s.total_amount) || 0;
      totalRevenue += rev;
      totalCogs += (Number(s.cost_price) || 0) * (Number(s.quantity) || 0);
      dayMap.set(s.sale_date, (dayMap.get(s.sale_date) ?? 0) + rev);
      if (s.location_id) locMap.set(s.location_id, (locMap.get(s.location_id) ?? 0) + rev);
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

  function exportLowStock() {
    const today = new Date().toISOString().split("T")[0];
    downloadCsv(
      `tilify-low-stock-${today}${locSuffix()}.csv`,
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
  const zeroSellers = slowestMovers.filter((m) => m.sold === 0).length;
  const outOfStock = lowStock.filter((r) => r.quantity <= 0).length;

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
            summary={
              lowStock.length === 0
                ? "All good"
                : `${lowStock.length} low${outOfStock > 0 ? ` · ${outOfStock} out` : ""}`
            }
            summaryTone={outOfStock > 0 ? "warn" : "muted"}
            action={<CsvButton onClick={exportLowStock} disabled={lowStock.length === 0} />}
          >
            <p className="text-xs text-gray-500 mb-3">
              Products at or below {LOW_STOCK_THRESHOLD} units at {scopeLabel}.
            </p>
            {lowStock.length === 0 ? (
              <p className="text-sm text-gray-400 py-2">Nothing is running low — good stock levels.</p>
            ) : (
              <div className="divide-y divide-gray-100">
                {lowStock.map((r) => (
                  <div key={r.productId} className="flex items-center justify-between py-2.5">
                    <p className="text-sm font-medium text-gray-900 truncate">{r.name}</p>
                    <span
                      className={`text-sm font-semibold shrink-0 ml-3 ${
                        r.quantity <= 0 ? "text-red-600" : "text-amber-600"
                      }`}
                    >
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
