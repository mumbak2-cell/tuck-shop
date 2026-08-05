"use client";
import { useEffect, useState, useCallback } from "react";
import { db } from "@/lib/supabase";
import { fetchAllPaged } from "@/lib/fetch-all";
import { useAuth } from "@/lib/auth-context";
import { useOrg } from "@/lib/org-context";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { abcClassColor } from "@/lib/wms-status";
import {
  ClipboardCheck,
  Search,
  Package,
  Plus,
  Check,
  AlertTriangle,
  History,
  RefreshCw,
  Filter,
  Clock,
} from "lucide-react";
import { localToday, toLocalDateStr } from "@/lib/date-utils";

interface WmsInventoryRow {
  wms_item_id: number;
  physical_qty: number;
}

interface WmsCatalogItem {
  id: number;
  sku: string;
  item_name: string;
  category: string | null;
  abc_class: string;
  count_frequency_days: number;
  last_counted_at: string | null;
}

interface CountRow {
  catalog: WmsCatalogItem;
  systemQty: number;
  countedQty: string;
  saved: boolean;
  isOverdue: boolean;
  daysSinceCount: number | null;
  nextDue: string | null;
}

interface ExistingSession {
  sessionId: string;
  label: string;
  countedBy: string;
  countedAt: string;
  itemCount: number;
}

type CountMode = "all" | "overdue" | "abc_a" | "abc_b" | "abc_c" | "category";

function isItemOverdue(item: WmsCatalogItem): boolean {
  if (!item.last_counted_at) return true;
  const lastCounted = new Date(item.last_counted_at);
  const now = new Date();
  const diff = Math.floor(
    (now.getTime() - lastCounted.getTime()) / (1000 * 60 * 60 * 24)
  );
  return diff >= item.count_frequency_days;
}

function calcDaysSince(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  const now = new Date();
  return Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
}

function nextDueDate(item: WmsCatalogItem): string | null {
  if (!item.last_counted_at) return null;
  const d = new Date(item.last_counted_at);
  d.setDate(d.getDate() + item.count_frequency_days);
  return toLocalDateStr(d);
}

