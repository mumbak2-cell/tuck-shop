"use client";
// Free reporting page — no API calls, no LLM, no per-question cost.
//
// Every query below runs client-side through `db` (the anon Supabase client),
// so RLS scopes reads to the user's org automatically, and the location filter
// scopes them to a branch. Cashiers (role="member") are pinned to their
// assigned location by org-context and by LocationFilter, so their reports are
// automatically limited to their own shop; revenue figures are gated behind a
// manager check so they never see branch- or org-wide takings.
//
// Revenue reads the snapshotted `sales.total_amount` (captured at sale time via
// submit_sale_batch) — never recomputed from products.selling_price — per the
// sales-snapshot invariant in CLAUDE.md.
import { useState, useEffect } from "react";
import { db } from "@/lib/supabase";
import { fetchAllPaged } from "@/lib/fetch-all";
import { formatZAR } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { BarChart3, TrendingUp, TrendingDown, PackageX, Trophy, Download } from "lucide-react";
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

  const [salesTotal, setSalesTotal] = useState(0);
  const [txnCount, setTxnCount] = useState(0);
  const [topSellers, setTopSellers] = useState<SellerRow[]>([]);
  const [slowestMovers, setSlowestMovers] = useState<MoverRow[]>([]);
  const [revenueByDay, setRevenueByDay] = useState<DayRevenue[]>([]);
  const [allProductSales, setAllProductSales] = useState<SellerRow[]>([]); // full breakdown for CSV
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

    // --- Sales (managers only) — revenue, top/slowest movers, daily trend.
    if (!isManager) {
      setSalesTotal(0);
      setTxnCount(0);
      setTopSellers([]);
      setSlowestMovers([]);
      setRevenueByDay([]);
      setAllProductSales([]);
      setLoading(false);
      return;
    }

    const { from, to } = getDateRange();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sales = await fetchAllPaged<any>(() => {
      let q = db
        .from("sales")
        .select("sale_date, product_id, quantity, total_amount, products(name)")
        .gte("sale_date", from)
        .lte("sale_date", to)
        .eq("voided", false);
      if (isFiltered) q = q.eq("location_id", effectiveLoc);
      return q;
    });

    const byProduct = new Map<string, SellerRow>();
    const dayMap = new Map<string, number>();
    let total = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sales as any[]).forEach((s: any) => {
      const revenue = Number(s.total_amount) || 0;
      total += revenue;
      dayMap.set(s.sale_date, (dayMap.get(s.sale_date) ?? 0) + revenue);
      const cur = byProduct.get(s.product_id) ?? {
        productId: s.product_id,
        name: s.products?.name || "—",
        qty: 0,
        revenue: 0,
      };
      cur.qty += Number(s.quantity) || 0;
      cur.revenue += revenue;
      byProduct.set(s.product_id, cur);
    });

    const sorted = [...byProduct.values()].sort((a, b) => b.revenue - a.revenue);
    setSalesTotal(total);
    setTxnCount(sales.length);
    setTopSellers(sorted.slice(0, 10));
    setAllProductSales(sorted);

    // Daily revenue across every day in the range (gaps show as zero).
    setRevenueByDay(enumerateDays(from, to).map((date) => ({ date, revenue: dayMap.get(date) ?? 0 })));

    // Slowest movers: in-stock products that sold the fewest units (catches dead stock).
    setSlowestMovers(
      stockList
        .filter((s) => s.quantity > 0)
        .map((s) => ({ productId: s.productId, name: s.name, stock: s.quantity, sold: byProduct.get(s.productId)?.qty ?? 0 }))
        .sort((a, b) => a.sold - b.sold || b.stock - a.stock)
        .slice(0, 10)
    );

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
          <p className="text-sm text-gray-500 mt-1">Sales, top sellers, and low stock at a glance</p>
        </div>
        <div className="flex items-center gap-3">
          <LocationFilter value={locFilter} onChange={setLocFilter} />
          {isManager && (
            <Button variant="secondary" onClick={exportSales} disabled={allProductSales.length === 0}>
              <Download className="w-4 h-4 mr-2" />
              Export CSV
            </Button>
          )}
        </div>
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
          {/* Sales summary — managers only */}
          {isManager && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="bg-white border border-gray-200 rounded-xl px-5 py-4">
                <div className="flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-green-600" />
                  <p className="text-sm text-gray-500">Sales in period</p>
                </div>
                <p className="text-2xl font-bold text-gray-900 mt-1">{formatZAR(salesTotal)}</p>
              </div>
              <div className="bg-white border border-gray-200 rounded-xl px-5 py-4">
                <p className="text-sm text-gray-500">Transactions</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">{txnCount}</p>
              </div>
            </div>
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

          {/* Top sellers — managers only */}
          {isManager && (
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2 mb-1">
                <Trophy className="w-4 h-4 text-green-600" />
                Top sellers
              </h2>
              <p className="text-xs text-gray-500 mb-3">Best-selling products by revenue at {scopeLabel} for the selected period.</p>
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
            </div>
          )}

          {/* Slowest movers — managers only */}
          {isManager && (
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <div className="flex items-center justify-between mb-1">
                <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                  <TrendingDown className="w-4 h-4 text-amber-600" />
                  Slowest movers
                </h2>
                <CsvButton onClick={exportSlowest} disabled={slowestMovers.length === 0} />
              </div>
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
            </div>
          )}

          {/* Low stock — everyone (cashiers see their own branch) */}
          <div className="bg-white border border-gray-200 rounded-xl p-5">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                <PackageX className="w-4 h-4 text-amber-600" />
                Low stock
              </h2>
              <CsvButton onClick={exportLowStock} disabled={lowStock.length === 0} />
            </div>
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
          </div>
        </div>
      )}
    </div>
  );
}

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

// Small inline "Export" link used in card headers.
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

// Filename-safe slug for the export filename.
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "branch";
}
