"use client";
import { useEffect, useState, useCallback } from "react";
import { db } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { formatZAR } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Badge } from "@/components/ui/badge";
import { Banknote, CreditCard, Users, Calculator, XCircle, RotateCcw } from "lucide-react";

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
  payment_method: string;
  customer_id: string | null;
  created_at: string;
  voided: boolean;
}

export default function SalesPage() {
  const { role, name: userName } = useAuth();
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

  const today = new Date().toISOString().split("T")[0];

  const fetchSummary = useCallback(async () => {
    setLoading(true);

    // Fetch all transactions for today (including voided for display)
    const { data: allSales } = await db
      .from("sales")
      .select("id, product_id, quantity, unit_price, total_amount, payment_method, customer_id, created_at, voided, products(name)")
      .eq("sale_date", today)
      .order("created_at", { ascending: false });

    const salesArr: any[] = allSales || [];

    const txns: SaleRecord[] = salesArr.map((s: any) => ({
      id: s.id,
      product_id: s.product_id,
      product_name: s.products?.name || "Unknown",
      quantity: s.quantity,
      unit_price: s.unit_price,
      total_amount: s.total_amount,
      payment_method: s.payment_method,
      customer_id: s.customer_id,
      created_at: s.created_at,
      voided: s.voided || false,
    }));
    setTransactions(txns);

    // Calculate summary from non-voided sales only
    const activeSales = salesArr.filter((s: any) => !s.voided);
    const cash = activeSales.filter((s: any) => s.payment_method === "cash").reduce((sum: number, s: any) => sum + s.total_amount, 0);
    const card = activeSales.filter((s: any) => s.payment_method === "card").reduce((sum: number, s: any) => sum + s.total_amount, 0);
    const credit = activeSales.filter((s: any) => s.payment_method === "credit").reduce((sum: number, s: any) => sum + s.total_amount, 0);
    setSummary({ cash, card, credit, total: cash + card + credit, count: activeSales.length });

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
  }, [today]);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  const openingFloat = parseFloat(recon.opening_float) || 0;
  const expectedCash = openingFloat + summary.cash;
  const actualCash = parseFloat(recon.actual_cash) || 0;
  const variance = recon.actual_cash ? actualCash - expectedCash : null;

  async function saveRecon() {
    setSaving(true);
    const payload = {
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
      .upsert(payload, { onConflict: "recon_date" });

    if (error) alert("Error saving: " + error.message);
    else setReconSaved(true);
    setSaving(false);
  }

  async function handleVoid() {
    if (!voidTarget) return;
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

      // 3. If it was a credit sale, reduce customer balance
      if (voidTarget.payment_method === "credit" && voidTarget.customer_id) {
        const { data: cust } = await db
          .from("customers")
          .select("balance")
          .eq("id", voidTarget.customer_id)
          .single();

        if (cust) {
          await db
            .from("customers")
            .update({ balance: Math.max((cust.balance || 0) - voidTarget.total_amount, 0) })
            .eq("id", voidTarget.customer_id);
        }
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

  const voidedCount = transactions.filter((t) => t.voided).length;

  if (loading) {
    return <div className="text-center py-12 text-gray-400">Loading...</div>;
  }

  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Today&apos;s Sales</h1>

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
            {transactions.filter((txn) => filterMethod === "all" || txn.payment_method === filterMethod).map((txn) => (
              <div
                key={txn.id}
                className={`px-5 py-3 flex items-center justify-between ${txn.voided ? "bg-red-50/50 opacity-60" : ""}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-sm font-medium ${txn.voided ? "line-through text-gray-400" : "text-gray-900"}`}>
                      {txn.product_name}
                    </span>
                    <Badge color={txn.payment_method === "cash" ? "green" : txn.payment_method === "card" ? "blue" : "amber"}>
                      {txn.payment_method === "card" ? "Card" : txn.payment_method === "credit" ? "Credit" : "Cash"}
                    </Badge>
                    {txn.voided && <Badge color="red">Voided</Badge>}
                  </div>
                  <p className="text-xs text-gray-500">
                    Qty {txn.quantity} × {formatZAR(txn.unit_price)} · {new Date(txn.created_at).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" })}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-sm font-semibold ${txn.voided ? "line-through text-gray-400" : "text-gray-900"}`}>
                    {formatZAR(txn.total_amount)}
                  </span>
                  {!txn.voided && role === "admin" && (
                    <button
                      onClick={() => setVoidTarget(txn)}
                      className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                      title="Void this sale"
                    >
                      <XCircle className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            ))}
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