export default function WmsStockCountPage() {
  const { name: userName } = useAuth();
  const { can } = useOrg();

  const [rows, setRows] = useState<CountRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [search, setSearch] = useState("");
  const [categories, setCategories] = useState<string[]>([]);

  const [countMode, setCountMode] = useState<CountMode>("all");
  const [categoryFilter, setCategoryFilter] = useState("");

  const [sessionId, setSessionId] = useState("");
  const [sessionLabel, setSessionLabel] = useState("Stock Count");
  const [todaySessions, setTodaySessions] = useState<ExistingSession[]>([]);
  const [showSessionPicker, setShowSessionPicker] = useState(false);

  const today = localToday();

  const fetchData = useCallback(
    async (forSessionId?: string) => {
      setLoading(true);

      const [catalog, inventory, { data: todayCounts }] =
        await Promise.all([
          fetchAllPaged<WmsCatalogItem>(() =>
            db
              .from("wms_catalog")
              .select("id, sku, item_name, category, abc_class, count_frequency_days, last_counted_at")
              .order("item_name")
          ),
          fetchAllPaged<WmsInventoryRow>(() => db.from("wms_inventory").select("wms_item_id, physical_qty")),
          db
            .from("wms_stock_counts")
            .select("session_id, session_label, counted_by, counted_at")
            .eq("count_date", today)
            .order("counted_at", { ascending: false }),
        ]);

      const catalogItems: WmsCatalogItem[] = (catalog || []) as any[];

      const invMap = new Map<number, number>();
      ((inventory || []) as any[]).forEach((row: any) => {
        invMap.set(row.wms_item_id, row.physical_qty);
      });

      const cats = new Set<string>();
      catalogItems.forEach((c: any) => {
        if (c.category) cats.add(c.category);
      });
      setCategories(Array.from(cats).sort());

      const sessionMap = new Map<string, ExistingSession>();
      ((todayCounts || []) as any[]).forEach((c: any) => {
        if (!sessionMap.has(c.session_id)) {
          sessionMap.set(c.session_id, {
            sessionId: c.session_id,
            label: c.session_label || "Stock Count",
            countedBy: c.counted_by || "Unknown",
            countedAt: c.counted_at || "",
            itemCount: 0,
          });
        }
        const s = sessionMap.get(c.session_id)!;
        s.itemCount++;
      });
      const sessions = [...sessionMap.values()];
      setTodaySessions(sessions);

      let activeSessionId = forSessionId || sessionId;
      if (!activeSessionId && sessions.length > 0) {
        activeSessionId = sessions[0].sessionId;
        setSessionLabel(sessions[0].label);
      }
      if (!activeSessionId) {
        activeSessionId = crypto.randomUUID();
      }
      setSessionId(activeSessionId);

      const { data: existingCounts } = await db
        .from("wms_stock_counts")
        .select("wms_item_id, counted_qty")
        .eq("session_id", activeSessionId);

      const countMap = new Map<number, number>();
      ((existingCounts || []) as any[]).forEach((c: any) => {
        countMap.set(c.wms_item_id, c.counted_qty);
      });

      const countRows: CountRow[] = catalogItems.map((c: WmsCatalogItem) => ({
        catalog: c,
        systemQty: invMap.get(c.id) ?? 0,
        countedQty: countMap.has(c.id) ? countMap.get(c.id)!.toString() : "",
        saved: countMap.has(c.id),
        isOverdue: isItemOverdue(c),
        daysSinceCount: calcDaysSince(c.last_counted_at),
        nextDue: nextDueDate(c),
      }));

      setRows(countRows);
      setLoading(false);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [today]
  );

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  function updateCount(itemId: number, value: string) {
    setRows((prev: CountRow[]) =>
      prev.map((r: CountRow) =>
        r.catalog.id === itemId ? { ...r, countedQty: value, saved: false } : r
      )
    );
  }

  function startNewSession() {
    const newId = crypto.randomUUID();
    setSessionId(newId);
    setSessionLabel("Stock Count");
    setShowSessionPicker(false);
    fetchData(newId);
  }

  function switchToSession(s: ExistingSession) {
    setSessionId(s.sessionId);
    setSessionLabel(s.label);
    setShowSessionPicker(false);
    fetchData(s.sessionId);
  }

  function startCycleCount(mode: CountMode) {
    setCountMode(mode);
    const labels: Record<CountMode, string> = {
      all: "Full Count",
      overdue: "Cycle Count — Overdue",
      abc_a: "Cycle Count — Class A",
      abc_b: "Cycle Count — Class B",
      abc_c: "Cycle Count — Class C",
      category: "Cycle Count — " + (categoryFilter || "Category"),
    };
    setSessionLabel(labels[mode]);
  }

  // Apply mode + search filters
  const modeFiltered = rows.filter((r: CountRow) => {
    switch (countMode) {
      case "overdue": return r.isOverdue;
      case "abc_a": return r.catalog.abc_class === "A";
      case "abc_b": return r.catalog.abc_class === "B";
      case "abc_c": return r.catalog.abc_class === "C";
      case "category": return !categoryFilter || r.catalog.category === categoryFilter;
      default: return true;
    }
  });

  const filtered = modeFiltered.filter((r: CountRow) => {
    if (!search) return true;
    return (
      r.catalog.item_name.toLowerCase().includes(search.toLowerCase()) ||
      r.catalog.sku.toLowerCase().includes(search.toLowerCase())
    );
  });

  async function saveAllCounts() {
    const visibleIds = new Set(filtered.map((r: CountRow) => r.catalog.id));
    const toSave = rows.filter(
      (r: CountRow) => r.countedQty !== "" && !r.saved && visibleIds.has(r.catalog.id)
    );
    if (toSave.length === 0) return;

    setSaving(true);
    const now = new Date().toISOString();

    const { data: existingCounts } = await db
      .from("wms_stock_counts")
      .select("id, wms_item_id, counted_qty, update_count")
      .eq("session_id", sessionId);

    const existingMap = new Map<number, { id: number; counted_qty: number; update_count: number }>();
    ((existingCounts || []) as any[]).forEach((c: any) => {
      existingMap.set(c.wms_item_id, {
        id: c.id,
        counted_qty: c.counted_qty,
        update_count: c.update_count || 1,
      });
    });

    const payload = toSave.map((r: CountRow) => {
      const existing = existingMap.get(r.catalog.id);
      return {
        session_id: sessionId,
        session_label: sessionLabel,
        count_date: today,
        wms_item_id: r.catalog.id,
        system_qty: r.systemQty,
        counted_qty: parseInt(r.countedQty) || 0,
        counted_by: userName,
        counted_at: now,
        updated_at: now,
        update_count: existing ? (existing.update_count || 1) + 1 : 1,
      };
    });

    const { error } = await db
      .from("wms_stock_counts")
      .upsert(payload, { onConflict: "session_id,wms_item_id" });

    if (error) {
      alert("Error saving: " + error.message);
    } else {
      const auditEntries: any[] = [];
      for (const r of toSave) {
        const existing = existingMap.get(r.catalog.id);
        if (existing && existing.counted_qty !== (parseInt(r.countedQty) || 0)) {
          auditEntries.push({
            stock_count_id: existing.id,
            wms_item_id: r.catalog.id,
            count_date: today,
            counted_qty_old: existing.counted_qty,
            counted_qty_new: parseInt(r.countedQty) || 0,
            changed_by: userName,
            changed_at: now,
          });
        }
      }
      if (auditEntries.length > 0) {
        await db.from("wms_stock_count_audit").insert(auditEntries);
      }

      setRows((prev: CountRow[]) =>
        prev.map((r: CountRow) =>
          r.countedQty !== "" && visibleIds.has(r.catalog.id) ? { ...r, saved: true } : r
        )
      );
    }

    setSaving(false);
  }

  async function applyCountToInventory() {
    if (!confirm("This will overwrite warehouse inventory quantities with the counted values and mark items as counted. Continue?")) return;

    setApplying(true);
    try {
      const { data, error } = await db.rpc("apply_wms_stock_count", { p_session_id: sessionId });
      if (error) throw error;
      alert("Inventory updated for " + data + " items. Cycle count dates refreshed.");
      await fetchData(sessionId);
    } catch (err: any) {
      console.error("Apply count error:", err);
      alert("Failed to apply: " + (err.message || "Unknown error"));
    } finally {
      setApplying(false);
    }
  }

  const totalCounted = filtered.filter((r: CountRow) => r.countedQty !== "").length;
  const unsavedCount = filtered.filter((r: CountRow) => r.countedQty !== "" && !r.saved).length;
  const savedCount = filtered.filter((r: CountRow) => r.saved).length;
  const overdueCount = rows.filter((r: CountRow) => r.isOverdue).length;
  const varianceItems = filtered.filter((r: CountRow) => {
    if (r.countedQty === "") return false;
    return parseInt(r.countedQty) !== r.systemQty;
  });

  const abcCounts = {
    A: rows.filter((r: CountRow) => r.catalog.abc_class === "A").length,
    B: rows.filter((r: CountRow) => r.catalog.abc_class === "B").length,
    C: rows.filter((r: CountRow) => r.catalog.abc_class === "C").length,
  };
  const abcOverdue = {
    A: rows.filter((r: CountRow) => r.catalog.abc_class === "A" && r.isOverdue).length,
    B: rows.filter((r: CountRow) => r.catalog.abc_class === "B" && r.isOverdue).length,
    C: rows.filter((r: CountRow) => r.catalog.abc_class === "C" && r.isOverdue).length,
  };

  if (loading) {
    return <div className="text-center py-12 text-gray-400">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <ClipboardCheck className="w-7 h-7 text-green-600" />
            Warehouse Stock Count
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {today} &middot; {savedCount}/{filtered.length} items counted
            {overdueCount > 0 && (
              <span className="text-amber-600 ml-2">&middot; {overdueCount} overdue</span>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          {savedCount > 0 && can("manage_warehouse") && (
            <Button variant="secondary" onClick={applyCountToInventory} disabled={applying}>
              <RefreshCw className={"w-4 h-4 mr-1" + (applying ? " animate-spin" : "")} />
              {applying ? "Applying..." : "Apply to Inventory"}
            </Button>
          )}
          <Button onClick={saveAllCounts} disabled={saving || unsavedCount === 0}>
            <Check className="w-4 h-4 mr-1" />
            Save ({unsavedCount})
          </Button>
        </div>
      </div>

      {/* Cycle Count Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <button
          onClick={() => startCycleCount("overdue")}
          className={"rounded-xl border p-3 text-left transition-colors " + (countMode === "overdue" ? "border-amber-400 bg-amber-50" : "border-gray-200 bg-white hover:border-amber-300")}
        >
          <div className="flex items-center gap-2 mb-1">
            <Clock className="w-4 h-4 text-amber-600" />
            <span className="text-xs font-medium text-amber-700">Overdue</span>
          </div>
          <p className="text-2xl font-bold text-gray-900">{overdueCount}</p>
          <p className="text-xs text-gray-500">items need counting</p>
        </button>

        {(["A", "B", "C"] as const).map((cls) => (
          <button
            key={cls}
            onClick={() => startCycleCount(("abc_" + cls.toLowerCase()) as CountMode)}
            className={"rounded-xl border p-3 text-left transition-colors " + (countMode === "abc_" + cls.toLowerCase() ? "border-green-400 bg-green-50" : "border-gray-200 bg-white hover:border-green-300")}
          >
            <div className="flex items-center gap-2 mb-1">
              <Badge variant={abcClassColor(cls)}>
                Class {cls}
              </Badge>
            </div>
            <p className="text-2xl font-bold text-gray-900">{abcCounts[cls]}</p>
            <p className="text-xs text-gray-500">
              {abcOverdue[cls] > 0 ? (
                <span className="text-amber-600">{abcOverdue[cls]} overdue</span>
              ) : (
                "all up to date"
              )}
            </p>
          </button>
        ))}
      </div>

      {/* Count Mode Tabs */}
      <div className="flex flex-wrap gap-1 bg-gray-100 rounded-lg p-1">
        {[
          { mode: "all" as CountMode, label: "All Items" },
          { mode: "overdue" as CountMode, label: "Overdue (" + overdueCount + ")" },
          { mode: "abc_a" as CountMode, label: "Class A" },
          { mode: "abc_b" as CountMode, label: "Class B" },
          { mode: "abc_c" as CountMode, label: "Class C" },
          { mode: "category" as CountMode, label: "By Category" },
        ].map(({ mode, label }) => (
          <button
            key={mode}
            onClick={() => startCycleCount(mode)}
            className={"px-3 py-1.5 rounded-md text-xs font-medium transition-colors " + (countMode === mode ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700")}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Category filter */}
      {countMode === "category" && (
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-gray-400" />
          <select
            value={categoryFilter}
            onChange={(e: any) => setCategoryFilter(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="">All Categories</option>
            {categories.map((c: string) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
      )}

      {/* Session controls */}
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <label className="text-xs text-gray-500 block mb-1">Session Label</label>
          <input
            type="text"
            value={sessionLabel}
            onChange={(e: any) => setSessionLabel(e.target.value)}
            placeholder="e.g. Opening Count, Cycle Count"
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
          />
        </div>
        {todaySessions.length > 0 && (
          <div className="flex gap-2 items-end">
            <button
              onClick={() => setShowSessionPicker(!showSessionPicker)}
              className="text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2 hover:bg-green-100 transition-colors whitespace-nowrap"
            >
              <History className="w-3 h-3 inline mr-1" />
              {todaySessions.length} session{todaySessions.length !== 1 ? "s" : ""} today
            </button>
            <button
              onClick={startNewSession}
              className="text-xs text-gray-700 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 hover:bg-gray-100 transition-colors whitespace-nowrap"
            >
              <Plus className="w-3 h-3 inline mr-1" />
              New Session
            </button>
          </div>
        )}
      </div>

      {/* Session picker */}
      {showSessionPicker && todaySessions.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
          <p className="px-4 py-2 text-xs font-medium text-gray-500">Today&apos;s Count Sessions</p>
          {todaySessions.map((s: ExistingSession) => {
            const timeStr = s.countedAt
              ? new Date(s.countedAt).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" })
              : "";
            const isActive = s.sessionId === sessionId;
            return (
              <button
                key={s.sessionId}
                onClick={() => switchToSession(s)}
                className={"w-full text-left px-4 py-3 text-sm hover:bg-gray-50 transition-colors " + (isActive ? "bg-green-50" : "")}
              >
                <span className="font-medium text-gray-900">{s.label}</span>
                <span className="text-gray-400 ml-2">
                  {timeStr} &middot; {s.countedBy} &middot; {s.itemCount} items
                </span>
                {isActive && (
                  <span className="ml-2"><Badge variant="green">Current</Badge></span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Progress bar */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex justify-between text-sm mb-2">
          <span className="text-gray-600">Count progress</span>
          <span className="font-semibold text-gray-900">{totalCounted} / {filtered.length}</span>
        </div>
        <div className="w-full bg-gray-100 rounded-full h-3">
          <div
            className="bg-green-600 h-3 rounded-full transition-all"
            style={{ width: (filtered.length > 0 ? (totalCounted / filtered.length) * 100 : 0) + "%" }}
          />
        </div>
        {varianceItems.length > 0 && (
          <p className="text-xs text-amber-600 mt-2 flex items-center gap-1">
            <AlertTriangle className="w-3.5 h-3.5" />
            {varianceItems.length} item{varianceItems.length !== 1 ? "s" : ""} with variance
          </p>
        )}
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input
          type="text"
          placeholder="Search by name or SKU..."
          value={search}
          onChange={(e: any) => setSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-2.5 bg-white border border-gray-200 rounded-lg text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
        />
      </div>

      {/* Count list */}
      {filtered.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <Package className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500">
            {rows.length === 0
              ? "No items in warehouse catalog yet."
              : countMode === "overdue"
              ? "No items are overdue for counting. All up to date!"
              : "No items match your filter."}
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
          {filtered.map((row: CountRow) => {
            const counted = parseInt(row.countedQty);
            const variance = row.countedQty !== "" ? counted - row.systemQty : null;

            return (
              <div
                key={row.catalog.id}
                className={"flex items-center gap-4 px-4 py-3 " + (row.isOverdue && row.countedQty === "" ? "bg-amber-50/30" : "")}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-medium text-gray-900 truncate">
                      {row.catalog.item_name}
                    </p>
                    {row.saved && <Check className="w-4 h-4 text-green-600 flex-shrink-0" />}
                    <Badge variant={abcClassColor(row.catalog.abc_class)}>
                      {row.catalog.abc_class}
                    </Badge>
                    {row.isOverdue && row.countedQty === "" && (
                      <Badge variant="amber">
                        <Clock className="w-3 h-3 mr-0.5" />
                        Overdue
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-gray-500">
                    {row.catalog.sku}
                    {row.catalog.category ? " · " + row.catalog.category : ""}
                    {" · System: "}{row.systemQty}
                    {row.daysSinceCount !== null && (
                      <span className="ml-1">{"· Last counted: "}{row.daysSinceCount}d ago</span>
                    )}
                    {row.daysSinceCount === null && (
                      <span className="ml-1 text-amber-600">{"· Never counted"}</span>
                    )}
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    inputMode="numeric"
                    placeholder="—"
                    value={row.countedQty}
                    onChange={(e: any) => updateCount(row.catalog.id, e.target.value)}
                    className={"w-20 text-center py-2 border rounded-lg text-sm font-semibold touch-manipulation " + (row.saved ? "border-green-300 bg-green-50" : "border-gray-200 bg-white") + " focus:border-green-500 focus:ring-1 focus:ring-green-500"}
                  />

                  {variance !== null && (
                    <span className={"text-xs font-medium w-12 text-right " + (variance === 0 ? "text-green-600" : variance > 0 ? "text-blue-600" : "text-red-600")}>
                      {variance > 0 ? "+" : ""}{variance}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
