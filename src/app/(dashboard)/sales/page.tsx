"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import { db } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { formatZAR } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Badge } from "@/components/ui/badge";
import { Banknote, CreditCard, Users, Calculator, XCircle, RotateCcw, Undo2, Printer } from "lucide-react";
import { LocationFilter, LOCATION_FILTER_ALL } from "@/components/locations/location-filter";
import { useOrg } from "@/lib/org-context";
import { paymentBucket, type PaymentBucket } from "@/lib/payment-buckets";
import { CreditNote, generateCreditNoteNumber, type CreditNoteData } from "@/components/pos/credit-note";
import { localToday } from "@/lib/date-utils";
import { usePeriodLock } from "@/lib/use-period-lock";

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

  // Void modal state
  const [voidTarget, setVoidTarget] = useState<SaleRecord | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [voiding, setVoiding] = useState(false);

  // Return modal state
  const [returnTarget, setReturnTarget] = useState<SaleRecord | null>(null);
  const [returnQty, setReturnQty] = useState("1");
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
  const { lockedThrough, isLocked } = usePeriodLock();

  const fetchSummary = useCallback(async () => {
    setLoading(true);

    // Fetch all transactions for today (including voided for display). The
    // return columns (migration 064) may not exist yet if the code deploys
    // before the migration is applied — retry without them rather than break
    // Today's Sales for the whole shop (same fallback shape as 059).
    const baseCols = "id, product_id, quantity, unit_price, total_amount, tax_amount, payment_method, customer_id, created_at, voided, products(name)";
    const returnCols = "return_of_sale_id, credit_note_number";
    const runSalesQuery = (cols: string) => {
      let q = db.from("sales").select(cols).eq("sale_date", today).order("created_at", { ascending: false });
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

    // Check if recon already exists for today
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
  }, [today, effectiveLoc, isFiltered]);

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
      org_id: orgId,
      recon_date: today,
      opening_float: openingFloat,
      cash_sales: summary.cash,
      card_sales: summary.card,
      credit_sales: summary.credit,
      expected_cash: expectedCash,
      actual_cash: actualCash,
      variance: actualCash - expectedCash,
    };

    const { error } = await db
      .from("daily_reconciliation")
      .upsert(payload, { onConflict: "org_id,recon_date" });

    if (error) alert("Error saving: " + error.message);
    else setReconSaved(true);
    setSaving(false);
  }

  async function handleVoid() {
    if (!voidTarget) return;

    if (isLocked(today)) {
      alert(`This sale is in a locked period (through ${lockedThrough}). Unlock the period in Settings first.`);
      return;
    }

    setVoiding(true);

    try {
      // 1. Mark the sale as voided
      const { error: voidErr } = await db
        .from("sales")
        .update({
          voided: true,
          voided_at: new Date().toISOString(),
          voided_by: userName,
          void_reason: voidReason || "Customer return",
        })
        .eq("id", voidTarget.id);

      if (voidErr) throw voidErr;

      // 2. Return stock to the product
      const { data: prod } = await db
        .from("products")
        .select("opening_stock")
        .eq("id", voidTarget.product_id)
        .single();

      if (prod) {
        await db
          .from("products")
          .update({ opening_stock: (prod.opening_stock || 0) + voidTarget.quantity })
          .eq("id", voidTarget.product_id);
      }

      // 3. If it was a credit sale, reduce customer balance (atomic — H1 fix)
      if (voidTarget.payment_method === "credit" && voidTarget.customer_id) {
        await db.rpc("adjust_customer_balance", {
          p_customer_id: voidTarget.customer_id,
          p_delta: -voidTarget.total_amount,
        });
      }

      setVoidTarget(null);
      setVoidReason("");
      fetchSummary();
    } catch (err) {
      alert("Error voiding sale: " + (err instanceof Error ? err.message : "Unknown error"));
    } finally {
      setVoiding(false);
    }
  }

  async function handleReturn() {
    if (!returnTarget) return;

    if (isLocked(today)) {
      alert(`This sale is in a locked period (through ${lockedThrough}). Returns against locked periods are blocked.`);
      return;
    }

    const remaining = returnTarget.quantity - (returnedByOriginal[returnTarget.id] || 0);
    const qty = parseInt(returnQty, 10);
    if (!qty || qty < 1 || qty > remaining) {
      alert(`Enter a quantity between 1 and ${remaining}.`);
      return;
    }
    setReturning(true);
    try {
      const cnNumber = generateCreditNoteNumber();
      const { error } = await db.rpc("record_sale_return", {
        p_original_sale_id: returnTarget.id,
        p_quantity: qty,
        p_reason: returnReason || null,
        p_credit_note_number: cnNumber,
      });
      if (error) throw error;

      // Credit note from the original line's snapshot (per-unit VAT reversed).
      const unitTax = returnTarget.quantity > 0 ? returnTarget.tax_amount / returnTarget.quantity : 0;
      const isCredit = paymentBucket(returnTarget.payment_method) === "credit";
      setCreditNote({
        orgName: orgName || "Shop",
        locationName: currentLocationName || "",
        tpin,
        vatPercent,
        creditNoteNumber: cnNumber,
        originalReference: new Date(returnTarget.created_at).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" }),
        issuedAt: new Date(),
        productName: returnTarget.product_name,
        quantity: qty,
        unitPrice: returnTarget.unit_price,
        refundAmount: Math.round(returnTarget.unit_price * qty * 100) / 100,
        vatReversed: Math.round(unitTax * qty * 100) / 100,
        reason: returnReason || null,
        refundMode: isCredit ? "account" : "cash",
      });

      setReturnTarget(null);
      setReturnQty("1");
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

  const voidedCount = transactions.filter((t) => t.voided).length;

  if (loading) {
    return <div className="text-center py-12 text-gray-400">Loading...</div>;
  }

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <h1 className="text-2xl font-bold text-gray-900">
          Today&apos;s Sales
          {isFiltered && filteredLocName && (
            <span className="ml-2 text-base font-normal text-gray-500">· {filteredLocName}</span>
          )}
        </h1>
        <LocationFilter value={locFilter} onChange={setLocFilter} />
      </div>

      {/* Sales breakdown — clickable to filter */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <SummaryCard icon={Banknote} label="Cash Sales" amount={summary.cash} color="bg-green-600" active={filterMethod === "cash"} onClick={() => setFilterMethod(filterMethod === "cash" ? "all" : "cash")} />
        <SummaryCard icon={CreditCard} label="Card Sales" amount={summary.card} color="bg-blue-600" active={filterMethod === "card"} onClick={() => setFilterMethod(filterMethod === "card" ? "all" : "card")} />
        <SummaryCard icon={Users} label="Credit Sales" amount={summary.credit} color="bg-amber-500" active={filterMethod === "credit"} onClick={() => setFilterMethod(filterMethod === "credit" ? "all" : "credit")} />
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
        <div className="flex justify-between items-center">
          <div>
            <p className="text-sm text-gray-500">Total Sales Today</p>
            <p className="text-3xl font-bold text-gray-900">{formatZAR(summary.total)}</p>
          </div>
          <div className="text-right">
            <p className="text-sm text-gray-500">Transactions</p>
            <p className="text-3xl font-bold text-gray-900">{summary.count}</p>
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
        {transactions.length === 0 ? (
          <div className="px-5 py-8 text-center text-gray-400 text-sm">No transactions today.</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {transactions.filter((txn) => filterMethod === "all" || paymentBucket(txn.payment_method) === filterMethod).map((txn) => {
              const bucket: PaymentBucket = paymentBucket(txn.payment_method);
              const isReturn = !!txn.return_of_sale_id;
              const returnedQty = returnedByOriginal[txn.id] || 0;
              const remaining = txn.quantity - returnedQty;
              const time = new Date(txn.created_at).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" });
              return (
              <div
                key={txn.id}
                className={`px-5 py-3 flex items-center justify-between ${txn.voided ? "bg-red-50/50 opacity-60" : isReturn ? "bg-amber-50/40" : ""}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-sm font-medium ${txn.voided ? "line-through text-gray-400" : "text-gray-900"}`}>
                      {txn.product_name}
                    </span>
                    {isReturn ? (
                      <Badge color="amber">Credit Note</Badge>
                    ) : (
                      <Badge color={bucket === "cash" ? "green" : bucket === "card" ? "blue" : "amber"}>
                        {txn.payment_method || "—"}
                      </Badge>
                    )}
                    {txn.voided && <Badge color="red">Voided</Badge>}
                    {!isReturn && !txn.voided && returnedQty > 0 && (
                      <span className="text-xs text-amber-600">{returnedQty} returned</span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500">
                    {isReturn
                      ? `Returned ${Math.abs(txn.quantity)} × ${formatZAR(txn.unit_price)}${txn.credit_note_number ? ` · ${txn.credit_note_number}` : ""} · ${time}`
                      : `Qty ${txn.quantity} × ${formatZAR(txn.unit_price)} · ${time}`}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-sm font-semibold ${txn.voided ? "line-through text-gray-400" : isReturn ? "text-amber-700" : "text-gray-900"}`}>
                    {formatZAR(txn.total_amount)}
                  </span>
                  {!txn.voided && !isReturn && role === "admin" && (
                    <>
                      {remaining > 0 && (
                        <button
                          onClick={() => { setReturnTarget(txn); setReturnQty(String(remaining)); setReturnReason(""); }}
                          className="p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors"
                          title="Return / credit note"
                        >
                          <Undo2 className="w-4 h-4" />
                        </button>
                      )}
                      <button
                        onClick={() => setVoidTarget(txn)}
                        className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                        title="Void this sale"
                      >
                        <XCircle className="w-4 h-4" />
                      </button>
                    </>
                  )}
                </div>
              </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Till reconciliation */}
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

      {/* Void confirmation modal */}
      <Modal open={!!voidTarget} onClose={() => { setVoidTarget(null); setVoidReason(""); }} title="Void Sale">
        {voidTarget && (
          <div className="space-y-4">
            <div className="bg-red-50 border border-red-100 rounded-lg px-4 py-3">
              <p className="text-sm text-red-800">
                You are about to void the sale of <strong>{voidTarget.quantity}× {voidTarget.product_name}</strong> for <strong>{formatZAR(voidTarget.total_amount)}</strong>.
              </p>
              <p className="text-xs text-red-600 mt-1">
                This will return {voidTarget.quantity} unit(s) to stock
                {voidTarget.payment_method === "credit" ? " and reduce the customer's balance" : ""}.
              </p>
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
              <Button variant="danger" onClick={handleVoid} loading={voiding} className="flex-1">
                <RotateCcw className="w-4 h-4 mr-2" />
                Void Sale
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Return / credit note modal */}
      <Modal open={!!returnTarget} onClose={() => { setReturnTarget(null); setReturnReason(""); }} title="Return / Credit Note">
        {returnTarget && (() => {
          const remaining = returnTarget.quantity - (returnedByOriginal[returnTarget.id] || 0);
          const qty = Math.min(Math.max(parseInt(returnQty, 10) || 0, 0), remaining);
          const isCredit = paymentBucket(returnTarget.payment_method) === "credit";
          const refund = Math.round(returnTarget.unit_price * qty * 100) / 100;
          return (
            <div className="space-y-4">
              <div className="bg-amber-50 border border-amber-100 rounded-lg px-4 py-3">
                <p className="text-sm text-amber-900">
                  Return <strong>{returnTarget.product_name}</strong> — sold {returnTarget.quantity}, {remaining} returnable.
                </p>
                <p className="text-xs text-amber-700 mt-1">
                  Goes back to stock.{" "}
                  {isCredit ? "The customer's account balance will be reduced." : "Refund the customer in cash from the till."}
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Quantity to return</label>
                <input
                  type="number"
                  min={1}
                  max={remaining}
                  value={returnQty}
                  onChange={(e) => setReturnQty(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
                />
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
                <Button onClick={handleReturn} loading={returning} disabled={qty < 1 || qty > remaining} className="flex-1">
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
