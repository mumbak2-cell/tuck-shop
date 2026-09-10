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

type FlagKind =
  | "near_empty"
  | "value"
  | "unit_ceiling"
  | "session_spread"
  | "pattern"
  | null;

interface StockRow {
  product: Product;
  expected: number; // product_stock.quantity at currentLocationId, at page load
  expectedUnits: number | null; // frozen snapshot from stock_counts, once saved
  flagKind: FlagKind;
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

const FLAG_SHORT: Record<Exclude<FlagKind, null>, string> = {
  near_empty: "near-empty",
  value: "R value",
  unit_ceiling: "big swing",
  session_spread: "spread",
  pattern: "repeat",
};
const FLAG_LABEL: Record<Exclude<FlagKind, null>, string> = {
  near_empty: "Counted well above stock the system thinks is nearly gone",
  value: "Variance worth R100+ at selling price",
  unit_ceiling: "Variance of 15+ units",
  session_spread: "Part of a session with many same-direction variances",
  pattern: "Same-direction variance 3 counts running",
};

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
  const [showCountedOnly, setShowCountedOnly] = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  const [sessionId, setSessionId] = useState<string>("");
  const [sessionLabel, setSessionLabel] = useState("Stock Count");
  const [todaySessions, setTodaySessions] = useState<ExistingSession[]>([]);
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  // Client-only review beat: gates the Confirm button in the UI, nothing more.
  const [reviewAck, setReviewAck] = useState(false);
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({});

  const today = localToday();

