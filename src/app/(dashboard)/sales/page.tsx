"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import { db } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { formatZAR } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Badge } from "@/components/ui/badge";
import { Banknote, CreditCard, Users, Calculator, XCircle, RotateCcw, Undo2, Printer, ChevronDown, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { LocationFilter, LOCATION_FILTER_ALL } from "@/components/locations/location-filter";
import { useOrg } from "@/lib/org-context";
import { paymentBucket, type PaymentBucket } from "@/lib/payment-buckets";
import { CreditNote, generateCreditNoteNumber, type CreditNoteData } from "@/components/pos/credit-note";
import { localToday } from "@/lib/date-utils";
import { usePeriodLock } from "@/lib/use-period-lock";
import { receiptCode, normaliseReceiptCode } from "@/lib/receipt-code";

/**
 * Step a YYYY-MM-DD string by whole days. Parsed as UTC noon so a shift never
 * lands on a different calendar day than intended in a non-UTC timezone.
 */
function shiftDate(date: string, days: number): string {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

interface SaleSummary {
  cash: number;
  card: number;
  credit: number;
  total: number;
  count: number;
}

interface ReconData {
  opening_float: string;
  actual_cash: string;
}

interface SaleRecord {
  id: string;
  product_id: string;
  product_name: string;
  quantity: number;
  unit_price: number;
  total_amount: number;
  tax_amount: number;
  payment_method: string;
  customer_id: string | null;
  created_at: string;
  voided: boolean;
  // Set on a return row (migration 064); links to the original sale.
  return_of_sale_id: string | null;
  credit_note_number: string | null;
  // Groups the lines of one basket (migration 074).
  transaction_id: string | null;
}

/** One basket: the lines that were rung up and paid for together. */
interface SaleGroup {
  key: string;
  /** Short code printed on the customer's receipt. */
  code: string;
  lines: SaleRecord[];
  createdAt: string;
  paymentMethod: string;
  /** Non-voided value of the basket. */
  total: number;
  /** Units still on the sale, ignoring voided lines. */
  itemCount: number;
  allVoided: boolean;
  anyVoided: boolean;
}

export default function SalesPage() {
  const { role, name: userName } = useAuth();
  const { role: orgRole, assignedLocationId, currentLocationId, locations, orgName, tpin, vatPercent, currentLocationName, orgId } = useOrg();
  const [locFilter, setLocFilter] = useState<string>(LOCATION_FILTER_ALL);
  const effectiveLoc = orgRole === "member" ? (assignedLocationId || currentLocationId || LOCATION_FILTER_ALL) : locFilter;
  const isFiltered = effectiveLoc !== LOCATION_FILTER_ALL;
  const filteredLocName = isFiltered ? (locations.find((l) => l.id === effectiveLoc)?.name || "") : "";

  const [summary, setSummary] = useState<SaleSummary>({ cash: 0, card: 0, credit: 0, total: 0, count: 0 });
  const [recon, setRecon] = useState<ReconData>({ opening_float: "0", actual_cash: "" });
  const [reconSaved, setReconSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [transactions, setTransactions] = useState<SaleRecord[]>([]);
  const [filterMethod, setFilterMethod] = useState<"all" | "cash" | "card" | "credit">("all");

  // Which baskets are expanded to show their lines.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // Receipt lookup: a customer brings a receipt back, possibly days later.
  const [codeInput, setCodeInput] = useState("");
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupMiss, setLookupMiss] = useState("");
  const [highlightKey, setHighlightKey] = useState<string | null>(null);

  // Void modal — operates on a whole basket, with the lines individually
  // selectable so part of a sale can be cancelled.
  const [voidTarget, setVoidTarget] = useState<SaleGroup | null>(null);
  const [voidSelection, setVoidSelection] = useState<Record<string, boolean>>({});
  const [voidReason, setVoidReason] = useState("");
  const [voiding, setVoiding] = useState(false);

  // Return modal — quantities per line, all under one credit note.
  const [returnTarget, setReturnTarget] = useState<SaleGroup | null>(null);
  const [returnQtys, setReturnQtys] = useState<Record<string, string>>({});
  const [returnReason, setReturnReason] = useState("");
  const [returning, setReturning] = useState(false);
  // Credit note to print once a return is recorded.
  const [creditNote, setCreditNote] = useState<CreditNoteData | null>(null);
  const creditNoteRef = useRef<HTMLDivElement>(null);

  // Units already returned per original sale, so the modal can cap the input.
  const returnedByOriginal = transactions.reduce((map, t) => {
    if (t.return_of_sale_id && !t.voided) {
      map[t.return_of_sale_id] = (map[t.return_of_sale_id] || 0) + Math.abs(t.quantity);
    }
    return map;
  }, {} as Record<string, number>);

  const today = localToday();
  // Which day's sales are on screen. Returns and voids frequently come in the
  // day after the sale, so the page cannot be today-only.
  const [viewDate, setViewDate] = useState(today);
  const isToday = viewDate === today;
  const { lockedThrough, isLocked } = usePeriodLock();

  // Baskets, newest first. Rows written before migration 074 have no
  // transaction_id, so each falls back to standing alone rather than all
  // NULLs collapsing into one giant "sale".
  const saleGroups: SaleGroup[] = (() => {
    const map = new Map<string, SaleRecord[]>();
    for (const t of transactions) {
      if (t.return_of_sale_id) continue; // credit notes are listed separately
      const key = t.transaction_id ?? `single:${t.id}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(t);
    }
    return [...map.entries()]
      .map(([key, lines]) => {
        const live = lines.filter((l) => !l.voided);
        return {
          key,
          // Matches what was printed: from the transaction where there is one,
          // otherwise from the line, exactly as the till numbered it.
          code: receiptCode(lines[0].transaction_id ?? lines[0].id),
          lines,
          createdAt: lines[0].created_at,
          paymentMethod: lines[0].payment_method,
          total: live.reduce((s, l) => s + (Number(l.total_amount) || 0), 0),
          itemCount: live.reduce((s, l) => s + l.quantity, 0),
          allVoided: live.length === 0,
          anyVoided: lines.some((l) => l.voided),
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  })();

  // Credit notes, grouped so a multi-item return reads as one event.
  const returnGroups = (() => {
    const map = new Map<string, SaleRecord[]>();
    for (const t of transactions) {
      if (!t.return_of_sale_id) continue;
      const key = t.credit_note_number ?? `single:${t.id}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(t);
    }
    return [...map.entries()]
      .map(([key, lines]) => ({
        key,
        lines,
        createdAt: lines[0].created_at,
        creditNoteNumber: lines[0].credit_note_number,
        total: lines.reduce((s, l) => s + (Number(l.total_amount) || 0), 0),
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  })();

  const fetchSummary = useCallback(async () => {
    setLoading(true);

    // Fetch all transactions for today (including voided for display). The
    // return columns (migration 064) may not exist yet if the code deploys
    // before the migration is applied — retry without them rather than break
    // Today's Sales for the whole shop (same fallback shape as 059).
    const baseCols = "id, product_id, quantity, unit_price, total_amount, tax_amount, payment_method, customer_id, created_at, voided, products(name)";
    const returnCols = "return_of_sale_id, credit_note_number, transaction_id";
    const runSalesQuery = (cols: string) => {
      let q = db.from("sales").select(cols).eq("sale_date", viewDate).order("created_at", { ascending: false });
      if (isFiltered) q = q.eq("location_id", effectiveLoc);
      return q;
    };
    let { data: allSales, error: salesErr } = await runSalesQuery(`${baseCols}, ${returnCols}`);
    if (salesErr) {
      ({ data: allSales } = await runSalesQuery(baseCols));
    }

    const salesArr: any[] = allSales || [];

    const txns: SaleRecord[] = salesArr.map((s: any) => ({
      id: s.id,
      product_id: s.product_id,
      product_name: s.products?.name || "Unknown",
      quantity: s.quantity,
      unit_price: s.unit_price,
      total_amount: s.total_amount,
      tax_amount: Number(s.tax_amount) || 0,
      payment_method: s.payment_method,
      customer_id: s.customer_id,
      created_at: s.created_at,
      voided: s.voided || false,
      return_of_sale_id: s.return_of_sale_id ?? null,
      credit_note_number: s.credit_note_number ?? null,
      transaction_id: s.transaction_id ?? null,
    }));
    setTransactions(txns);

    // Summary from non-voided rows. Return rows carry a negative total_amount and
    // the original's payment method, so they net the buckets automatically. The
    // transaction COUNT excludes returns (a credit note is not a new sale).
    const activeSales = salesArr.filter((s: any) => !s.voided);
    let cash = 0, card = 0, credit = 0;
    activeSales.forEach((s: any) => {
      const amt = Number(s.total_amount) || 0;
      const bucket = paymentBucket(s.payment_method);
      if (bucket === "cash") cash += amt;
      else if (bucket === "credit") credit += amt;
      else card += amt;
    });
    const saleCount = activeSales.filter((s: any) => !s.return_of_sale_id).length;
    setSummary({ cash, card, credit, total: cash + card + credit, count: saleCount });

    // Reconciliation always belongs to today — the panel is hidden when an
    // earlier day is on screen, so a back-dated view can never overwrite it.
    const { data: existingRecon } = await db
      .from("daily_reconciliation")
      .select("*")
      .eq("recon_date", today)
      .single();

    if (existingRecon) {
      setRecon({
        opening_float: existingRecon.opening_float?.toString() || "0",
        actual_cash: existingRecon.actual_cash?.toString() || "",
      });
      setReconSaved(true);
    }

    setLoading(false);
  }, [viewDate, effectiveLoc, isFiltered]);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  const openingFloat = parseFloat(recon.opening_float) || 0;
  const expectedCash = openingFloat + summary.cash;
  const actualCash = parseFloat(recon.actual_cash) || 0;
  const variance = recon.actual_cash ? actualCash - expectedCash : null;

  async function saveRecon() {
    if (!orgId) {
      alert("Organization not loaded yet.");
      return;
    }
    setSaving(true);
    const payload = {
      opening_float: openingFloat,
      cash_sales: summary.cash,
      card_sales: summary.card,
      credit_sales: summary.credit,
      expected_cash: expectedCash,
      actual_cash: actualCash,
      variance: actualCash - expectedCash,
    };

    // Check if row exists for this org+date
    const { data: existing } = await db
      .from("daily_reconciliation")
      .select("id")
      .eq("org_id", orgId)
      .eq("recon_date", today)
      .maybeSingle();

    let error;
    if (existing) {
      ({ error } = await db
        .from("daily_reconciliation")
        .update(payload)
        .eq("id", existing.id));
    } else {
      ({ error } = await db
        .from("daily_reconciliation")
        .insert({ ...payload, org_id: orgId, recon_date: today }));
    }

    if (error) alert("Error saving: " + error.message);
    else setReconSaved(true);
    setSaving(false);
  }

  /** Find a receipt by its printed code and jump to the day it was sold. */
  async function handleLookup() {
    const code = normaliseReceiptCode(codeInput);
    if (code.length < 4) {
      setLookupMiss("Enter at least 4 characters of the receipt code.");
      return;
    }
    setLookingUp(true);
    setLookupMiss("");
    try {
      const { data, error } = await db.rpc("find_sale_by_receipt_code", { p_code: code });
      if (error) throw error;
      const hits = (data || []) as { transaction_id: string | null; sale_date: string }[];
      if (hits.length === 0) {
        setLookupMiss(`No receipt found for ${code}.`);
        return;
      }
      const hit = hits[0];
      const key = hit.transaction_id ? hit.transaction_id : null;
      setViewDate(hit.sale_date);
      if (key) {
        setExpanded((m) => ({ ...m, [key]: true }));
        setHighlightKey(key);
      }
      if (hits.length > 1) {
        setLookupMiss(`${hits.length} receipts share that code — showing the most recent.`);
      }
    } catch (err) {
      setLookupMiss("Lookup failed: " + (err instanceof Error ? err.message : "unknown error"));
    } finally {
      setLookingUp(false);
    }
  }

  function openVoid(group: SaleGroup) {
    setVoidTarget(group);
    // Default to the whole sale — cancelling everything is the common case,
    // and unticking is easier than hunting for the lines to tick.
    const sel: Record<string, boolean> = {};
    group.lines.filter((l) => !l.voided).forEach((l) => (sel[l.id] = true));
    setVoidSelection(sel);
    setVoidReason("");
  }

  async function handleVoid() {
    if (!voidTarget) return;

    // The sale's own date, not today's — voiding a back-dated sale must respect
    // the lock covering the day it was made.
    if (isLocked(viewDate)) {
      alert(`This sale is in a locked period (through ${lockedThrough}). Unlock the period in Settings first.`);
      return;
    }

    const ids = voidTarget.lines.filter((l) => !l.voided && voidSelection[l.id]).map((l) => l.id);
    if (ids.length === 0) {
      alert("Select at least one item to void.");
      return;
    }

    setVoiding(true);
    try {
      // One RPC for the whole selection: it restocks the BRANCH and reverses
      // any credit. The old client-side void bumped products.opening_stock,
      // the pre-per-location field, so branch stock was never restored.
      const { error } = await db.rpc("void_sale_lines", {
        p_sale_ids: ids,
        p_reason: voidReason || "Voided at till",
        p_voided_by: userName,
      });
      if (error) throw error;

      setVoidTarget(null);
      setVoidSelection({});
      setVoidReason("");
      fetchSummary();
    } catch (err) {
      alert("Error voiding sale: " + (err instanceof Error ? err.message : "Unknown error"));
    } finally {
      setVoiding(false);
    }
  }

  /** Units of a line still available to return. */
  function remainingOf(line: SaleRecord) {
    return line.quantity - (returnedByOriginal[line.id] || 0);
  }

  function openReturn(group: SaleGroup) {
    setReturnTarget(group);
    // Start at zero so a return is always a deliberate choice per line.
    const qtys: Record<string, string> = {};
    group.lines.filter((l) => !l.voided && remainingOf(l) > 0).forEach((l) => (qtys[l.id] = "0"));
    setReturnQtys(qtys);
    setReturnReason("");
  }

  async function handleReturn() {
    if (!returnTarget) return;

    if (isLocked(viewDate)) {
      alert(`This sale is in a locked period (through ${lockedThrough}). Returns against locked periods are blocked.`);
      return;
    }

    const picked = returnTarget.lines
      .map((l) => ({ line: l, qty: parseInt(returnQtys[l.id] ?? "", 10) || 0 }))
      .filter((p) => p.qty > 0);

    if (picked.length === 0) {
      alert("Enter a quantity on at least one item.");
      return;
    }
    const overshoot = picked.find((p) => p.qty > remainingOf(p.line));
    if (overshoot) {
      alert(`${overshoot.line.product_name}: only ${remainingOf(overshoot.line)} can still be returned.`);
      return;
    }

    setReturning(true);
    try {
      // One note covers the whole return, so every line is recorded against
      // the same credit note number.
      const cnNumber = generateCreditNoteNumber();
      for (const { line, qty } of picked) {
        const { error } = await db.rpc("record_sale_return", {
          p_original_sale_id: line.id,
          p_quantity: qty,
          p_reason: returnReason || null,
          p_credit_note_number: cnNumber,
        });
        if (error) throw error;
      }

      const refundAmount = picked.reduce(
        (s, p) => s + Math.round(p.line.unit_price * p.qty * 100) / 100, 0
      );
      const vatReversed = picked.reduce((s, p) => {
        const unitTax = p.line.quantity > 0 ? p.line.tax_amount / p.line.quantity : 0;
        return s + Math.round(unitTax * p.qty * 100) / 100;
      }, 0);
      const isCredit = paymentBucket(returnTarget.paymentMethod) === "credit";

      setCreditNote({
        orgName: orgName || "Shop",
        locationName: currentLocationName || "",
        tpin,
        vatPercent,
        creditNoteNumber: cnNumber,
        originalReference: new Date(returnTarget.createdAt).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" }),
        issuedAt: new Date(),
        items: picked.map((p) => ({
          productName: p.line.product_name,
          quantity: p.qty,
          unitPrice: p.line.unit_price,
          lineTotal: Math.round(p.line.unit_price * p.qty * 100) / 100,
        })),
        refundAmount,
        vatReversed,
        reason: returnReason || null,
        refundMode: isCredit ? "account" : "cash",
      });

      setReturnTarget(null);
      setReturnQtys({});
      setReturnReason("");
      fetchSummary();
    } catch (err) {
      alert("Error recording return: " + (err instanceof Error ? err.message : "Unknown error"));
    } finally {
      setReturning(false);
    }
  }

  function printCreditNote() {
    const el = creditNoteRef.current;
    if (!el) return;
    const w = window.open("", "_blank", "width=350,height=600");
    if (!w) return;
    w.document.write(
      "<!DOCTYPE html><html><head><title>Credit Note</title>" +
      "<style>body{margin:0;padding:0}@page{size:80mm auto;margin:0}</style>" +
      "</head><body>" + el.innerHTML + "</body></html>"
    );
    w.document.close();
    setTimeout(() => w.print(), 200);
  }

  // Counted in baskets, matching the list below. Counting rows here would say
  // "9 transactions" for what the shop experienced as three customers.
  const liveSaleCount = saleGroups.filter((g) => !g.allVoided).length;
  const voidedCount = saleGroups.filter((g) => g.allVoided).length;

  if (loading) {
    return <div className="text-center py-12 text-gray-400">Loading...</div>;
  }

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <h1 className="text-2xl font-bold text-gray-900">
          {isToday ? "Today's Sales" : "Sales"}
          {isFiltered && filteredLocName && (
            <span className="ml-2 text-base font-normal text-gray-500">· {filteredLocName}</span>
          )}
        </h1>
        <LocationFilter value={locFilter} onChange={setLocFilter} />
      </div>

      {/* Day being viewed. Returns and voids often happen the day after the
          sale, so this has to reach back beyond today. */}
      <div className="flex items-center gap-3 mb-6 flex-wrap">
        <button
          onClick={() => setViewDate(shiftDate(viewDate, -1))}
          className="p-2 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-lg"
          aria-label="Previous day"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <input
          type="date"
          value={viewDate}
          max={today}
          onChange={(e) => { if (e.target.value) setViewDate(e.target.value); }}
          aria-label="Date to show sales for"
          className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
        />
        <button
          onClick={() => setViewDate(shiftDate(viewDate, 1))}
          disabled={isToday}
          className="p-2 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-lg disabled:opacity-30 disabled:hover:bg-transparent"
          aria-label="Next day"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
        {!isToday && (
          <button onClick={() => setViewDate(today)} className="text-sm text-green-600 hover:underline">
            Back to today
          </button>
        )}

        <div className="flex items-center gap-2 ml-auto">
          <input
            type="text"
            value={codeInput}
            onChange={(e) => { setCodeInput(e.target.value); setLookupMiss(""); }}
            onKeyDown={(e) => { if (e.key === "Enter") handleLookup(); }}
            placeholder="Receipt code"
            aria-label="Find a receipt by its code"
            className="w-36 border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-mono uppercase focus:border-green-500 focus:ring-1 focus:ring-green-500"
          />
          <Button variant="secondary" onClick={handleLookup} loading={lookingUp}>
            <Search className="w-4 h-4 mr-1.5" />
            Find
          </Button>
        </div>
      </div>

      {lookupMiss && (
        <div className="mb-4 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2">
          {lookupMiss}
        </div>
      )}

      {/* Sales breakdown — clickable to filter */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <SummaryCard icon={Banknote} label="Cash Sales" amount={summary.cash} color="bg-green-600" active={filterMethod === "cash"} onClick={() => setFilterMethod(filterMethod === "cash" ? "all" : "cash")} />
        <SummaryCard icon={CreditCard} label="Card Sales" amount={summary.card} color="bg-blue-600" active={filterMethod === "card"} onClick={() => setFilterMethod(filterMethod === "card" ? "all" : "card")} />
        <SummaryCard icon={Users} label="Credit Sales" amount={summary.credit} color="bg-amber-500" active={filterMethod === "credit"} onClick={() => setFilterMethod(filterMethod === "credit" ? "all" : "credit")} />
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
        <div className="flex justify-between items-center">
          <div>
            <p className="text-sm text-gray-500">{isToday ? "Total Sales Today" : "Total Sales"}</p>
            <p className="text-3xl font-bold text-gray-900">{formatZAR(summary.total)}</p>
          </div>
          <div className="text-right">
            <p className="text-sm text-gray-500">Transactions</p>
            <p className="text-3xl font-bold text-gray-900">{liveSaleCount}</p>
            {voidedCount > 0 && (
              <p className="text-xs text-red-500">{voidedCount} voided</p>
            )}
          </div>
        </div>
      </div>

      {/* Transactions list */}
      <div className="bg-white rounded-xl border border-gray-200 mb-6">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="font-semibold text-gray-900">
            {filterMethod === "all" ? "All Transactions" : `${filterMethod.charAt(0).toUpperCase() + filterMethod.slice(1)} Transactions`}
          </h2>
          {filterMethod !== "all" && (
            <button onClick={() => setFilterMethod("all")} className="text-xs text-green-600 hover:underline">
              Show all
            </button>
          )}
        </div>
        {saleGroups.length === 0 && returnGroups.length === 0 ? (
          <div className="px-5 py-8 text-center text-gray-400 text-sm">No transactions today.</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {saleGroups
              .filter((g) => filterMethod === "all" || paymentBucket(g.paymentMethod) === filterMethod)
              .map((g) => {
                const bucket: PaymentBucket = paymentBucket(g.paymentMethod);
                const time = new Date(g.createdAt).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" });
                const isOpen = !!expanded[g.key];
                const returnable = g.lines.some((l) => !l.voided && remainingOf(l) > 0);
                const lineWord = g.lines.length === 1 ? "item" : "items";
                return (
                  <div
                    key={g.key}
                    className={
                      highlightKey === g.key
                        ? "bg-green-50 ring-2 ring-green-300"
                        : g.allVoided
                        ? "bg-red-50/50"
                        : ""
                    }
                  >
                    <div className="px-5 py-3 flex items-center gap-3">
                      <button
                        onClick={() => setExpanded((m) => ({ ...m, [g.key]: !isOpen }))}
                        className="flex-1 min-w-0 text-left"
                        aria-expanded={isOpen}
                      >
                        <div className="flex items-center gap-2 flex-wrap">
                          <ChevronDown
                            className={`w-4 h-4 text-gray-400 transition-transform ${isOpen ? "rotate-180" : ""}`}
                          />
                          <span className="text-sm font-mono font-semibold text-gray-900">{g.code}</span>
                          <span className={`text-sm ${g.allVoided ? "line-through text-gray-400" : "text-gray-500"}`}>
                            {time}
                          </span>
                          <Badge color={bucket === "cash" ? "green" : bucket === "card" ? "blue" : "amber"}>
                            {g.paymentMethod || "—"}
                          </Badge>
                          {g.allVoided && <Badge color="red">Voided</Badge>}
                          {!g.allVoided && g.anyVoided && (
                            <span className="text-xs text-red-500">part voided</span>
                          )}
                        </div>
                        <p className="text-xs text-gray-500 ml-6">
                          {g.lines.length} {lineWord} · {g.itemCount} unit{g.itemCount === 1 ? "" : "s"}
                        </p>
                      </button>
                      <span className={`text-base font-bold ${g.allVoided ? "line-through text-gray-400" : "text-gray-900"}`}>
                        {formatZAR(g.total)}
                      </span>
                      {!g.allVoided && role === "admin" && (
                        <div className="flex items-center gap-1">
                          {returnable && (
                            <button
                              onClick={() => openReturn(g)}
                              className="p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors"
                              title="Return items from this sale"
                            >
                              <Undo2 className="w-4 h-4" />
                            </button>
                          )}
                          <button
                            onClick={() => openVoid(g)}
                            className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                            title="Void items from this sale"
                          >
                            <XCircle className="w-4 h-4" />
                          </button>
                        </div>
                      )}
                    </div>

                    {isOpen && (
                      <div className="px-5 pb-3 pl-11 space-y-1">
                        {g.lines.map((l) => {
                          const returned = returnedByOriginal[l.id] || 0;
                          return (
                            <div key={l.id} className="flex items-center justify-between text-sm">
                              <div className="min-w-0 flex items-center gap-2">
                                <span className={l.voided ? "line-through text-gray-400" : "text-gray-700"}>
                                  {l.quantity} × {l.product_name}
                                </span>
                                {l.voided && <Badge color="red">Voided</Badge>}
                                {!l.voided && returned > 0 && (
                                  <span className="text-xs text-amber-600">{returned} returned</span>
                                )}
                              </div>
                              <span className={l.voided ? "line-through text-gray-400" : "text-gray-700"}>
                                {formatZAR(l.total_amount)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}

            {returnGroups.map((r) => {
              const time = new Date(r.createdAt).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" });
              return (
                <div key={r.key} className="px-5 py-3 bg-amber-50/40">
                  <div className="flex items-center justify-between">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge color="amber">Credit Note</Badge>
                        <span className="text-sm font-medium text-gray-900">{time}</span>
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {r.lines.map((l) => `${Math.abs(l.quantity)} × ${l.product_name}`).join(", ")}
                        {r.creditNoteNumber ? ` · ${r.creditNoteNumber}` : ""}
                      </p>
                    </div>
                    <span className="text-sm font-semibold text-amber-700">{formatZAR(r.total)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Till reconciliation — today only. It records the state of the drawer
          right now, so showing it against an earlier day would invite saving
          today's count against the wrong date. */}
      {isToday && (
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <div className="flex items-center gap-2 mb-4">
          <Calculator className="w-5 h-5 text-green-600" />
          <h2 className="text-lg font-semibold text-gray-900">Till Reconciliation</h2>
        </div>

        <div className="space-y-4">
          <Input
            label="Opening Float (R)"
            type="number"
            step="0.01"
            value={recon.opening_float}
            onChange={(e) => setRecon({ ...recon, opening_float: e.target.value })}
          />

          <div className="bg-gray-50 rounded-lg px-4 py-3">
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Opening float</span>
              <span>{formatZAR(openingFloat)}</span>
            </div>
            <div className="flex justify-between text-sm mt-1">
              <span className="text-gray-600">+ Cash sales</span>
              <span>{formatZAR(summary.cash)}</span>
            </div>
            <div className="flex justify-between text-sm font-semibold mt-2 pt-2 border-t border-gray-200">
              <span>Expected cash in till</span>
              <span>{formatZAR(expectedCash)}</span>
            </div>
          </div>

          <Input
            label="Actual Cash Counted (R)"
            type="number"
            step="0.01"
            placeholder="Count the cash and enter the total"
            value={recon.actual_cash}
            onChange={(e) => {
              setRecon({ ...recon, actual_cash: e.target.value });
              setReconSaved(false);
            }}
          />

          {variance !== null && (
            <div
              className={`rounded-lg px-4 py-3 text-sm font-medium ${
                variance === 0
                  ? "bg-green-50 text-green-700"
                  : variance > 0
                  ? "bg-blue-50 text-blue-700"
                  : "bg-red-50 text-red-700"
              }`}
            >
              Variance: {formatZAR(variance)}
              {variance === 0 && " — Till balances perfectly"}
              {variance > 0 && " — Till is over (surplus)"}
              {variance < 0 && " — Till is short"}
            </div>
          )}

          <Button onClick={saveRecon} loading={saving} disabled={reconSaved} className="w-full">
            {reconSaved ? "Saved" : "Save Reconciliation"}
          </Button>
        </div>
      </div>
      )}

      {/* Void modal — pick which items of the sale to cancel */}
      <Modal open={!!voidTarget} onClose={() => { setVoidTarget(null); setVoidReason(""); }} title="Void Items">
        {voidTarget && (() => {
          const active = voidTarget.lines.filter((l) => !l.voided);
          const chosen = active.filter((l) => voidSelection[l.id]);
          const chosenTotal = chosen.reduce((s, l) => s + (Number(l.total_amount) || 0), 0);
          const isCredit = paymentBucket(voidTarget.paymentMethod) === "credit";
          return (
            <div className="space-y-4">
              <div className="bg-red-50 border border-red-100 rounded-lg px-4 py-3">
                <p className="text-sm text-red-800">
                  Voiding puts the items back on the shelf and removes them from today&apos;s takings
                  {isCredit ? ", and reduces the customer's balance" : ""}.
                </p>
              </div>

              <div className="border border-gray-200 rounded-lg divide-y divide-gray-100">
                {active.map((l) => (
                  <label key={l.id} className="flex items-center gap-3 px-3 py-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={!!voidSelection[l.id]}
                      onChange={(e) => setVoidSelection((m) => ({ ...m, [l.id]: e.target.checked }))}
                      className="w-4 h-4 text-red-600 border-gray-300 rounded focus:ring-red-500"
                    />
                    <span className="flex-1 text-sm text-gray-800">
                      {l.quantity} × {l.product_name}
                    </span>
                    <span className="text-sm text-gray-600">{formatZAR(l.total_amount)}</span>
                  </label>
                ))}
              </div>

              <div className="flex items-center justify-between bg-gray-50 rounded-lg px-4 py-3 text-sm">
                <span className="text-gray-600">
                  Voiding {chosen.length} of {active.length}
                </span>
                <span className="font-bold text-gray-900">{formatZAR(chosenTotal)}</span>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Reason (optional)</label>
                <input
                  type="text"
                  value={voidReason}
                  onChange={(e) => setVoidReason(e.target.value)}
                  placeholder="e.g. Customer changed mind, wrong item"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
                />
              </div>

              <div className="flex gap-3">
                <Button variant="secondary" onClick={() => { setVoidTarget(null); setVoidReason(""); }} className="flex-1">
                  Cancel
                </Button>
                <Button variant="danger" onClick={handleVoid} loading={voiding} disabled={chosen.length === 0} className="flex-1">
                  <RotateCcw className="w-4 h-4 mr-2" />
                  {chosen.length === active.length ? "Void Sale" : `Void ${chosen.length} Item${chosen.length === 1 ? "" : "s"}`}
                </Button>
              </div>
            </div>
          );
        })()}
      </Modal>

      {/* Return / credit note modal */}
      <Modal open={!!returnTarget} onClose={() => { setReturnTarget(null); setReturnReason(""); }} title="Return / Credit Note">
        {returnTarget && (() => {
          const lines = returnTarget.lines.filter((l) => !l.voided && remainingOf(l) > 0);
          const isCredit = paymentBucket(returnTarget.paymentMethod) === "credit";
          const refund = lines.reduce((s, l) => {
            const q = Math.min(Math.max(parseInt(returnQtys[l.id] ?? "", 10) || 0, 0), remainingOf(l));
            return s + Math.round(l.unit_price * q * 100) / 100;
          }, 0);
          const anyPicked = lines.some((l) => (parseInt(returnQtys[l.id] ?? "", 10) || 0) > 0);
          return (
            <div className="space-y-4">
              <div className="bg-amber-50 border border-amber-100 rounded-lg px-4 py-3">
                <p className="text-sm text-amber-900">
                  Sale of <strong>{formatZAR(returnTarget.total)}</strong> at{" "}
                  {new Date(returnTarget.createdAt).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" })}.
                  Set how many of each item are coming back.
                </p>
                <p className="text-xs text-amber-700 mt-1">
                  Goes back to stock under one credit note.{" "}
                  {isCredit ? "The customer's account balance will be reduced." : "Refund the customer in cash from the till."}
                </p>
              </div>

              <div className="border border-gray-200 rounded-lg divide-y divide-gray-100">
                {lines.map((l) => {
                  const max = remainingOf(l);
                  return (
                    <div key={l.id} className="flex items-center gap-3 px-3 py-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-gray-800 truncate">{l.product_name}</p>
                        <p className="text-xs text-gray-500">
                          sold {l.quantity} · {max} returnable · {formatZAR(l.unit_price)} each
                        </p>
                      </div>
                      <input
                        type="number"
                        min={0}
                        max={max}
                        inputMode="numeric"
                        value={returnQtys[l.id] ?? "0"}
                        onChange={(e) => setReturnQtys((m) => ({ ...m, [l.id]: e.target.value }))}
                        onFocus={(e) => e.target.select()}
                        aria-label={`Quantity of ${l.product_name} to return`}
                        className="w-16 h-9 text-center text-sm border border-gray-200 rounded-lg focus:border-green-500 focus:ring-1 focus:ring-green-500"
                      />
                    </div>
                  );
                })}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Reason (optional)</label>
                <input
                  type="text"
                  value={returnReason}
                  onChange={(e) => setReturnReason(e.target.value)}
                  placeholder="e.g. Faulty, wrong size"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
                />
              </div>

              <div className="flex items-center justify-between bg-gray-50 rounded-lg px-4 py-3 text-sm">
                <span className="text-gray-600">{isCredit ? "Credit to account" : "Cash refund"}</span>
                <span className="font-bold text-gray-900">{formatZAR(refund)}</span>
              </div>

              <div className="flex gap-3">
                <Button variant="secondary" onClick={() => { setReturnTarget(null); setReturnReason(""); }} className="flex-1">
                  Cancel
                </Button>
                <Button onClick={handleReturn} loading={returning} disabled={!anyPicked} className="flex-1">
                  <Undo2 className="w-4 h-4 mr-2" />
                  Record Return
                </Button>
              </div>
            </div>
          );
        })()}
      </Modal>

      {/* Credit note result — offer to print */}
      <Modal open={!!creditNote} onClose={() => setCreditNote(null)} title="Credit Note">
        {creditNote && (
          <div className="space-y-4">
            <div className="bg-green-50 border border-green-100 rounded-lg px-4 py-3 text-sm text-green-800">
              Return recorded ({creditNote.creditNoteNumber}).{" "}
              {creditNote.refundMode === "cash"
                ? `Refund ${formatZAR(creditNote.refundAmount)} to the customer in cash.`
                : `The customer's balance was reduced by ${formatZAR(creditNote.refundAmount)}.`}
            </div>
            <div className="flex gap-3">
              <Button variant="secondary" onClick={() => setCreditNote(null)} className="flex-1">
                Done
              </Button>
              <Button onClick={printCreditNote} className="flex-1">
                <Printer className="w-4 h-4 mr-2" />
                Print Credit Note
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Off-screen credit note for printing */}
      <div style={{ position: "absolute", left: "-9999px", top: 0 }} aria-hidden>
        {creditNote && <CreditNote ref={creditNoteRef} data={creditNote} />}
      </div>
    </div>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  amount,
  color,
  active,
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  amount: number;
  color: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`bg-white rounded-xl border-2 p-4 text-left transition-all touch-manipulation ${
        active ? "border-green-500 ring-2 ring-green-200" : "border-gray-200 hover:border-gray-300"
      }`}
    >
      <div className="flex items-center gap-3">
        <div className={`p-2 rounded-lg ${color}`}>
          <Icon className="w-5 h-5 text-white" />
        </div>
        <div>
          <p className="text-xs text-gray-500">{label}</p>
          <p className="text-lg font-bold text-gray-900">{formatZAR(amount)}</p>
        </div>
      </div>
    </button>
  );
}
