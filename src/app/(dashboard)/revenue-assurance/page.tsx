"use client";
import { useState, useEffect } from "react";
import { db } from "@/lib/supabase";
import { formatZAR } from "@/lib/format";
import { ShieldCheck, AlertTriangle, Eye, Calendar } from "lucide-react";

interface CountOption {
  date: string;
  countedBy: string;
  countedAt: string;
  productCount: number;
  label: string;
}

interface AssuranceRow {
  productId: string;
  inventoryId: string;
  name: string;
  category: string;
  sellingPrice: number;
  openingStock: number;
  replenished: number;
  closingStock: number;
  unitsSold: number;
  recordedSales: number;
  unrecordedUnits: number;
  expectedRevenue: number;
  recordedRevenue: number;
  missingRevenue: number;
}

export default function RevenueAssurancePage() {
  const [rows, setRows] = useState<AssuranceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterMode, setFilterMode] = useState<"all" | "discrepancies">("discrepancies");

  // Available stock counts
  const [countOptions, setCountOptions] = useState<CountOption[]>([]);
  const [openingIdx, setOpeningIdx] = useState<number>(-1);
  const [closingIdx, setClosingIdx] = useState<number>(-1);
  const [loadingOptions, setLoadingOptions] = useState(true);

  // Load available stock count dates
  useEffect(() => {
    loadCountOptions();
  }, []);

  async function loadCountOptions() {
    setLoadingOptions(true);

    // Get distinct count dates with metadata, ordered newest first
    const { data: counts } = await db
      .from("stock_counts")
      .select("count_date, counted_by, counted_at")
      .order("count_date", { ascending: false })
      .order("counted_at", { ascending: false });

    if (!counts || counts.length === 0) {
      setCountOptions([]);
      setLoadingOptions(false);
      setLoading(false);
      return;
    }

    // Group by unique count_date
    const seen = new Map<string, { countedBy: string; countedAt: string }>();
    (counts as any[]).forEach((c: any) => {
      if (!seen.has(c.count_date)) {
        seen.set(c.count_date, { countedBy: c.counted_by || "Unknown", countedAt: c.counted_at || "" });
      }
    });

    // Get product counts per date
    const options: CountOption[] = [];
    for (const [date, info] of seen) {
      const { count } = await db
        .from("stock_counts")
        .select("*", { count: "exact", head: true })
        .eq("count_date", date);

      const dateStr = new Date(date + "T00:00:00").toLocaleDateString("en-ZA", {
        weekday: "short", day: "numeric", month: "short", year: "numeric",
      });
      const timeStr = info.countedAt
        ? new Date(info.countedAt).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" })
        : "";

      options.push({
        date,
        countedBy: info.countedBy,
        countedAt: info.countedAt,
        productCount: count || 0,
        label: `${dateStr}${timeStr ? ` at ${timeStr}` : ""} — ${info.countedBy} (${count || 0} products)`,
      });
    }

    setCountOptions(options);

    // Auto-select: closing = most recent, opening = second most recent
    if (options.length >= 2) {
      setClosingIdx(0);
      setOpeningIdx(1);
    } else if (options.length === 1) {
      setClosingIdx(0);
      setOpeningIdx(-1);
    }

    setLoadingOptions(false);
  }

  // Load assurance when selections change
  useEffect(() => {
    if (!loadingOptions && closingIdx >= 0) {
      loadAssurance();
    }
  }, [openingIdx, closingIdx, loadingOptions]);

  async function loadAssurance() {
    if (closingIdx < 0 || closingIdx >= countOptions.length) {
      setRows([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const closingDate = countOptions[closingIdx].date;

    // 1. Get closing stock counts
    const { data: closingCounts } = await db
      .from("stock_counts")
      .select("product_id, closing_units")
      .eq("count_date", closingDate);

    if (!closingCounts || closingCounts.length === 0) {
      setRows([]);
      setLoading(false);
      return;
    }

    const closingMap = new Map<string, number>();
    (closingCounts as any[]).forEach((c: any) => {
      closingMap.set(c.product_id, c.closing_units);
    });

    const productIds = [...closingMap.keys()];

    // 2. Get opening stock (from selected opening count, or opening_units if none)
    const openingMap = new Map<string, number>();
    if (openingIdx >= 0 && openingIdx < countOptions.length) {
      const openingDate = countOptions[openingIdx].date;
      const { data: openingCounts } = await db
        .from("stock_counts")
        .select("product_id, closing_units")
        .eq("count_date", openingDate)
        .in("product_id", productIds);

      ((openingCounts || []) as any[]).forEach((c: any) => {
        openingMap.set(c.product_id, c.closing_units);
      });
    } else {
      // No opening selected — use opening_units from closing count
      const { data: fallback } = await db
        .from("stock_counts")
        .select("product_id, opening_units")
        .eq("count_date", closingDate);

      ((fallback || []) as any[]).forEach((c: any) => {
        openingMap.set(c.product_id, c.opening_units);
      });
    }

    // 3. Get product details
    const { data: products } = await db
      .from("products")
      .select("id, inventory_id, name, category, selling_price, qty_in_pack")
      .in("id", productIds);

    const prodMap = new Map<string, any>();
    ((products || []) as any[]).forEach((p: any) => prodMap.set(p.id, p));

    // 4. Get replenishments between opening and closing dates
    const dateFrom = openingIdx >= 0 ? countOptions[openingIdx].date : closingDate;
    const dateTo = closingDate;

    let replenishMap = new Map<string, number>();
    const { data: receipts } = await db
      .from("stock_receipts")
      .select("id")
      .gte("receipt_date", dateFrom)
      .lte("receipt_date", dateTo);

    const receiptIds = ((receipts || []) as any[]).map((r: any) => r.id);
    if (receiptIds.length > 0) {
      const { data: items } = await db
        .from("stock_receipt_items")
        .select("product_id, quantity")
        .in("receipt_id", receiptIds)
        .not("product_id", "is", null);

      ((items || []) as any[]).forEach((i: any) => {
        const prod = prodMap.get(i.product_id);
        const qtyInPack = prod?.qty_in_pack || 1;
        replenishMap.set(i.product_id, (replenishMap.get(i.product_id) || 0) + (i.quantity * qtyInPack));
      });
    }

    // 5. Get recorded sales between opening and closing dates
    let salesQuery = db
      .from("sales")
      .select("product_id, quantity, total_amount")
      .eq("voided", false);

    if (dateFrom === dateTo) {
      salesQuery = salesQuery.eq("sale_date", dateTo);
    } else {
      salesQuery = salesQuery.gte("sale_date", dateFrom).lte("sale_date", dateTo);
    }

    const { data: sales } = await salesQuery;

    const salesQtyMap = new Map<string, number>();
    const salesRevMap = new Map<string, number>();
    ((sales || []) as any[]).forEach((s: any) => {
      salesQtyMap.set(s.product_id, (salesQtyMap.get(s.product_id) || 0) + s.quantity);
      salesRevMap.set(s.product_id, (salesRevMap.get(s.product_id) || 0) + s.total_amount);
    });

    // 6. Build assurance rows
    const assuranceRows: AssuranceRow[] = [];
    for (const [productId, closingStock] of closingMap) {
      const prod = prodMap.get(productId);
      if (!prod) continue;

      const openingStock = openingMap.get(productId) || 0;
      const replenished = replenishMap.get(productId) || 0;
      const recordedSales = salesQtyMap.get(productId) || 0;
      const recordedRevenue = salesRevMap.get(productId) || 0;

      const unitsSold = Math.max(openingStock + replenished - closingStock, 0);
      const expectedRevenue = unitsSold * prod.selling_price;
      const unrecordedUnits = Math.max(unitsSold - recordedSales, 0);
      const missingRevenue = unrecordedUnits * prod.selling_price;

      assuranceRows.push({
        productId,
        inventoryId: prod.inventory_id,
        name: prod.name,
        category: prod.category,
        sellingPrice: prod.selling_price,
        openingStock,
        replenished,
        closingStock,
        unitsSold,
        recordedSales,
        unrecordedUnits,
        expectedRevenue,
        recordedRevenue,
        missingRevenue,
      });
    }

    assuranceRows.sort((a, b) => b.missingRevenue - a.missingRevenue);
    setRows(assuranceRows);
    setLoading(false);
  }

  const filtered = filterMode === "discrepancies"
    ? rows.filter((r) => r.unrecordedUnits > 0)
    : rows;

  const totalExpectedRevenue = rows.reduce((sum, r) => sum + r.expectedRevenue, 0);
  const totalRecordedRevenue = rows.reduce((sum, r) => sum + r.recordedRevenue, 0);
  const totalMissingRevenue = rows.reduce((sum, r) => sum + r.missingRevenue, 0);
  const totalUnitsSold = rows.reduce((sum, r) => sum + r.unitsSold, 0);
  const totalUnrecorded = rows.reduce((sum, r) => sum + r.unrecordedUnits, 0);
  const discrepancyCount = rows.filter((r) => r.unrecordedUnits > 0).length;

  if (loadingOptions) {
    return <div className="text-center py-12 text-gray-400">Loading...</div>;
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <ShieldCheck className="w-7 h-7 text-green-600" />
          Revenue Assurance
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Opening + Replenished − Closing = Units Sold → compare against recorded POS sales
        </p>
      </div>

      {countOptions.length === 0 ? (
        <div className="text-center py-12">
          <Eye className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500">No stock counts found.</p>
          <p className="text-sm text-gray-400 mt-1">Do a stock count first, then come back here.</p>
        </div>
      ) : (
        <>
          {/* Stock count selectors */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            <div>
              <label className="flex items-center gap-1.5 text-sm font-medium text-gray-700 mb-2">
                <Calendar className="w-4 h-4" />
                Opening Stock Count
              </label>
              <select
                value={openingIdx}
                onChange={(e) => setOpeningIdx(parseInt(e.target.value))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
              >
                <option value={-1}>— Use system opening stock —</option>
                {countOptions.map((opt, idx) => (
                  <option key={`open-${idx}`} value={idx} disabled={idx === closingIdx}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="flex items-center gap-1.5 text-sm font-medium text-gray-700 mb-2">
                <Calendar className="w-4 h-4" />
                Closing Stock Count
              </label>
              <select
                value={closingIdx}
                onChange={(e) => setClosingIdx(parseInt(e.target.value))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
              >
                {countOptions.map((opt, idx) => (
                  <option key={`close-${idx}`} value={idx} disabled={idx === openingIdx}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Filter toggle */}
          <div className="flex gap-1 bg-gray-100 rounded-lg p-1 mb-6 w-fit">
            <button
              onClick={() => setFilterMode("discrepancies")}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                filterMode === "discrepancies" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"
              }`}
            >
              Discrepancies Only
            </button>
            <button
              onClick={() => setFilterMode("all")}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                filterMode === "all" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"
              }`}
            >
              All Products
            </button>
          </div>

          {loading ? (
            <div className="text-center py-12 text-gray-400">Calculating...</div>
          ) : (
            <>
              {/* Summary cards */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                <div className="bg-white border border-gray-200 rounded-xl px-5 py-4">
                  <p className="text-xs text-gray-500">Units Sold (by stock)</p>
                  <p className="text-xl font-bold text-gray-900">{totalUnitsSold}</p>
                </div>
                <div className="bg-blue-50 border border-blue-200 rounded-xl px-5 py-4">
                  <p className="text-xs text-blue-600">Expected Revenue</p>
                  <p className="text-xl font-bold text-blue-700">{formatZAR(totalExpectedRevenue)}</p>
                  <p className="text-xs text-blue-500 mt-0.5">What should be in cash + POS</p>
                </div>
                <div className="bg-white border border-gray-200 rounded-xl px-5 py-4">
                  <p className="text-xs text-gray-500">Recorded in POS</p>
                  <p className="text-xl font-bold text-gray-900">{formatZAR(totalRecordedRevenue)}</p>
                </div>
                <div className={`border rounded-xl px-5 py-4 ${totalMissingRevenue > 0 ? "bg-red-50 border-red-200" : "bg-green-50 border-green-200"}`}>
                  <p className={`text-xs ${totalMissingRevenue > 0 ? "text-red-600" : "text-green-600"}`}>Unrecorded</p>
                  <p className={`text-xl font-bold ${totalMissingRevenue > 0 ? "text-red-700" : "text-green-700"}`}>{formatZAR(totalMissingRevenue)}</p>
                  {totalUnrecorded > 0 && (
                    <p className="text-xs text-red-500 mt-0.5">{totalUnrecorded} units not in POS</p>
                  )}
                </div>
              </div>

              {/* Alert */}
              {totalMissingRevenue > 0 && (
                <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-5 py-4 mb-6">
                  <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" />
                  <div className="text-sm text-amber-800">
                    <p className="font-semibold">Stock moved without recorded sales</p>
                    <p className="mt-1">
                      Based on stock movement, <strong>{totalUnitsSold} units</strong> left the shelves.
                      Only <strong>{totalUnitsSold - totalUnrecorded}</strong> were recorded in the POS.
                      The remaining <strong>{totalUnrecorded} units</strong> ({formatZAR(totalMissingRevenue)}) are unaccounted for.
                      Cash on hand should be closer to <strong>{formatZAR(totalExpectedRevenue)}</strong>.
                    </p>
                  </div>
                </div>
              )}

              {/* Detail table */}
              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-200">
                        <th className="text-left px-4 py-3 font-medium text-gray-500">Product</th>
                        <th className="text-right px-3 py-3 font-medium text-gray-500">Opening</th>
                        <th className="text-right px-3 py-3 font-medium text-gray-500">Restock</th>
                        <th className="text-right px-3 py-3 font-medium text-gray-500">Closing</th>
                        <th className="text-right px-3 py-3 font-medium text-gray-500">Units Sold</th>
                        <th className="text-right px-3 py-3 font-medium text-gray-500">POS Recorded</th>
                        <th className="text-right px-3 py-3 font-medium text-gray-500">Unrecorded</th>
                        <th className="text-right px-4 py-3 font-medium text-gray-500">Missing Rev.</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {filtered.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="px-4 py-8 text-center text-gray-400">
                            {filterMode === "discrepancies" ? "No discrepancies — all stock movement matches POS records." : "No data."}
                          </td>
                        </tr>
                      ) : (
                        filtered.map((r) => (
                          <tr key={r.productId} className={r.unrecordedUnits > 0 ? "bg-red-50/50" : ""}>
                            <td className="px-4 py-3">
                              <span className="font-medium text-gray-900">{r.name}</span>
                              <span className="text-xs text-gray-400 ml-2 font-mono">{r.inventoryId}</span>
                              <span className="block text-xs text-gray-400">{r.category} · {formatZAR(r.sellingPrice)}/unit</span>
                            </td>
                            <td className="text-right px-3 py-3 text-gray-600">{r.openingStock}</td>
                            <td className="text-right px-3 py-3 text-gray-600">{r.replenished > 0 ? `+${r.replenished}` : "—"}</td>
                            <td className="text-right px-3 py-3 text-gray-600">{r.closingStock}</td>
                            <td className="text-right px-3 py-3 font-medium text-gray-900">{r.unitsSold}</td>
                            <td className="text-right px-3 py-3 text-gray-600">{r.recordedSales}</td>
                            <td className={`text-right px-3 py-3 font-semibold ${r.unrecordedUnits > 0 ? "text-red-600" : "text-green-600"}`}>
                              {r.unrecordedUnits > 0 ? r.unrecordedUnits : "✓"}
                            </td>
                            <td className={`text-right px-4 py-3 font-bold ${r.missingRevenue > 0 ? "text-red-700" : "text-gray-400"}`}>
                              {r.missingRevenue > 0 ? formatZAR(r.missingRevenue) : "—"}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                    {filtered.length > 0 && (
                      <tfoot className="bg-gray-50 border-t border-gray-200">
                        <tr>
                          <td className="px-4 py-3 font-semibold text-gray-700">Totals</td>
                          <td className="text-right px-3 py-3 text-gray-600" />
                          <td className="text-right px-3 py-3 text-gray-600" />
                          <td className="text-right px-3 py-3 text-gray-600" />
                          <td className="text-right px-3 py-3 font-semibold text-gray-900">{filtered.reduce((s, r) => s + r.unitsSold, 0)}</td>
                          <td className="text-right px-3 py-3 font-semibold text-gray-600">{filtered.reduce((s, r) => s + r.recordedSales, 0)}</td>
                          <td className="text-right px-3 py-3 font-semibold text-red-600">{filtered.reduce((s, r) => s + r.unrecordedUnits, 0)}</td>
                          <td className="text-right px-4 py-3 font-bold text-red-700">{formatZAR(filtered.reduce((s, r) => s + r.missingRevenue, 0))}</td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </div>

              {/* Legend */}
              <div className="mt-4 flex flex-wrap gap-4 text-xs text-gray-500">
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded bg-red-100 border border-red-200" /> Units left shelves without POS record
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded bg-white border border-gray-200" /> Stock movement matches POS
                </span>
              </div>

              {/* How it works */}
              <div className="mt-6 bg-gray-50 rounded-xl border border-gray-200 px-5 py-4 text-sm text-gray-600">
                <p className="font-semibold text-gray-700 mb-2">How this works</p>
                <p>
                  Select an <strong>Opening</strong> count (start of shift) and a <strong>Closing</strong> count (end of shift).
                  <strong> Units Sold = Opening + Replenished − Closing</strong>.
                  The difference between units sold and what was recorded in the POS is the unrecorded amount.
                  Cash on hand should equal the Expected Revenue figure.
                </p>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
