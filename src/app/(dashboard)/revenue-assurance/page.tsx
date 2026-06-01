"use client";
import { useState, useEffect } from "react";
import { db } from "@/lib/supabase";
import { formatZAR } from "@/lib/format";
import { ShieldCheck, AlertTriangle, TrendingDown, Eye } from "lucide-react";

interface AssuranceRow {
  productId: string;
  inventoryId: string;
  name: string;
  category: string;
  sellingPrice: number;
  openingStock: number;
  replenished: number;
  recordedSales: number;
  expectedClosing: number;
  actualClosing: number;
  variance: number; // positive = more left than expected (unrecorded sales unlikely), negative = units missing
  missingRevenue: number;
}

export default function RevenueAssurancePage() {
  const [rows, setRows] = useState<AssuranceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [filterMode, setFilterMode] = useState<"all" | "discrepancies">("discrepancies");

  useEffect(() => {
    loadAssurance();
  }, [selectedDate]);

  async function loadAssurance() {
    setLoading(true);

    // 1. Get stock counts for the selected date (this is what the cashier physically counted)
    const { data: counts } = await db
      .from("stock_counts")
      .select("product_id, opening_units, closing_units")
      .eq("count_date", selectedDate);

    if (!counts || counts.length === 0) {
      setRows([]);
      setLoading(false);
      return;
    }

    const countMap = new Map<string, { opening: number; closing: number }>();
    (counts as any[]).forEach((c: any) => {
      countMap.set(c.product_id, { opening: c.opening_units, closing: c.closing_units });
    });

    const productIds = [...countMap.keys()];

    // 2. Get product details
    const { data: products } = await db
      .from("products")
      .select("id, inventory_id, name, category, selling_price, qty_in_pack")
      .in("id", productIds);

    // 3. Get recorded sales for that date
    const { data: sales } = await db
      .from("sales")
      .select("product_id, quantity")
      .eq("sale_date", selectedDate);

    const salesMap = new Map<string, number>();
    ((sales || []) as any[]).forEach((s: any) => {
      salesMap.set(s.product_id, (salesMap.get(s.product_id) || 0) + s.quantity);
    });

    // 4. Get replenishments for that date
    const { data: receipts } = await db
      .from("stock_receipts")
      .select("id")
      .eq("receipt_date", selectedDate);

    const receiptIds = ((receipts || []) as any[]).map((r: any) => r.id);
    let replenishMap = new Map<string, number>();
    if (receiptIds.length > 0) {
      const { data: items } = await db
        .from("stock_receipt_items")
        .select("product_id, quantity")
        .in("receipt_id", receiptIds)
        .not("product_id", "is", null);

      ((items || []) as any[]).forEach((i: any) => {
        replenishMap.set(i.product_id, (replenishMap.get(i.product_id) || 0) + i.quantity);
      });
    }

    // 5. Build assurance rows
    const prodMap = new Map<string, any>();
    ((products || []) as any[]).forEach((p: any) => prodMap.set(p.id, p));

    const assuranceRows: AssuranceRow[] = [];
    for (const [productId, count] of countMap) {
      const prod = prodMap.get(productId);
      if (!prod) continue;

      const openingStock = count.opening;
      const replenished = replenishMap.get(productId) || 0;
      const replenishedUnits = replenished * (prod.qty_in_pack || 1);
      const recordedSales = salesMap.get(productId) || 0;
      const expectedClosing = openingStock + replenishedUnits - recordedSales;
      const actualClosing = count.closing;
      const variance = actualClosing - expectedClosing; // negative = units unaccounted for
      const unrecordedUnits = Math.max(-variance, 0); // only count missing stock
      const missingRevenue = unrecordedUnits * prod.selling_price;

      assuranceRows.push({
        productId,
        inventoryId: prod.inventory_id,
        name: prod.name,
        category: prod.category,
        sellingPrice: prod.selling_price,
        openingStock,
        replenished: replenishedUnits,
        recordedSales,
        expectedClosing,
        actualClosing,
        variance,
        missingRevenue,
      });
    }

    // Sort: biggest missing revenue first
    assuranceRows.sort((a, b) => b.missingRevenue - a.missingRevenue);
    setRows(assuranceRows);
    setLoading(false);
  }

  const filtered = filterMode === "discrepancies"
    ? rows.filter((r) => r.variance !== 0)
    : rows;

  const totalMissingRevenue = rows.reduce((sum, r) => sum + r.missingRevenue, 0);
  const totalRecordedRevenue = rows.reduce((sum, r) => sum + r.recordedSales * r.sellingPrice, 0);
  const totalExpectedRevenue = totalRecordedRevenue + totalMissingRevenue;
  const discrepancyCount = rows.filter((r) => r.variance < 0).length;
  const totalUnrecordedUnits = rows.reduce((sum, r) => sum + Math.max(-r.variance, 0), 0);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <ShieldCheck className="w-7 h-7 text-green-600" />
          Revenue Assurance
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Compare stock counts against recorded sales to detect unrecorded revenue
        </p>
      </div>

      {/* Date picker */}
      <div className="flex flex-wrap gap-3 mb-6 items-end">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Date</label>
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
          />
        </div>
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
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
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading...</div>
      ) : rows.length === 0 ? (
        <div className="text-center py-12">
          <Eye className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500">No stock count found for {selectedDate}.</p>
          <p className="text-sm text-gray-400 mt-1">A stock count must be done before revenue assurance can run.</p>
        </div>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <div className="bg-white border border-gray-200 rounded-xl px-5 py-4">
              <p className="text-xs text-gray-500">Recorded Revenue</p>
              <p className="text-xl font-bold text-gray-900">{formatZAR(totalRecordedRevenue)}</p>
            </div>
            <div className={`border rounded-xl px-5 py-4 ${totalMissingRevenue > 0 ? "bg-red-50 border-red-200" : "bg-green-50 border-green-200"}`}>
              <p className={`text-xs ${totalMissingRevenue > 0 ? "text-red-600" : "text-green-600"}`}>Unrecorded Revenue</p>
              <p className={`text-xl font-bold ${totalMissingRevenue > 0 ? "text-red-700" : "text-green-700"}`}>{formatZAR(totalMissingRevenue)}</p>
            </div>
            <div className="bg-blue-50 border border-blue-200 rounded-xl px-5 py-4">
              <p className="text-xs text-blue-600">Expected Revenue</p>
              <p className="text-xl font-bold text-blue-700">{formatZAR(totalExpectedRevenue)}</p>
              <p className="text-xs text-blue-500 mt-0.5">Based on stock movement</p>
            </div>
            <div className={`border rounded-xl px-5 py-4 ${discrepancyCount > 0 ? "bg-amber-50 border-amber-200" : "bg-green-50 border-green-200"}`}>
              <p className={`text-xs ${discrepancyCount > 0 ? "text-amber-600" : "text-green-600"}`}>Products with Variance</p>
              <p className={`text-xl font-bold ${discrepancyCount > 0 ? "text-amber-700" : "text-green-700"}`}>
                {discrepancyCount} / {rows.length}
              </p>
              {totalUnrecordedUnits > 0 && (
                <p className="text-xs text-amber-500 mt-0.5">{totalUnrecordedUnits} units unaccounted for</p>
              )}
            </div>
          </div>

          {/* Explanation */}
          {totalMissingRevenue > 0 && (
            <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-5 py-4 mb-6">
              <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" />
              <div className="text-sm text-amber-800">
                <p className="font-semibold">Stock left the shelves without recorded sales</p>
                <p className="mt-1">
                  Based on the stock count, <strong>{totalUnrecordedUnits} units</strong> were sold but not rung through the POS.
                  At selling prices, this represents <strong>{formatZAR(totalMissingRevenue)}</strong> in unrecorded revenue.
                  The actual cash in the till should be closer to <strong>{formatZAR(totalExpectedRevenue)}</strong> than the recorded {formatZAR(totalRecordedRevenue)}.
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
                    <th className="text-right px-3 py-3 font-medium text-gray-500">Recorded Sales</th>
                    <th className="text-right px-3 py-3 font-medium text-gray-500">Expected</th>
                    <th className="text-right px-3 py-3 font-medium text-gray-500">Counted</th>
                    <th className="text-right px-3 py-3 font-medium text-gray-500">Variance</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-500">Missing Rev.</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-4 py-8 text-center text-gray-400">
                        {filterMode === "discrepancies" ? "No discrepancies found — all stock matches recorded sales." : "No data."}
                      </td>
                    </tr>
                  ) : (
                    filtered.map((r) => (
                      <tr key={r.productId} className={r.variance < 0 ? "bg-red-50/50" : r.variance > 0 ? "bg-blue-50/30" : ""}>
                        <td className="px-4 py-3">
                          <span className="font-medium text-gray-900">{r.name}</span>
                          <span className="text-xs text-gray-400 ml-2 font-mono">{r.inventoryId}</span>
                          <span className="block text-xs text-gray-400">{r.category} · {formatZAR(r.sellingPrice)}/unit</span>
                        </td>
                        <td className="text-right px-3 py-3 text-gray-600">{r.openingStock}</td>
                        <td className="text-right px-3 py-3 text-gray-600">{r.replenished > 0 ? `+${r.replenished}` : "—"}</td>
                        <td className="text-right px-3 py-3 text-gray-600">{r.recordedSales > 0 ? `-${r.recordedSales}` : "—"}</td>
                        <td className="text-right px-3 py-3 font-medium text-gray-700">{r.expectedClosing}</td>
                        <td className="text-right px-3 py-3 font-medium text-gray-700">{r.actualClosing}</td>
                        <td className={`text-right px-3 py-3 font-semibold ${
                          r.variance < 0 ? "text-red-600" : r.variance > 0 ? "text-blue-600" : "text-green-600"
                        }`}>
                          {r.variance > 0 ? "+" : ""}{r.variance}
                          {r.variance < 0 && (
                            <span className="block text-xs font-normal text-red-400">
                              {Math.abs(r.variance)} unrecorded
                            </span>
                          )}
                          {r.variance > 0 && (
                            <span className="block text-xs font-normal text-blue-400">
                              surplus
                            </span>
                          )}
                        </td>
                        <td className={`text-right px-4 py-3 font-bold ${r.missingRevenue > 0 ? "text-red-700" : "text-gray-400"}`}>
                          {r.missingRevenue > 0 ? formatZAR(r.missingRevenue) : "—"}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
                {filtered.length > 0 && totalMissingRevenue > 0 && (
                  <tfoot className="bg-gray-50 border-t border-gray-200">
                    <tr>
                      <td colSpan={7} className="px-4 py-3 text-right font-semibold text-gray-700">
                        Total Unrecorded Revenue
                      </td>
                      <td className="px-4 py-3 text-right font-bold text-red-700 text-base">
                        {formatZAR(totalMissingRevenue)}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>

          {/* Legend */}
          <div className="mt-4 flex flex-wrap gap-4 text-xs text-gray-500">
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded bg-red-100 border border-red-200" /> Negative variance — units left without a sale
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded bg-blue-100 border border-blue-200" /> Positive variance — surplus (count error or unrecorded restock)
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded bg-white border border-gray-200" /> Zero variance — stock matches perfectly
            </span>
          </div>

          {/* How it works */}
          <div className="mt-6 bg-gray-50 rounded-xl border border-gray-200 px-5 py-4 text-sm text-gray-600">
            <p className="font-semibold text-gray-700 mb-2">How this works</p>
            <p>
              For each product: <strong>Expected Closing = Opening Stock + Restocked − Recorded Sales</strong>.
              The cashier&apos;s physical count gives the <strong>Actual Closing</strong>.
              If more units left the shelf than were recorded in the POS, those are unrecorded sales.
              Multiply by the selling price to get the missing revenue — this is what the till cash should reflect
              even if the sales weren&apos;t rung up.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
