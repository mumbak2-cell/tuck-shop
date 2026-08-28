"use client";
import { useEffect, useState, useCallback } from "react";
import { db } from "@/lib/supabase";
import { Product } from "@/types/database";
import { formatZAR } from "@/lib/format";
import { useAuth } from "@/lib/auth-context";
import { useShift } from "@/lib/shift-context";
import { useOrg } from "@/lib/org-context";
import { fetchAllPaged } from "@/lib/fetch-all";
import { localToday, toLocalDateStr } from "@/lib/date-utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Check,
  AlertTriangle,
  Search,
  Package,
  Plus,
  MapPin,
} from "lucide-react";

interface StockRow {
  product: Product;
  expected: number; // product_stock.quantity at currentLocationId
  closingCount: string; // text input value
  saved: boolean;
}

interface ExistingSession {
  sessionId: string;
  label: string;
  countedBy: string;
  countedAt: string;
  productCount: number;
  confirmedBy: string | null;
  confirmedAt: string | null;
  countDate: string;
}

export default function StockCountPage() {
  const { name: userName, role: tillRole } = useAuth();
  const { markStockCountDone } = useShift();
  const { currentLocationId, currentLocationName, locations, role } = useOrg();
  // NOTHING auto-applies on save. Under no circumstances does the Save button
  // write product_stock. Every save records to stock_counts with confirmed_at
  // NULL and shows up as a pending session. The owner must explicitly click
  // "Confirm and apply to stock" to write it through. That is the only path
  // from a count to a stock-level change — even for the owner's own count,
  // even from an admin till PIN. This is deliberate: previously a save under
  // the owner's Supabase session stamped itself confirmed, and a shared tablet
  // with the owner signed in silently auto-approved every cashier count.
  //
  // canConfirm gates who can press the Confirm button on a pending session:
  // the Supabase account must be the owner AND the till must be on the admin
  // PIN, so a cashier PIN at the till can never trigger the write even if the
  // owner is the underlying account.
  const canConfirm = role === "owner" && tillRole === "admin";
  // Blind count: a cashier must not see the expected figure or the variance
  // while counting, so a wrong count can't be nudged to match. Gated on BOTH
  // signals for the same reason canConfirm is — the account may be an org
  // member, OR an owner/admin account on a shared till unlocked with the
  // cashier PIN. Either way the person at the screen is counting as a cashier.
  const isCashierView = role === "member" || tillRole === "cashier";
  const [rows, setRows] = useState<StockRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState("All");
  const [savedCount, setSavedCount] = useState(0);
  const [sessionId, setSessionId] = useState<string>("");
  const [sessionLabel, setSessionLabel] = useState("Stock Count");
  const [todaySessions, setTodaySessions] = useState<ExistingSession[]>([]);
  const [showSessionPicker, setShowSessionPicker] = useState(false);

  const today = localToday();

  const fetchProducts = useCallback(async (forSessionId?: string) => {
    if (!currentLocationId) {
      setLoading(false);
      return;
    }
    setLoading(true);

    // Get active products. PostgREST's server-side max_rows ceiling
    // (default 1000) silently truncates large catalogues, so we paginate
    // via .range() — bakery-supply operators like Devine Bakes carry
    // 1300+ SKUs and need every one of them on the count screen.
    const products = await fetchAllPaged<Product>(() =>
      db
        .from("products")
        .select("*")
        .eq("discontinued", false)
        .order("category")
        .order("name")
    );

    const stockRows = await fetchAllPaged<{ product_id: string; quantity: number }>(() =>
      db
        .from("product_stock")
        .select("product_id, quantity")
        .eq("location_id", currentLocationId)
    );
    const expectedMap = new Map<string, number>();
    stockRows.forEach((r) => {
      expectedMap.set(r.product_id, Number(r.quantity) || 0);
    });

    // Load today's sessions plus any unconfirmed sessions from the last 30 days,
    // so an owner can still confirm a cashier's count taken on an earlier day.
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 30);
    const cutoff = toLocalDateStr(cutoffDate);
    const { data: todayCounts } = await db
      .from("stock_counts")
      .select("session_id, session_label, counted_by, counted_at, confirmed_by, confirmed_at, count_date")
      .gte("count_date", cutoff)
      .lte("count_date", today)
      .or(`count_date.eq.${today},confirmed_at.is.null`)
      .eq("location_id", currentLocationId)
      .order("counted_at", { ascending: false });

    // Group into distinct sessions
    const sessionMap = new Map<string, ExistingSession>();
    ((todayCounts || []) as any[]).forEach((c: any) => {
      if (!sessionMap.has(c.session_id)) {
        sessionMap.set(c.session_id, {
          sessionId: c.session_id,
          label: c.session_label || "Stock Count",
          countedBy: c.counted_by || "Unknown",
          countedAt: c.counted_at || "",
          productCount: 0,
          confirmedBy: c.confirmed_by || null,
          confirmedAt: c.confirmed_at || null,
          countDate: c.count_date || today,
        });
      }
      const s = sessionMap.get(c.session_id)!;
      s.productCount++;
    });
    const sessions = [...sessionMap.values()];
    setTodaySessions(sessions);

    // Determine which session to load
    let activeSessionId = forSessionId || sessionId;
    if (!activeSessionId && sessions.length > 0) {
      // Load the most recent session
      activeSessionId = sessions[0].sessionId;
      setSessionLabel(sessions[0].label);
    }
    if (!activeSessionId) {
      // No sessions today — generate a new one
      activeSessionId = crypto.randomUUID();
    }
    setSessionId(activeSessionId);

    // Load counts for this session (filtered to current location)
    const { data: existingCounts } = await db
      .from("stock_counts")
      .select("product_id, closing_units")
      .eq("session_id", activeSessionId)
      .eq("location_id", currentLocationId);

    const countMap = new Map<string, number>();
    ((existingCounts || []) as any[]).forEach((c: any) => {
      countMap.set(c.product_id, c.closing_units);
    });

    const stockRowsForUi: StockRow[] = ((products || []) as any[]).map((p: any) => ({
      product: p,
      expected: expectedMap.get(p.id) ?? 0,
      closingCount: countMap.has(p.id) ? countMap.get(p.id)!.toString() : "",
      saved: countMap.has(p.id),
    }));

    setRows(stockRowsForUi);
    setSavedCount(stockRowsForUi.filter((r) => r.saved).length);
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [today, currentLocationId]);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  function updateCount(productId: string, value: string) {
    // A physical count can never be negative — reject the keystroke rather
    // than let it through and rely on catching it later. (A negative closing
    // count reached production once: -10, confirmed as-is on 2026-08-18.)
    if (value !== "" && !/^\d+$/.test(value)) return;
    setRows((prev) =>
      prev.map((r) =>
        r.product.id === productId
          ? { ...r, closingCount: value, saved: false }
          : r
      )
    );
  }

  function startNewSession() {
    const newId = crypto.randomUUID();
    setSessionId(newId);
    setSessionLabel("Stock Count");
    setShowSessionPicker(false);
    fetchProducts(newId);
  }

  function switchToSession(s: ExistingSession) {
    setSessionId(s.sessionId);
    setSessionLabel(s.label);
    setShowSessionPicker(false);
    fetchProducts(s.sessionId);
  }

  async function saveAllCounts() {
    if (!currentLocationId) {
      alert("Pick a location before counting.");
      return;
    }
    const toSave = rows.filter(
      (r) => r.closingCount !== "" && !r.saved
    );
    if (toSave.length === 0) return;

    setSaving(true);
    const now = new Date().toISOString();

    // Check for existing counts in this session+location to detect edits
    const { data: existingCounts } = await db
      .from("stock_counts")
      .select("id, product_id, closing_units, update_count")
      .eq("session_id", sessionId)
      .eq("location_id", currentLocationId);

    const existingMap = new Map<string, { id: string; closing_units: number; update_count: number }>();
    ((existingCounts || []) as any[]).forEach((c: any) => {
      existingMap.set(c.product_id, { id: c.id, closing_units: c.closing_units, update_count: c.update_count || 1 });
    });

    const payload = toSave.map((r) => {
      const existing = existingMap.get(r.product.id);
      return {
        session_id: sessionId,
        session_label: sessionLabel,
        count_date: today,
        product_id: r.product.id,
        location_id: currentLocationId,
        opening_units: r.expected,
        closing_units: parseInt(r.closingCount) || 0,
        replenished_units: 0,
        counted_by: userName,
        counted_at: now, // always update timestamp so RA shows accurate time
        updated_at: now,
        update_count: existing ? (existing.update_count || 1) + 1 : 1,
        // Every save is unconfirmed. Applying to product_stock happens only
        // via the explicit Confirm button on a pending session — never here.
        confirmed_by: null,
        confirmed_at: null,
      };
    });

    const { error } = await db
      .from("stock_counts")
      .upsert(payload, { onConflict: "session_id,product_id,location_id" });

    if (error) {
      alert("Error saving: " + error.message);
    } else {
      // Log audit entries for any edits (where count changed)
      const auditEntries: { stock_count_id: string; product_id: string; location_id: string; count_date: string; closing_units_old: number; closing_units_new: number; changed_by: string; changed_at: string }[] = [];
      for (const r of toSave) {
        const existing = existingMap.get(r.product.id);
        if (existing && existing.closing_units !== (parseInt(r.closingCount) || 0)) {
          auditEntries.push({
            stock_count_id: existing.id,
            product_id: r.product.id,
            location_id: currentLocationId,
            count_date: today,
            closing_units_old: existing.closing_units,
            closing_units_new: parseInt(r.closingCount) || 0,
            changed_by: userName,
            changed_at: now,
          });
        }
      }
      if (auditEntries.length > 0) {
        await db.from("stock_count_audit").insert(auditEntries);
      }

      // No product_stock write here — see the canConfirm comment above.
      // The Confirm button on a pending session is the only path to stock.

      setRows((prev) =>
        prev.map((r) =>
          r.closingCount !== "" ? { ...r, saved: true } : r
        )
      );
      setSavedCount(rows.filter((r) => r.closingCount !== "").length);

      // Mark shift stock count as done
      await markStockCountDone();
    }
    setSaving(false);
  }

  // Apply a count somebody else took to this branch's stock levels. Reads the
  // saved rows back from the database rather than trusting what is on screen,
  // so a stray keystroke in an input can't slip into the applied figures.
  async function confirmSession() {
    if (!currentLocationId || !sessionId) return;

    setConfirming(true);
    const now = new Date().toISOString();

    const counted = await fetchAllPaged<{ product_id: string; closing_units: number }>(() =>
      db
        .from("stock_counts")
        .select("product_id, closing_units")
        .eq("session_id", sessionId)
        .eq("location_id", currentLocationId)
    );

    if (counted.length === 0) {
      alert("Nothing to confirm — this count has no saved rows yet.");
      setConfirming(false);
      return;
    }

    const { error } = await db.from("product_stock").upsert(
      counted.map((c) => ({
        product_id: c.product_id,
        location_id: currentLocationId,
        quantity: Number(c.closing_units) || 0,
        last_updated: now,
      })),
      { onConflict: "product_id,location_id" }
    );

    if (error) {
      alert("Error applying count: " + error.message);
      setConfirming(false);
      return;
    }

    // Stamp the session only after the stock write succeeds, so a failure
    // halfway leaves the count pending rather than marked done.
    const { error: stampError } = await db
      .from("stock_counts")
      .update({ confirmed_by: userName, confirmed_at: now })
      .eq("session_id", sessionId)
      .eq("location_id", currentLocationId);

    if (stampError) {
      alert(
        "Stock levels were updated, but marking the count as confirmed failed: " +
          stampError.message
      );
    }

    setConfirming(false);
    fetchProducts(sessionId);
  }

  // Get unique categories from loaded products
  const categories = ["All", ...new Set(rows.map((r) => r.product.category))];

  const filtered = rows.filter((r) => {
    const matchesSearch = r.product.name
      .toLowerCase()
      .includes(search.toLowerCase());
    const matchesCat =
      filterCategory === "All" || r.product.category === filterCategory;
    return matchesSearch && matchesCat;
  });

  const unsavedCount = rows.filter(
    (r) => r.closingCount !== "" && !r.saved
  ).length;

  const activeSession = todaySessions.find((s) => s.sessionId === sessionId) ?? null;
  // Every session is pending until explicitly confirmed. Only the owner on an
  // admin till PIN can trigger the write.
  const canConfirmSession =
    canConfirm && activeSession !== null && activeSession.confirmedAt === null;

  if (loading) {
    return <div className="text-center py-12 text-gray-400">Loading...</div>;
  }

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            Stock Count
            {locations.length > 1 && currentLocationName && (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-full px-2 py-0.5">
                <MapPin className="w-3 h-3" /> {currentLocationName}
              </span>
            )}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {today} · {savedCount}/{rows.length} products counted
            {locations.length > 1 && (
              <span className="ml-1 text-gray-400">· Switch the location in the sidebar to count another shop.</span>
            )}
          </p>
        </div>
        <Button
          onClick={saveAllCounts}
          loading={saving}
          disabled={unsavedCount === 0}
        >
          <Check className="w-4 h-4 mr-2" />
          Save ({unsavedCount})
        </Button>
      </div>

      {canConfirmSession && activeSession && (
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-6">
          <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-amber-900">
              Count waiting to be applied
            </p>
            <p className="text-sm text-amber-800 mt-1">
              {activeSession.countedBy} counted {activeSession.productCount} product
              {activeSession.productCount !== 1 ? "s" : ""} in &ldquo;{activeSession.label}&rdquo;.
              Stock levels still show the old figures until you confirm. Check the
              variance column below first — confirming replaces the recorded stock at{" "}
              {currentLocationName || "this branch"} with the counted figures.
            </p>
            <Button
              onClick={confirmSession}
              loading={confirming}
              className="mt-3"
              size="sm"
            >
              <Check className="w-4 h-4 mr-2" />
              Confirm and apply to stock
            </Button>
          </div>
        </div>
      )}

      {activeSession?.confirmedAt && (
        <div className="flex items-start gap-3 bg-green-50 border border-green-200 rounded-xl px-4 py-3 mb-6">
          <Check className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" />
          <p className="text-sm text-green-800">
            Applied to stock by {activeSession.confirmedBy || "the owner"} on{" "}
            {new Date(activeSession.confirmedAt).toLocaleString("en-ZA", {
              day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
            })}
            .
          </p>
        </div>
      )}

      {!canConfirm && (
        <div className="flex items-start gap-3 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 mb-6">
          <AlertTriangle className="w-5 h-5 text-blue-600 mt-0.5 flex-shrink-0" />
          <p className="text-sm text-blue-800">
            Your count is recorded for the owner to review. It does not change the
            stock levels in the system, so any difference stays visible on the Revenue
            Assurance report.
          </p>
        </div>
      )}

      {/* Session controls */}
      <div className="flex items-center gap-3 mb-6">
        <div className="flex-1">
          <label className="text-xs text-gray-500 block mb-1">Session Label</label>
          <input
            type="text"
            value={sessionLabel}
            onChange={(e) => setSessionLabel(e.target.value)}
            placeholder="e.g. Opening Count, Closing Count"
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
          />
        </div>
        {todaySessions.length > 0 && (
          <div className="flex gap-2 items-end">
            <button
              onClick={() => setShowSessionPicker(!showSessionPicker)}
              className="text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2 hover:bg-green-100 transition-colors whitespace-nowrap"
            >
              {todaySessions.length} session{todaySessions.length !== 1 ? "s" : ""}
            </button>
            <button
              onClick={startNewSession}
              className="text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 hover:bg-blue-100 transition-colors whitespace-nowrap"
            >
              <Plus className="w-3 h-3 inline mr-1" />
              New Session
            </button>
          </div>
        )}
      </div>

      {/* Session picker dropdown */}
      {showSessionPicker && todaySessions.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl mb-6 divide-y divide-gray-100">
          <p className="px-4 py-2 text-xs font-medium text-gray-500">Today&apos;s Count Sessions</p>
          {todaySessions.map((s) => {
            const timeStr = s.countedAt
              ? new Date(s.countedAt).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" })
              : "";
            const isActive = s.sessionId === sessionId;
            return (
              <button
                key={s.sessionId}
                onClick={() => switchToSession(s)}
                className={`w-full text-left px-4 py-3 text-sm hover:bg-gray-50 transition-colors ${isActive ? "bg-green-50" : ""}`}
              >
                <span className="font-medium text-gray-900">{s.label}</span>
                <span className="text-gray-400 ml-2">
                  {s.countDate !== today ? `${s.countDate} · ` : ""}{timeStr} · {s.countedBy} · {s.productCount} products
                </span>
                {!s.confirmedAt && <span className="ml-2"><Badge color="amber">Pending</Badge></span>}
                {isActive && <span className="ml-2"><Badge color="green">Current</Badge></span>}
              </button>
            );
          })}
        </div>
      )}

      {/* Progress bar */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-6">
        <div className="flex justify-between text-sm mb-2">
          <span className="text-gray-600">Count progress</span>
          <span className="font-semibold text-gray-900">
            {rows.filter((r) => r.closingCount !== "").length} / {rows.length}
          </span>
        </div>
        <div className="w-full bg-gray-100 rounded-full h-3">
          <div
            className="bg-green-600 h-3 rounded-full transition-all"
            style={{
              width: `${rows.length > 0 ? (rows.filter((r) => r.closingCount !== "").length / rows.length) * 100 : 0}%`,
            }}
          />
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search products..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 bg-white border border-gray-200 rounded-lg text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
          />
        </div>
        <select
          value={filterCategory}
          onChange={(e) => setFilterCategory(e.target.value)}
          className="bg-white border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
        >
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      {/* Stock count list */}
      {filtered.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <Package className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500">No products match your filter</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
          {filtered.map((row) => {
            const closing = parseInt(row.closingCount);
            const variance =
              row.closingCount !== ""
                ? closing - row.expected
                : null;
            const isLow =
              row.closingCount !== "" &&
              closing <= row.product.reorder_level;

            return (
              <div key={row.product.id} className="flex items-center gap-4 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-gray-900 truncate">
                      {row.product.name}
                    </p>
                    {row.saved && (
                      <Check className="w-4 h-4 text-green-600 flex-shrink-0" />
                    )}
                    {isLow && (
                      <Badge color="red">
                        <AlertTriangle className="w-3 h-3 mr-1" />
                        Low
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-gray-500">
                    {row.product.category}{!isCashierView && ` · Expected: ${row.expected}`} · {formatZAR(row.product.selling_price)}
                  </p>
                </div>

                {/* Count input */}
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    inputMode="numeric"
                    min="0"
                    placeholder="—"
                    value={row.closingCount}
                    onChange={(e) => updateCount(row.product.id, e.target.value)}
                    className={`w-20 text-center py-2 border rounded-lg text-sm font-semibold touch-manipulation ${
                      row.saved
                        ? "border-green-300 bg-green-50"
                        : "border-gray-200 bg-white"
                    } focus:border-green-500 focus:ring-1 focus:ring-green-500`}
                  />

                  {variance !== null && !isCashierView && (
                    <span
                      className={`text-xs font-medium w-12 text-right ${
                        variance === 0
                          ? "text-green-600"
                          : variance > 0
                          ? "text-blue-600"
                          : "text-red-600"
                      }`}
                    >
                      {variance > 0 ? "+" : ""}
                      {variance}
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
