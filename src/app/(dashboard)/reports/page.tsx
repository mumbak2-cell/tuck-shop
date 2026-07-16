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
import { BarChart3, TrendingUp, PackageX, Trophy } from "lucide-react";
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
    await Promise.all([loadSales(), loadLowStock()]);
    setLoading(false);
  }

  async function loadSales() {
    // Cashiers don't see revenue; skip the sales query entirely for them.
    if (!isManager) {
      setSalesTotal(0);
      setTxnCount(0);
      setTopSellers([]);
      return;
    }
    const { from, to } = getDateRange();

    // fetchAllPaged pages past PostgREST's 1000-row cap, like profit-loss.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sales = await fetchAllPaged<any>(() => {
      let q = db
        .from("sales")
        .select("product_id, quantity, total_amount, products(name)")
        .gte("sale_date", from)
        .lte("sale_date", to)
        .eq("voided", false);
      if (isFiltered) q = q.eq("location_id", effectiveLoc);
      return q;
    });

    // Aggregate in the browser — no backend, no cost.
    const byProduct = new Map<string, SellerRow>();
    let total = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sales as any[]).forEach((s: any) => {
      const revenue = Number(s.total_amount) || 0;
      total += revenue;
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

    setSalesTotal(total);
    setTxnCount(sales.length);
    setTopSellers([...byProduct.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 10));
  }

  async function loadLowStock() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await fetchAllPaged<any>(() => {
      let q = db.from("product_stock").select("product_id, quantity, products(name)");
      if (isFiltered) q = q.eq("location_id", effectiveLoc);
      return q;
    });

    // Sum quantity per product (across branches when "All locations" is selected).
    const byProduct = new Map<string, StockRow>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (rows as any[]).forEach((r: any) => {
      const cur = byProduct.get(r.product_id) ?? {
        productId: r.product_id,
        name: r.products?.name || "—",
        quantity: 0,
      };
      cur.quantity += Number(r.quantity) || 0;
      byProduct.set(r.product_id, cur);
    });

    setLowStock(
      [...byProduct.values()]
        .filter((r) => r.quantity <= LOW_STOCK_THRESHOLD)
        .sort((a, b) => a.quantity - b.quantity)
    );
  }

  const periods: { key: Period; label: string }[] = [
    { key: "today", label: "Today" },
    { key: "week", label: "This Week" },
    { key: "month", label: "This Month" },
    { key: "custom", label: "Custom" },
  ];

  const scopeLabel = isFiltered ? filteredLocName : currentLocationName || "your shop";

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

          {/* Low stock — everyone (cashiers see their own branch) */}
          <div className="bg-white border border-gray-200 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2 mb-1">
              <PackageX className="w-4 h-4 text-amber-600" />
              Low stock
            </h2>
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
