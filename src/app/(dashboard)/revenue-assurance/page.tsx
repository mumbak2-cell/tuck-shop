"use client";
import { useState, useEffect } from "react";
import { db } from "@/lib/supabase";
import { formatZAR } from "@/lib/format";
import { useAuth } from "@/lib/auth-context";
import {
  ShieldCheck, AlertTriangle, Eye, Calendar, Info,
  MessageSquare, Wrench, Send,
} from "lucide-react";

interface CountOption {
  key: string;
  sessionId: string | null;
  date: string;
  sessionLabel: string;
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

interface RANote {
  id: string;
  product_id: string;
  note: string;
  noted_by: string;
  created_at: string;
}

const ADJUSTMENT_REASONS = ["Breakage", "Expired", "Theft", "Damaged", "Samples", "Correction", "Other"] as const;

export default function RevenueAssurancePage() {
  const { name: userName } = useAuth();
  const [rows, setRows] = useState<AssuranceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterMode, setFilterMode] = useState<"all" | "discrepancies">("discrepancies");

  const [countOptions, setCountOptions] = useState<CountOption[]>([]);
  const [openingIdx, setOpeningIdx] = useState<number>(-1);
  const [closingIdx, setClosingIdx] = useState<number>(-1);
  const [loadingOptions, setLoadingOptions] = useState(true);

