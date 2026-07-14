"use client";
import { useEffect, useState, useCallback } from "react";
import { db } from "@/lib/supabase";
import { fetchAllPaged } from "@/lib/fetch-all";
import { formatZAR, formatDate } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { dispatchStatusColor } from "@/lib/wms-status";
import Link from "next/link";
import {
  BarChart3,
  Package,
  AlertTriangle,
  Send,
  PackagePlus,
  Wrench,
  ClipboardCheck,
  TrendingDown,
  ArrowRight,
  RefreshCw,
  Boxes,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface WmsCatalogRow {
  id: number;
  item_name: string;
  sku: string;
  abc_class: string;
  count_frequency_days: number;
  last_counted_at: string | null;
}

interface WmsInventoryRow {
  wms_item_id: number;
  physical_qty: number;
  reorder_level: number;
  reorder_qty: number;
}

interface SummaryCard {
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ElementType;
  color: string;
  href?: string;
}

interface ReorderItem {
  id: number;
  item_name: string;
  sku: string;
  physical_qty: number;
  reorder_level: number;
  reorder_qty: number;
}

interface RecentDispatch {
  id: number;
  destination_type: string;
  destination_id: string;
  status: string;
  created_at: string;
  created_by: string | null;
  itemCount: number;
  totalUnits: number;
}

interface RecentReceipt {
  id: number;
  supplier: string | null;
  receipt_date: string;
  total_cost: number;
  recorded_by: string | null;
}

interface AdjustmentSummary {
  reason: string;
  count: number;
  totalQty: number;
}

interface CycleCountStatus {
  total: number;
  overdue: number;
  classA: number;
  classAOverdue: number;
  classB: number;
  classBOverdue: number;
  classC: number;
  classCOverdue: number;
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function WmsDashboardPage() {
  const [loading, setLoading] = useState(true);

  // Summary metrics
  const [totalItems, setTotalItems] = useState(0);
  const [totalUnitsInStock, setTotalUnitsInStock] = useState(0);
  const [estimatedValue, setEstimatedValue] = useState(0);
  const [reorderAlerts, setReorderAlerts] = useState<ReorderItem[]>([]);

  // Dispatch metrics (last 30 days)
  const [dispatchCount, setDispatchCount] = useState(0);
  const [dispatchUnits, setDispatchUnits] = useState(0);
  const [recentDispatches, setRecentDispatches] = useState<RecentDispatch[]>([]);

  // Receive metrics (last 30 days)
  const [receiptCount, setReceiptCount] = useState(0);
  const [receiptSpend, setReceiptSpend] = useState(0);
  const [recentReceipts, setRecentReceipts] = useState<RecentReceipt[]>([]);

  // Adjustment summary (last 30 days)
  const [adjustments, setAdjustments] = useState<AdjustmentSummary[]>([]);
  const [totalShrinkage, setTotalShrinkage] = useState(0);

  // Cycle count status
  const [cycleStatus, setCycleStatus] = useState<CycleCountStatus>({
    total: 0, overdue: 0,
    classA: 0, classAOverdue: 0,
    classB: 0, classBOverdue: 0,
    classC: 0, classCOverdue: 0,
  });

  const thirtyDaysAgo = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().split("T")[0];
  })();

  const fetchAll = useCallback(async () => {
    setLoading(true);

    const [
      catalog,
      inventory,
      { data: dispatches },
      { data: dispatchItems },
      { data: receipts },
      { data: receiptItems },
      { data: adjData },
    ] = await Promise.all([
      fetchAllPaged<WmsCatalogRow>(() => db.from("wms_catalog")
        .select("id, item_name, sku, abc_class, count_frequency_days, last_counted_at").order("id")),
      fetchAllPaged<WmsInventoryRow>(() => db.from("wms_inventory")
        .select("wms_item_id, physical_qty, reorder_level, reorder_qty").order("id")),
      db.from("wms_dispatches")
        .select("id, destination_type, destination_id, status, created_at, created_by")
        .gte("created_at", thirtyDaysAgo)
        .order("created_at", { ascending: false }),
      db.from("wms_dispatch_items")
        .select("dispatch_id, wms_item_id, qty_sent"),
      db.from("wms_receipts")
        .select("id, supplier, receipt_date, total_cost, recorded_by")
        .gte("created_at", thirtyDaysAgo)
        .order("created_at", { ascending: false }),
      db.from("wms_receipt_items")
        .select("receipt_id, wms_item_id, total_units, unit_cost, line_total"),
      db.from("wms_adjustments")
        .select("reason, adjustment_qty")
        .gte("created_at", thirtyDaysAgo),
    ]);

    const catalogArr: any[] = (catalog || []) as any[];
    const invArr: any[] = (inventory || []) as any[];
    const dispArr: any[] = (dispatches || []) as any[];
    const diArr: any[] = (dispatchItems || []) as any[];
    const recArr: any[] = (receipts || []) as any[];
    const riArr: any[] = (receiptItems || []) as any[];
    const adjArr: any[] = (adjData || []) as any[];

    // ---- Inventory summary ----
    setTotalItems(catalogArr.length);

    const invMap = new Map<number, any>();
    invArr.forEach((r: any) => invMap.set(r.wms_item_id, r));

    let unitsSum = 0;
    invArr.forEach((r: any) => { unitsSum += r.physical_qty; });
    setTotalUnitsInStock(unitsSum);

    // ---- Estimated stock value from latest receipt unit costs ----
    const latestCost = new Map<number, number>();
    riArr.forEach((ri: any) => {
      if (ri.unit_cost > 0) {
        latestCost.set(ri.wms_item_id, ri.unit_cost);
      }
    });
    let valueSum = 0;
    invArr.forEach((r: any) => {
      const cost = latestCost.get(r.wms_item_id) || 0;
      valueSum += r.physical_qty * cost;
    });
    setEstimatedValue(valueSum);

    // ---- Reorder alerts ----
    const alerts: ReorderItem[] = [];
    catalogArr.forEach((c: any) => {
      const inv = invMap.get(c.id);
      if (inv && inv.physical_qty <= inv.reorder_level) {
        alerts.push({
          id: c.id,
          item_name: c.item_name,
          sku: c.sku,
          physical_qty: inv.physical_qty,
          reorder_level: inv.reorder_level,
          reorder_qty: inv.reorder_qty,
        });
      }
    });
    alerts.sort((a: ReorderItem, b: ReorderItem) => a.physical_qty - b.physical_qty);
    setReorderAlerts(alerts);

    // ---- Dispatch metrics ----
    setDispatchCount(dispArr.length);

    const dispItemsByDispatch = new Map<number, { count: number; units: number }>();
    diArr.forEach((di: any) => {
      const existing = dispItemsByDispatch.get(di.dispatch_id) || { count: 0, units: 0 };
      existing.count++;
      existing.units += di.qty_sent;
      dispItemsByDispatch.set(di.dispatch_id, existing);
    });

    let totalDispUnits = 0;
    diArr.forEach((di: any) => { totalDispUnits += di.qty_sent; });
    setDispatchUnits(totalDispUnits);

    const recentDisp: RecentDispatch[] = dispArr.slice(0, 5).map((d: any) => {
      const items = dispItemsByDispatch.get(d.id) || { count: 0, units: 0 };
      return {
        id: d.id,
        destination_type: d.destination_type,
        destination_id: d.destination_id,
        status: d.status,
        created_at: d.created_at,
        created_by: d.created_by,
        itemCount: items.count,
        totalUnits: items.units,
      };
    });
    setRecentDispatches(recentDisp);

    // ---- Receipt metrics ----
    setReceiptCount(recArr.length);
    let spend = 0;
    recArr.forEach((r: any) => { spend += Number(r.total_cost) || 0; });
    setReceiptSpend(spend);
    setRecentReceipts(recArr.slice(0, 5) as RecentReceipt[]);

    // ---- Adjustment summary ----
    const adjMap = new Map<string, { count: number; totalQty: number }>();
    let shrinkage = 0;
    adjArr.forEach((a: any) => {
      const existing = adjMap.get(a.reason) || { count: 0, totalQty: 0 };
      existing.count++;
      existing.totalQty += Math.abs(a.adjustment_qty);
      adjMap.set(a.reason, existing);
      if (a.adjustment_qty < 0) shrinkage += Math.abs(a.adjustment_qty);
    });
    const adjSummary: AdjustmentSummary[] = Array.from(adjMap.entries()).map(
      ([reason, v]: [string, { count: number; totalQty: number }]) => ({
        reason,
        count: v.count,
        totalQty: v.totalQty,
      })
    );
    setAdjustments(adjSummary);
    setTotalShrinkage(shrinkage);

    // ---- Cycle count status ----
    const now = new Date();
    let total = 0, overdue = 0;
    let cA = 0, cAO = 0, cB = 0, cBO = 0, cC = 0, cCO = 0;
    catalogArr.forEach((c: any) => {
      total++;
      const cls = c.abc_class || "C";
      const freq = c.count_frequency_days || 30;
      let isOd = false;
      if (!c.last_counted_at) {
        isOd = true;
      } else {
        const last = new Date(c.last_counted_at);
        const diff = Math.floor((now.getTime() - last.getTime()) / (1000 * 60 * 60 * 24));
        isOd = diff >= freq;
      }
      if (cls === "A") { cA++; if (isOd) { cAO++; overdue++; } }
      else if (cls === "B") { cB++; if (isOd) { cBO++; overdue++; } }
      else { cC++; if (isOd) { cCO++; overdue++; } }
    });
    setCycleStatus({ total, overdue, classA: cA, classAOverdue: cAO, classB: cB, classBOverdue: cBO, classC: cC, classCOverdue: cCO });

    setLoading(false);
  }, [thirtyDaysAgo]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // ---- Summary cards ----
  const cards: SummaryCard[] = [
    {
      label: "Catalog Items",
      value: totalItems,
      sub: totalUnitsInStock.toLocaleString() + " total units",
      icon: Package,
      color: "text-blue-600 bg-blue-50",
      href: "/warehouse",
    },
    {
      label: "Est. Stock Value",
      value: formatZAR(estimatedValue),
      sub: "Based on last receipt costs",
      icon: Boxes,
      color: "text-green-600 bg-green-50",
    },
    {
      label: "Reorder Alerts",
      value: reorderAlerts.length,
      sub: reorderAlerts.length > 0 ? "Items at or below reorder level" : "All items above threshold",
      icon: AlertTriangle,
      color: reorderAlerts.length > 0 ? "text-red-600 bg-red-50" : "text-green-600 bg-green-50",
      href: "/warehouse",
    },
    {
      label: "Dispatches (30d)",
      value: dispatchCount,
      sub: dispatchUnits.toLocaleString() + " units shipped",
      icon: Send,
      color: "text-purple-600 bg-purple-50",
      href: "/warehouse/dispatch",
    },
    {
      label: "Receipts (30d)",
      value: receiptCount,
      sub: formatZAR(receiptSpend) + " spent",
      icon: PackagePlus,
      color: "text-cyan-600 bg-cyan-50",
      href: "/warehouse/receive",
    },
    {
      label: "Shrinkage (30d)",
      value: totalShrinkage + " units",
      sub: adjustments.length + " adjustments logged",
      icon: TrendingDown,
      color: totalShrinkage > 0 ? "text-orange-600 bg-orange-50" : "text-green-600 bg-green-50",
      href: "/warehouse/adjustments",
    },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <BarChart3 className="w-6 h-6 text-green-600" />
          <h1 className="text-xl font-bold text-gray-900">Warehouse Dashboard</h1>
        </div>
        <button
          onClick={() => fetchAll()}
          className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          Refresh
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {cards.map((card: SummaryCard, i: number) => {
          const Icon = card.icon;
          const inner = (
            <div className="bg-white rounded-xl border border-gray-200 p-4 hover:shadow-sm transition-shadow">
              <div className="flex items-center gap-2 mb-2">
                <div className={"p-2 rounded-lg " + card.color}>
                  <Icon className="w-4 h-4" />
                </div>
              </div>
              <p className="text-2xl font-bold text-gray-900">{card.value}</p>
              <p className="text-xs text-gray-500 mt-0.5">{card.label}</p>
              {card.sub && <p className="text-xs text-gray-400 mt-1">{card.sub}</p>}
            </div>
          );
          if (card.href) {
            return <Link key={i} href={card.href}>{inner}</Link>;
          }
          return <div key={i}>{inner}</div>;
        })}
      </div>

      {/* Two-column layout: Reorder Alerts + Cycle Count Status */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Reorder Alerts */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-red-500" />
              Reorder Alerts ({reorderAlerts.length})
            </h2>
            <Link href="/warehouse" className="text-xs text-green-600 hover:underline flex items-center gap-1">
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          {reorderAlerts.length === 0 ? (
            <p className="text-sm text-gray-500 py-4 text-center">All items above reorder levels.</p>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {reorderAlerts.slice(0, 10).map((item: ReorderItem) => (
                <div key={item.id} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{item.item_name}</p>
                    <p className="text-xs text-gray-500">{item.sku}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold text-red-600">{item.physical_qty}</p>
                    <p className="text-xs text-gray-400">Reorder at {item.reorder_level}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Cycle Count Status */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
              <ClipboardCheck className="w-4 h-4 text-blue-500" />
              Cycle Count Status
            </h2>
            <Link href="/warehouse/stock-count" className="text-xs text-green-600 hover:underline flex items-center gap-1">
              Start count <ArrowRight className="w-3 h-3" />
            </Link>
          </div>

          {/* Overdue bar */}
          <div className="mb-4">
            <div className="flex items-center justify-between text-xs text-gray-600 mb-1">
              <span>Overdue: {cycleStatus.overdue} of {cycleStatus.total}</span>
              <span>{cycleStatus.total > 0 ? Math.round(((cycleStatus.total - cycleStatus.overdue) / cycleStatus.total) * 100) : 100}% on schedule</span>
            </div>
            <div className="w-full bg-gray-100 rounded-full h-2">
              <div
                className={"h-2 rounded-full transition-all " + (cycleStatus.overdue > 0 ? "bg-orange-500" : "bg-green-500")}
                style={{ width: (cycleStatus.total > 0 ? Math.round(((cycleStatus.total - cycleStatus.overdue) / cycleStatus.total) * 100) : 100) + "%" }}
              />
            </div>
          </div>

          {/* ABC breakdown */}
          <div className="space-y-3">
            {[
              { cls: "A", total: cycleStatus.classA, overdue: cycleStatus.classAOverdue, color: "red" as const },
              { cls: "B", total: cycleStatus.classB, overdue: cycleStatus.classBOverdue, color: "yellow" as const },
              { cls: "C", total: cycleStatus.classC, overdue: cycleStatus.classCOverdue, color: "blue" as const },
            ].map((row: { cls: string; total: number; overdue: number; color: "red" | "yellow" | "blue" }) => (
              <div key={row.cls} className="flex items-center justify-between py-1">
                <div className="flex items-center gap-2">
                  <Badge color={row.color}>Class {row.cls}</Badge>
                  <span className="text-sm text-gray-700 tabular-nums">{row.total} items</span>
                </div>
                <div className="text-right">
                  {row.overdue > 0 ? (
                    <span className="text-sm font-medium text-orange-600 tabular-nums">{row.overdue} overdue</span>
                  ) : (
                    <span className="text-sm text-green-600">On schedule</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Two-column: Recent Dispatches + Recent Receipts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Dispatches */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
              <Send className="w-4 h-4 text-purple-500" />
              Recent Dispatches
            </h2>
            <Link href="/warehouse/dispatch" className="text-xs text-green-600 hover:underline flex items-center gap-1">
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          {recentDispatches.length === 0 ? (
            <p className="text-sm text-gray-500 py-4 text-center">No dispatches in the last 30 days.</p>
          ) : (
            <div className="space-y-2">
              {recentDispatches.map((d: RecentDispatch) => (
                <div key={d.id} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{d.destination_id}</p>
                    <p className="text-xs text-gray-500">{d.destination_type} &middot; {formatDate(d.created_at)}</p>
                  </div>
                  {/* Shares dispatchStatusColor with the Dispatch page — the two
                      screens were mapping the same status to different colours
                      (Dispatched was green here, blue there). */}
                  <div className="text-right">
                    <Badge color={dispatchStatusColor(d.status)}>
                      {d.status}
                    </Badge>
                    <p className="text-xs text-gray-500 mt-1 tabular-nums">{d.itemCount} items, {d.totalUnits} units</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent Receipts */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
              <PackagePlus className="w-4 h-4 text-cyan-500" />
              Recent Receipts
            </h2>
            <Link href="/warehouse/receive" className="text-xs text-green-600 hover:underline flex items-center gap-1">
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          {recentReceipts.length === 0 ? (
            <p className="text-sm text-gray-500 py-4 text-center">No receipts in the last 30 days.</p>
          ) : (
            <div className="space-y-2">
              {recentReceipts.map((r: RecentReceipt) => (
                <div key={r.id} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{r.supplier || "Unknown Supplier"}</p>
                    <p className="text-xs text-gray-500">{formatDate(r.receipt_date)}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold text-gray-900">{formatZAR(Number(r.total_cost))}</p>
                    {r.recorded_by && <p className="text-xs text-gray-400">by {r.recorded_by}</p>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Adjustment summary */}
      {adjustments.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
              <Wrench className="w-4 h-4 text-orange-500" />
              Adjustments Summary (30 days)
            </h2>
            <Link href="/warehouse/adjustments" className="text-xs text-green-600 hover:underline flex items-center gap-1">
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {adjustments.map((a: AdjustmentSummary) => (
              <div key={a.reason} className="bg-gray-50 rounded-lg p-3">
                <p className="text-xs text-gray-500">{a.reason}</p>
                <p className="text-lg font-bold text-gray-900">{a.totalQty} units</p>
                <p className="text-xs text-gray-400">{a.count} entries</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