  const fetchProducts = useCallback(async (forSessionId?: string) => {
    if (!currentLocationId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    // Loading a session (mount, switch, new, post-confirm) resets the client-only
    // review beat and any unsaved per-line note drafts.
    setReviewAck(false);
    setNoteDraft({});

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

    // Load counts for this session (filtered to current location). The extended
    // select pulls the variance-flag snapshot columns (migration 121); if that
    // migration isn't live yet PostgREST fails the whole request (42703 /
    // PGRST204, data: null) rather than returning partial rows, which would
    // blank every saved line in an open session. Retry once with the base
    // columns on error — badges and the expectedUnits snapshot then degrade to
    // null, which the rest of this code already handles.
    const countsRes = await db
      .from("stock_counts")
      .select("product_id, closing_units, expected_units, flag_kind")
      .eq("session_id", activeSessionId)
      .eq("location_id", currentLocationId);
    let existingCounts = countsRes.data;
    if (countsRes.error) {
      const baseRes = await db
        .from("stock_counts")
        .select("product_id, closing_units")
        .eq("session_id", activeSessionId)
        .eq("location_id", currentLocationId);
      existingCounts = baseRes.data;
    }

    const countMap = new Map<
      string,
      { closing_units: number; expected_units: number | null; flag_kind: string | null }
    >();
    ((existingCounts || []) as any[]).forEach((c: any) => {
      countMap.set(c.product_id, c);
    });

    const stockRowsForUi: StockRow[] = ((products || []) as any[]).map((p: any) => ({
      product: p,
      expected: expectedMap.get(p.id) ?? 0,
      expectedUnits: countMap.get(p.id)?.expected_units ?? null,
      flagKind: (countMap.get(p.id)?.flag_kind ?? null) as FlagKind,
      closingCount: countMap.has(p.id) ? countMap.get(p.id)!.closing_units.toString() : "",
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

  async function applySessionSpread(sid: string, locationId: string) {
    const { data } = await db
      .from("stock_counts")
      .select("closing_units, expected_units, flag_kind, products(selling_price, is_prepared)")
      .eq("session_id", sid)
      .eq("location_id", locationId)
      .not("closing_units", "is", null);
    const lines: {
      closing_units: number;
      expected_units: number | null;
      products?: { selling_price: number | null; is_prepared: boolean | null } | null;
    }[] = data || [];
    let sameDir = 0;
    let posExposure = 0;
    for (const l of lines) {
      if (l.expected_units == null || l.products?.is_prepared) continue;
      const v = l.closing_units - l.expected_units;
      if (v > 0) {
        sameDir += 1;
        posExposure += v * (Number(l.products?.selling_price) || 0);
      }
    }
    const spread = sameDir >= 8 || posExposure >= 150;
    if (!spread) return;
    await db
      .from("stock_counts")
      .update({ flag_kind: "session_spread" })
      .eq("session_id", sid)
      .eq("location_id", locationId)
      .is("flag_kind", null)
      .not("closing_units", "is", null);
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

      // session_spread: a session with many same-direction variances, or a large
      // summed positive exposure, is itself the anomaly. Needs session-level
      // aggregates a per-row trigger can't see, so it's a second pass here.
      await applySessionSpread(sessionId, currentLocationId);

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

    const noteEntries = Object.entries(noteDraft).filter(([, v]) => v.trim() !== "");
    if (noteEntries.length > 0) {
      await Promise.all(
        noteEntries.map(([productId, note]) =>
          db
            .from("stock_counts")
            .update({ review_note: note.trim() })
            .eq("session_id", sessionId)
            .eq("location_id", currentLocationId)
            .eq("product_id", productId),
        ),
      );
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
    const matchesCounted = !showCountedOnly || r.closingCount !== "";
    return matchesSearch && matchesCat && matchesCounted;
  });

  const unsavedCount = rows.filter(
    (r) => r.closingCount !== "" && !r.saved
  ).length;

  const flaggedRows = rows.filter((r) => r.flagKind !== null);
  const flaggedCount = flaggedRows.length;
  const overCount = rows.filter(
    (r) => r.closingCount !== "" && r.expectedUnits !== null && parseInt(r.closingCount) > r.expectedUnits,
  ).length;
  const underCount = rows.filter(
    (r) => r.closingCount !== "" && r.expectedUnits !== null && parseInt(r.closingCount) < r.expectedUnits,
  ).length;

  // r.expected is product_stock.quantity at page load (built from expectedMap in
  // fetchProducts), so it stands in for expectedMap.get(id) ?? 0 here.
  const uncountedWithStock = rows.filter(
    (r) => r.closingCount === "" && r.expected > 0,
  );
  const stockMovedSince = rows.some(
    (r) =>
      r.closingCount !== "" &&
      r.expectedUnits !== null &&
      r.expected !== r.expectedUnits,
  );

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
          disabled={unsavedCount === 0 || activeSession?.confirmedAt != null}
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
              {flaggedCount > 0 && (
                <> <strong>{flaggedCount} flagged</strong> — {overCount} over expected, {underCount} under.</>
              )}
              {" "}Stock levels still show the old figures until you confirm.
            </p>
            {(flaggedCount > 0 || uncountedWithStock.length > 0) && (
              <label className="flex items-start gap-2 mt-3 text-sm text-amber-900">
                <input
                  type="checkbox"
                  checked={reviewAck}
                  onChange={(e) => setReviewAck(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  I&apos;ve reviewed the {flaggedCount} flagged line{flaggedCount !== 1 ? "s" : ""}
                  {uncountedWithStock.length > 0 && ` and ${uncountedWithStock.length} uncounted item${uncountedWithStock.length !== 1 ? "s" : ""}`}.
                </span>
              </label>
            )}
            <Button
              onClick={confirmSession}
              loading={confirming}
              className="mt-3"
              size="sm"
              disabled={
                (flaggedCount > 0 || uncountedWithStock.length > 0) && !reviewAck
              }
            >
              <Check className="w-4 h-4 mr-2" />
              Confirm and apply to stock
            </Button>
          </div>
        </div>
      )}

      {canConfirmSession && !isCashierView && uncountedWithStock.length > 0 && (
        <details className="bg-white border border-amber-200 rounded-xl mb-6 px-4 py-3">
          <summary className="text-sm font-medium text-amber-900 cursor-pointer">
            {uncountedWithStock.length} product{uncountedWithStock.length !== 1 ? "s" : ""} with stock on hand were not counted
          </summary>
          <ul className="mt-2 text-sm text-gray-600 space-y-1">
            {uncountedWithStock.map((r) => (
              <li key={r.product.id} className="flex justify-between">
                <span className="truncate">{r.product.name}</span>
                <span className="tabular-nums text-gray-400">system: {r.expected}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {canConfirmSession && !isCashierView && stockMovedSince && (
        <p className="text-xs text-amber-700 mb-4">
          Stock has moved at this branch since this count was taken — confirming will overwrite those changes with the counted figures.
        </p>
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
        <button
          onClick={() => setShowCountedOnly(!showCountedOnly)}
          className={`px-3 py-2.5 rounded-lg text-sm font-medium border transition-colors whitespace-nowrap ${
            showCountedOnly
              ? "bg-green-50 border-green-300 text-green-700"
              : "bg-white border-gray-200 text-gray-600 hover:bg-gray-50"
          }`}
        >
          Counted only
        </button>
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
                    {row.product.category}{!isCashierView && ` · Expected: ${row.expectedUnits ?? row.expected}`} · {formatZAR(row.product.selling_price)}
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

                  {row.flagKind && !isCashierView && (
                    <span
                      className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                        row.flagKind === "near_empty"
                          ? "bg-red-100 text-red-700"
                          : row.flagKind === "value" || row.flagKind === "unit_ceiling"
                          ? "bg-amber-100 text-amber-700"
                          : "bg-gray-100 text-gray-600"
                      }`}
                      title={FLAG_LABEL[row.flagKind]}
                    >
                      {FLAG_SHORT[row.flagKind]}
                    </span>
                  )}

                  {row.flagKind && !isCashierView && (
                    <input
                      type="text"
                      placeholder="note (optional)"
                      value={noteDraft[row.product.id] ?? ""}
                      onChange={(e) =>
                        setNoteDraft((d) => ({ ...d, [row.product.id]: e.target.value }))
                      }
                      className="w-40 text-xs px-2 py-1 border border-gray-200 rounded"
                    />
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