  // Actions state
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [actionMode, setActionMode] = useState<"correct" | "comment" | null>(null);
  const [notes, setNotes] = useState<Map<string, RANote[]>>(new Map());
  const [commentText, setCommentText] = useState("");
  const [adjustReason, setAdjustReason] = useState<string>("Correction");
  const [adjustQty, setAdjustQty] = useState("");
  const [adjustNotes, setAdjustNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadCountOptions();
  }, []);

  async function loadCountOptions() {
    setLoadingOptions(true);

    const { data: counts } = await db
      .from("stock_counts")
      .select("session_id, session_label, count_date, counted_by, counted_at")
      .order("counted_at", { ascending: false });

    if (!counts || counts.length === 0) {
      setCountOptions([]);
      setLoadingOptions(false);
      setLoading(false);
      return;
    }

    const groupMap = new Map<string, {
      key: string; sessionId: string | null; sessionLabel: string;
      date: string; countedBy: string; countedAt: string; productCount: number;
    }>();

    (counts as any[]).forEach((c: any) => {
      const groupKey = c.session_id || `date:${c.count_date}`;
      if (!groupMap.has(groupKey)) {
        groupMap.set(groupKey, {
          key: groupKey,
          sessionId: c.session_id || null,
          sessionLabel: c.session_label || "Stock Count",
          date: c.count_date,
          countedBy: c.counted_by || "Unknown",
          countedAt: c.counted_at || "",
          productCount: 0,
        });
      }
      groupMap.get(groupKey)!.productCount++;
    });

    const options: CountOption[] = [];
    for (const info of groupMap.values()) {
      const dateStr = new Date(info.date + "T00:00:00").toLocaleDateString("en-ZA", {
        weekday: "short", day: "numeric", month: "short", year: "numeric",
      });
      const timeStr = info.countedAt
        ? new Date(info.countedAt).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" })
        : "";

      const labelParts = [dateStr];
      if (timeStr) labelParts[0] += ` at ${timeStr}`;
      labelParts.push(`${info.sessionLabel} · ${info.countedBy} (${info.productCount} items)`);

      options.push({
        key: info.key, sessionId: info.sessionId, date: info.date,
        sessionLabel: info.sessionLabel, countedBy: info.countedBy,
        countedAt: info.countedAt, productCount: info.productCount,
        label: labelParts.join(" — "),
      });
    }

    options.sort((a, b) => (b.countedAt || "").localeCompare(a.countedAt || ""));
    setCountOptions(options);

    if (options.length >= 2) {
      setClosingIdx(0);
      setOpeningIdx(1);
    } else {
      setClosingIdx(0);
      setOpeningIdx(-1);
    }

    setLoadingOptions(false);
  }

  useEffect(() => {
    if (!loadingOptions && closingIdx >= 0 && openingIdx >= 0) {
      loadAssurance();
    } else if (!loadingOptions) {
      setRows([]);
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openingIdx, closingIdx, loadingOptions]);

  async function getCountsForOption(opt: CountOption, fields: string) {
    if (opt.sessionId) {
      const { data } = await db.from("stock_counts").select(fields).eq("session_id", opt.sessionId);
      return (data || []) as any[];
    }
    const { data } = await db.from("stock_counts").select(fields).eq("count_date", opt.date);
    return (data || []) as any[];
  }

  async function loadNotes(openingSid: string, closingSid: string) {
    const { data } = await db
      .from("ra_notes")
      .select("*")
      .eq("opening_session_id", openingSid)
      .eq("closing_session_id", closingSid)
      .order("created_at", { ascending: false });

    const noteMap = new Map<string, RANote[]>();
    ((data || []) as any[]).forEach((n: any) => {
      const existing = noteMap.get(n.product_id) || [];
      existing.push(n);
      noteMap.set(n.product_id, existing);
    });
    setNotes(noteMap);
  }

  async function loadAssurance() {
    if (closingIdx < 0 || openingIdx < 0) return;

    setLoading(true);
    const closingOption = countOptions[closingIdx];
    const openingOption = countOptions[openingIdx];

    // Load notes for this comparison
    if (openingOption.sessionId && closingOption.sessionId) {
      loadNotes(openingOption.sessionId, closingOption.sessionId);
    }

    const closingCounts = await getCountsForOption(closingOption, "product_id, closing_units");
    if (closingCounts.length === 0) { setRows([]); setLoading(false); return; }

    const closingMap = new Map<string, number>();
    closingCounts.forEach((c: any) => closingMap.set(c.product_id, c.closing_units));
    const productIds = [...closingMap.keys()];

    const openingMap = new Map<string, number>();
    const openingCounts = await getCountsForOption(openingOption, "product_id, closing_units");
    openingCounts.forEach((c: any) => {
      if (productIds.includes(c.product_id)) openingMap.set(c.product_id, c.closing_units);
    });

    // Only include sellable products — exclude ingredients/non-revenue items
    const { data: products } = await db
      .from("products")
      .select("id, inventory_id, name, category, selling_price, qty_in_pack, is_sellable")
      .in("id", productIds)
      .neq("is_sellable", false);

    const prodMap = new Map<string, any>();
    ((products || []) as any[]).forEach((p: any) => prodMap.set(p.id, p));

    const dateFrom = openingOption.date;
    const dateTo = closingOption.date;

    const replenishMap = new Map<string, number>();
    const { data: receipts } = await db.from("stock_receipts").select("id")
      .gte("receipt_date", dateFrom).lte("receipt_date", dateTo);
    const receiptIds = ((receipts || []) as any[]).map((r: any) => r.id);
    if (receiptIds.length > 0) {
      const { data: items } = await db.from("stock_receipt_items").select("product_id, quantity")
        .in("receipt_id", receiptIds).not("product_id", "is", null);
      ((items || []) as any[]).forEach((i: any) => {
        const prod = prodMap.get(i.product_id);
        const qtyInPack = prod?.qty_in_pack || 1;
        replenishMap.set(i.product_id, (replenishMap.get(i.product_id) || 0) + i.quantity * qtyInPack);
      });
    }

    const openingTimestamp = openingOption.countedAt;
    const closingTimestamp = closingOption.countedAt;

    let salesData: any[] = [];
    if (openingTimestamp && closingTimestamp && dateFrom === dateTo) {
      const { data } = await db.from("sales").select("product_id, quantity, total_amount")
        .eq("voided", false).gte("created_at", openingTimestamp).lte("created_at", closingTimestamp);
      salesData = (data || []) as any[];
    } else {
      let q = db.from("sales").select("product_id, quantity, total_amount").eq("voided", false);
      if (dateFrom === dateTo) { q = q.eq("sale_date", dateTo); }
      else { q = q.gte("sale_date", dateFrom).lte("sale_date", dateTo); }
      const { data } = await q;
      salesData = (data || []) as any[];
    }

    const salesQtyMap = new Map<string, number>();
    const salesRevMap = new Map<string, number>();
    salesData.forEach((s: any) => {
      salesQtyMap.set(s.product_id, (salesQtyMap.get(s.product_id) || 0) + s.quantity);
      salesRevMap.set(s.product_id, (salesRevMap.get(s.product_id) || 0) + s.total_amount);
    });

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
        productId, inventoryId: prod.inventory_id, name: prod.name,
        category: prod.category, sellingPrice: prod.selling_price,
        openingStock, replenished, closingStock, unitsSold,
        recordedSales, unrecordedUnits, expectedRevenue, recordedRevenue, missingRevenue,
      });
    }

    assuranceRows.sort((a, b) => b.missingRevenue - a.missingRevenue);
    setRows(assuranceRows);
    setLoading(false);
  }

  // --- Action handlers ---

  function toggleRow(productId: string, mode: "correct" | "comment") {
    if (expandedRow === productId && actionMode === mode) {
      setExpandedRow(null);
      setActionMode(null);
    } else {
      setExpandedRow(productId);
      setActionMode(mode);
      setCommentText("");
      setAdjustQty("");
      setAdjustNotes("");
      setAdjustReason("Correction");
    }
  }

  async function saveComment(productId: string) {
    if (!commentText.trim()) return;
    const openingSid = countOptions[openingIdx]?.sessionId;
    const closingSid = countOptions[closingIdx]?.sessionId;
    if (!openingSid || !closingSid) return;

    setSaving(true);
    await db.from("ra_notes").insert({
      product_id: productId,
      opening_session_id: openingSid,
      closing_session_id: closingSid,
      note: commentText.trim(),
      noted_by: userName,
    });

    // Refresh notes
    await loadNotes(openingSid, closingSid);
    setCommentText("");
    setExpandedRow(null);
    setActionMode(null);
    setSaving(false);
  }

  async function saveCorrection(row: AssuranceRow) {
    const qty = parseInt(adjustQty);
    if (!qty || qty <= 0) { alert("Enter a valid quantity"); return; }

    setSaving(true);

    // Get current product stock
    const { data: prod } = await db.from("products").select("opening_stock").eq("id", row.productId).single();
    const stockBefore = (prod as any)?.opening_stock || 0;
    const stockAfter = stockBefore - qty;

    // Create stock adjustment
    await db.from("stock_adjustments").insert({
      product_id: row.productId,
      reason: adjustReason,
      quantity: qty,
      direction: "decrease",
      notes: adjustNotes || `RA discrepancy: ${row.unrecordedUnits} unrecorded units`,
      adjusted_by: userName,
      stock_before: stockBefore,
      stock_after: Math.max(stockAfter, 0),
    });

    // Update product stock
    await db.from("products").update({ opening_stock: Math.max(stockAfter, 0) }).eq("id", row.productId);

    // Auto-add a note
    const openingSid = countOptions[openingIdx]?.sessionId;
    const closingSid = countOptions[closingIdx]?.sessionId;
    if (openingSid && closingSid) {
      await db.from("ra_notes").insert({
        product_id: row.productId,
        opening_session_id: openingSid,
        closing_session_id: closingSid,
        note: `Corrected: ${qty} units written off as ${adjustReason}${adjustNotes ? ` — ${adjustNotes}` : ""}`,
        noted_by: userName,
      });
      await loadNotes(openingSid, closingSid);
    }

    setExpandedRow(null);
    setActionMode(null);
    setSaving(false);
  }

  const filtered = filterMode === "discrepancies" ? rows.filter((r) => r.unrecordedUnits > 0) : rows;
  const totalExpectedRevenue = rows.reduce((sum, r) => sum + r.expectedRevenue, 0);
  const totalRecordedRevenue = rows.reduce((sum, r) => sum + r.recordedRevenue, 0);
  const totalMissingRevenue = rows.reduce((sum, r) => sum + r.missingRevenue, 0);
  const totalUnitsSold = rows.reduce((sum, r) => sum + r.unitsSold, 0);
  const totalUnrecorded = rows.reduce((sum, r) => sum + r.unrecordedUnits, 0);

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
          Compare two stock counts to find discrepancies between stock movement and POS sales
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
          {countOptions.length === 1 && (
            <div className="flex items-start gap-3 bg-blue-50 border border-blue-200 rounded-xl px-5 py-4 mb-6">
              <Info className="w-5 h-5 text-blue-600 mt-0.5 flex-shrink-0" />
              <div className="text-sm text-blue-800">
                <p className="font-semibold">You need two stock counts to compare</p>
                <p className="mt-1">
                  Do a stock count at the <strong>start</strong> of your shift (opening count),
                  then another at the <strong>end</strong> (closing count).
                </p>
              </div>
            </div>
          )}

          {/* Stock count selectors */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            <div>
              <label className="flex items-center gap-1.5 text-sm font-medium text-gray-700 mb-2">
                <Calendar className="w-4 h-4" />
                Opening Count (start of period)
              </label>
              <select value={openingIdx} onChange={(e) => setOpeningIdx(parseInt(e.target.value))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500">
                <option value={-1}>— Select a stock count —</option>
                {countOptions.map((opt, idx) => (
                  <option key={`open-${idx}`} value={idx} disabled={idx === closingIdx}>{opt.label}</option>
                ))}
              </select>
              <p className="text-xs text-gray-400 mt-1">The closing stock from this count becomes your opening stock</p>
            </div>
            <div>
              <label className="flex items-center gap-1.5 text-sm font-medium text-gray-700 mb-2">
                <Calendar className="w-4 h-4" />
                Closing Count (end of period)
              </label>
              <select value={closingIdx} onChange={(e) => setClosingIdx(parseInt(e.target.value))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500">
                {countOptions.map((opt, idx) => (
                  <option key={`close-${idx}`} value={idx} disabled={idx === openingIdx}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Filter toggle */}
          <div className="flex gap-1 bg-gray-100 rounded-lg p-1 mb-6 w-fit">
            <button onClick={() => setFilterMode("discrepancies")}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${filterMode === "discrepancies" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"}`}>
              Discrepancies Only
            </button>
            <button onClick={() => setFilterMode("all")}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${filterMode === "all" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"}`}>
              All Products
            </button>
          </div>

          {openingIdx < 0 ? (
            <div className="text-center py-12">
              <Calendar className="w-12 h-12 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-500 font-medium">Select an opening count above</p>
              <p className="text-sm text-gray-400 mt-1">Pick the stock count from the start of the period you want to check.</p>
            </div>
          ) : loading ? (
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
                  {totalUnrecorded > 0 && <p className="text-xs text-red-500 mt-0.5">{totalUnrecorded} units not in POS</p>}
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
                        <th className="text-right px-3 py-3 font-medium text-gray-500">Missing Rev.</th>
                        <th className="px-3 py-3 font-medium text-gray-500 text-center">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {filtered.length === 0 ? (
                        <tr>
                          <td colSpan={9} className="px-4 py-8 text-center text-gray-400">
                            {filterMode === "discrepancies" ? "No discrepancies — all stock movement matches POS records." : "No data."}
                          </td>
                        </tr>
                      ) : (
                        filtered.map((r) => {
                          const rowNotes = notes.get(r.productId) || [];
                          const isExpanded = expandedRow === r.productId;

                          return (
                            <tr key={r.productId} className="group">
                              <td colSpan={9} className="p-0">
                                {/* Main row */}
                                <div className={`flex items-center ${r.unrecordedUnits > 0 ? "bg-red-50/50" : ""}`}>
                                  <div className="flex-1 px-4 py-3">
                                    <span className="font-medium text-gray-900">{r.name}</span>
                                    <span className="text-xs text-gray-400 ml-2 font-mono">{r.inventoryId}</span>
                                    <span className="block text-xs text-gray-400">{r.category} · {formatZAR(r.sellingPrice)}/unit</span>
                                    {rowNotes.length > 0 && (
                                      <span className="inline-flex items-center gap-1 text-xs text-blue-600 mt-1">
                                        <MessageSquare className="w-3 h-3" /> {rowNotes.length} note{rowNotes.length !== 1 ? "s" : ""}
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-right px-3 py-3 text-gray-600 w-16">{r.openingStock}</div>
                                  <div className="text-right px-3 py-3 text-gray-600 w-16">{r.replenished > 0 ? `+${r.replenished}` : "—"}</div>
                                  <div className="text-right px-3 py-3 text-gray-600 w-16">{r.closingStock}</div>
                                  <div className="text-right px-3 py-3 font-medium text-gray-900 w-20">{r.unitsSold}</div>
                                  <div className="text-right px-3 py-3 text-gray-600 w-24">{r.recordedSales}</div>
                                  <div className={`text-right px-3 py-3 font-semibold w-24 ${r.unrecordedUnits > 0 ? "text-red-600" : "text-green-600"}`}>
                                    {r.unrecordedUnits > 0 ? r.unrecordedUnits : "✓"}
                                  </div>
                                  <div className={`text-right px-3 py-3 font-bold w-28 ${r.missingRevenue > 0 ? "text-red-700" : "text-gray-400"}`}>
                                    {r.missingRevenue > 0 ? formatZAR(r.missingRevenue) : "—"}
                                  </div>
                                  <div className="px-3 py-3 flex gap-1 w-24 justify-center">
                                    <button onClick={() => toggleRow(r.productId, "comment")}
                                      title="Add comment"
                                      className={`p-1.5 rounded-md transition-colors ${isExpanded && actionMode === "comment" ? "bg-blue-100 text-blue-700" : "text-gray-400 hover:text-blue-600 hover:bg-blue-50"}`}>
                                      <MessageSquare className="w-4 h-4" />
                                    </button>
                                    {r.unrecordedUnits > 0 && (
                                      <button onClick={() => toggleRow(r.productId, "correct")}
                                        title="Create stock adjustment"
                                        className={`p-1.5 rounded-md transition-colors ${isExpanded && actionMode === "correct" ? "bg-amber-100 text-amber-700" : "text-gray-400 hover:text-amber-600 hover:bg-amber-50"}`}>
                                        <Wrench className="w-4 h-4" />
                                      </button>
                                    )}
                                  </div>
                                </div>

                                {/* Expanded: existing notes */}
                                {isExpanded && rowNotes.length > 0 && (
                                  <div className="px-4 pb-2">
                                    {rowNotes.map((n) => (
                                      <div key={n.id} className="flex items-start gap-2 text-xs text-gray-600 bg-gray-50 rounded-lg px-3 py-2 mb-1">
                                        <MessageSquare className="w-3 h-3 mt-0.5 text-blue-400 flex-shrink-0" />
                                        <div>
                                          <span className="font-medium text-gray-700">{n.noted_by}</span>
                                          <span className="text-gray-400 ml-1">
                                            {new Date(n.created_at).toLocaleString("en-ZA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                                          </span>
                                          <p className="mt-0.5">{n.note}</p>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                )}

                                {/* Expanded: comment form */}
                                {isExpanded && actionMode === "comment" && (
                                  <div className="px-4 pb-3">
                                    <div className="flex gap-2">
                                      <input type="text" placeholder="Add a comment about this discrepancy..."
                                        value={commentText} onChange={(e) => setCommentText(e.target.value)}
                                        onKeyDown={(e) => e.key === "Enter" && saveComment(r.productId)}
                                        className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500" />
                                      <button onClick={() => saveComment(r.productId)} disabled={saving || !commentText.trim()}
                                        className="px-3 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors flex items-center gap-1">
                                        <Send className="w-3.5 h-3.5" /> Save
                                      </button>
                                    </div>
                                  </div>
                                )}

                                {/* Expanded: correction form */}
                                {isExpanded && actionMode === "correct" && (
                                  <div className="px-4 pb-3">
                                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-2">
                                      <p className="text-xs font-medium text-amber-800">
                                        Write off {r.unrecordedUnits} unrecorded units of {r.name}
                                      </p>
                                      <div className="flex gap-2 flex-wrap">
                                        <select value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)}
                                          className="border border-amber-300 rounded-lg px-3 py-2 text-sm bg-white">
                                          {ADJUSTMENT_REASONS.map((reason) => (
                                            <option key={reason} value={reason}>{reason}</option>
                                          ))}
                                        </select>
                                        <input type="number" placeholder={`Qty (max ${r.unrecordedUnits})`}
                                          value={adjustQty} onChange={(e) => setAdjustQty(e.target.value)}
                                          className="w-32 border border-amber-300 rounded-lg px-3 py-2 text-sm" />
                                        <input type="text" placeholder="Notes (optional)"
                                          value={adjustNotes} onChange={(e) => setAdjustNotes(e.target.value)}
                                          className="flex-1 min-w-48 border border-amber-300 rounded-lg px-3 py-2 text-sm" />
                                        <button onClick={() => saveCorrection(r)} disabled={saving || !adjustQty}
                                          className="px-3 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium hover:bg-amber-700 disabled:opacity-50 transition-colors">
                                          Write Off
                                        </button>
                                      </div>
                                    </div>
                                  </div>
                                )}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                    {filtered.length > 0 && (
                      <tfoot className="bg-gray-50 border-t border-gray-200">
                        <tr>
                          <td className="px-4 py-3 font-semibold text-gray-700" colSpan={4}>Totals</td>
                          <td className="text-right px-3 py-3 font-semibold text-gray-900">{filtered.reduce((s, r) => s + r.unitsSold, 0)}</td>
                          <td className="text-right px-3 py-3 font-semibold text-gray-600">{filtered.reduce((s, r) => s + r.recordedSales, 0)}</td>
                          <td className="text-right px-3 py-3 font-semibold text-red-600">{filtered.reduce((s, r) => s + r.unrecordedUnits, 0)}</td>
                          <td className="text-right px-3 py-3 font-bold text-red-700">{formatZAR(filtered.reduce((s, r) => s + r.missingRevenue, 0))}</td>
                          <td />
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
                <span className="flex items-center gap-1.5">
                  <MessageSquare className="w-3 h-3" /> Add a comment to explain
                </span>
                <span className="flex items-center gap-1.5">
                  <Wrench className="w-3 h-3" /> Write off as stock adjustment
                </span>
              </div>

              {/* How it works */}
              <div className="mt-6 bg-gray-50 rounded-xl border border-gray-200 px-5 py-4 text-sm text-gray-600">
                <p className="font-semibold text-gray-700 mb-2">How this works</p>
                <p>
                  1. Do a stock count at the <strong>start of your shift</strong> (opening count).{" "}
                  2. Sell throughout the shift.{" "}
                  3. Do another stock count at the <strong>end of the shift</strong> (closing count).{" "}
                  4. Select both counts above.
                </p>
                <p className="mt-2">
                  <strong>Units Sold = Opening Stock + Replenished − Closing Stock</strong>.{" "}
                  The difference between units sold and what the POS recorded is the unrecorded amount.
                  Use the <strong>comment</strong> button to explain discrepancies and the <strong>write off</strong> button
                  to create a stock adjustment for breakage, theft, or other losses.
                </p>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
