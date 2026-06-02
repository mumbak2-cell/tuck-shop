"use client";
import { useState, useEffect } from "react";
import { db } from "@/lib/supabase";
import { formatZAR } from "@/lib/format";
import { ShieldCheck, AlertTriangle, Eye } from "lucide-react";

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
  const [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [filterMode, setFilterMode] = useState<"all" | "discrepancies">("discrepancies");
  const [openingSource, setOpeningSource] = useState("");

  useEffect(() => {
    loadAssurance();
  }, [selectedDate]);

  async function loadAssurance() {
    setLoading(true);
    setOpeningSource("");

    // 1. Get TODAY's closing count (end-of-shift count)
    let countDate = selectedDate;
    let { data: todayCounts } = await db
      .from("stock_counts")
      .select("product_id, closing_units")
      .eq("count_date", selectedDate);

    if (!todayCounts || todayCounts.length === 0) {
      // Fall back to most recent count date
      const { data: latest } = await db
        .from("stock_counts")
        .select("count_date")
        .order("count_date", { ascending: false })
        .limit(1);

      if (!latest || latest.length === 0) {
        setRows([]);
        setLoading(false);
        return;
      }

      countDate = (latest as any[])[0].count_date;
      setSelectedDate(countDate);

      const result = await db
        .from("stock_counts")
        .select("product_id, closing_units")
        .eq("count_date", countDate);
      todayCounts = result.data;

      if (!todayCounts || todayCounts.length === 0) {
        setRows([]);
        setLoading(false);
        return;
      }
    }

    const closingMap = new Map<string, number>();
    (todayCounts as any[]).forEach((c: any) => {
      closingMap.set(c.product_id, c.closing_units);
    });

    const productIds = [...closingMap.keys()];

    // 2. Get YESTERDAY's closing count (= today's opening)
    // Find the most recent count date BEFORE the selected date
    const { data: prevCount } = await db
      .from("stock_counts")
      .select("count_date")
      .lt("count_date", countDate)
      .order("count_date", { ascending: false })
      .limit(1);

    const openingMap = new Map<string, number>();
    if (prevCount && prevCount.length > 0) {
      const prevDate = (prevCount as any[])[0].count_date;
      setOpeningSource(prevDate);

      const { data: prevCounts } = await db
        .from("stock_counts")
        .select("product_id, closing_units")
        .eq("count_date", prevDate)
        .in("product_id", productIds);

      ((prevCounts || []) as any[]).forEach((c: any) => {
        openingMap.set(c.product_id, c.closing_units);
      });
    } else {
      // No previous count — use opening_units from today's count as fallback
      setOpeningSource("initial");
      const { data: fallback } = await db
        .from("stock_counts")
        .select("product_id, opening_units")
        .eq("count_date", countDate);

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

    // 4. Get replenishments for the selected date
    const { data: receipts } = await db
      .from("stock_receipts")
      .select("id")
      .eq("receipt_date", countDate);

    const replenishMap = new Map<string, number>();
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

    // 5. Get recorded sales for the selected date
    const { data: sales } = await db
      .from("sales")
      .select("product_id, quantity, total_amount")
      .eq("sale_date", countDate)
      .eq("voided", false);

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

      // Units that left the shelf = Opening + Replenished − Closing
      const unitsSold = openingStock + replenished - closingStock;
      const expectedRevenue = Math.max(unitsSold, 0) * prod.selling_price;
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
        unitsSold: Math.max(unitsSold, 0),
        recordedSales,
        unrecordedUnits,
        expectedRevenue,
        recordedRevenue,
        missingRevenue,
      });
    }

    // Sort: biggest missing revenue first
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
          {/* Opening source info */}
          {openingSource && openingSource !== "initial" && (
            <div className="bg-blue-50 border border-blue-100 rounded-lg px-4 py-2 mb-4 text-xs text-blue-700">
              Opening stock based on closing count from <strong>{openingSource}</strong>
            </div>
          )}
          {openingSource === "initial" && (
            <div className="bg-amber-50 border border-amber-100 rounded-lg px-4 py-2 mb-4 text-xs text-amber-700">
              No previous day count found — using system opening stock as baseline
            </div>
          )}

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
              <strong>Units Sold = Opening Stock + Replenished − Closing Stock</strong>.
              Opening stock is yesterday&apos;s closing count.
              Replenished is stock received via Receive Stock today.
              Closing stock is today&apos;s physical count.
              The difference between units sold (by stock movement) and units recorded in the POS is the unrecorded amount.
              Cash on hand should equal the Expected Revenue figure, not just what&apos;s in the POS.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
