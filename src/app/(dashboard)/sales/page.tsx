"use client";
import { useEffect, useState, useCallback } from "react";
import { db } from "@/lib/supabase";
import { formatZAR } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Banknote, CreditCard, Users, Calculator } from "lucide-react";

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

export default function SalesPage() {
  const [summary, setSummary] = useState<SaleSummary>({ cash: 0, card: 0, credit: 0, total: 0, count: 0 });
  const [recon, setRecon] = useState<ReconData>({ opening_float: "0", actual_cash: "" });
  const [reconSaved, setReconSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  const today = new Date().toISOString().split("T")[0];

  const fetchSummary = useCallback(async () => {
    setLoading(true);
    const { data: sales } = await db
      .from("sales")
      .select("total_amount, payment_method")
      .eq("sale_date", today);

    if (sales) {
      const salesArr: any[] = sales;
      const cash = salesArr.filter((s: any) => s.payment_method === "cash").reduce((sum: number, s: any) => sum + s.total_amount, 0);
      const card = salesArr.filter((s: any) => s.payment_method === "card").reduce((sum: number, s: any) => sum + s.total_amount, 0);
      const credit = salesArr.filter((s: any) => s.payment_method === "credit").reduce((sum: number, s: any) => sum + s.total_amount, 0);
      setSummary({ cash, card, credit, total: cash + card + credit, count: salesArr.length });
    }

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

  if (loading) {
    return <div className="text-center py-12 text-gray-400">Loading...</div>;
  }

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Today&apos;s Sales</h1>

      {/* Sales breakdown */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <SummaryCard icon={Banknote} label="Cash Sales" amount={summary.cash} color="bg-green-600" />
        <SummaryCard icon={CreditCard} label="Card Sales" amount={summary.card} color="bg-blue-600" />
        <SummaryCard icon={Users} label="Credit Sales" amount={summary.credit} color="bg-amber-500" />
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
          </div>
        </div>
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
    </div>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  amount,
  color,
}: {
  icon: React.ElementType;
  label: string;
  amount: number;
  color: string;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="flex items-center gap-3">
        <div className={`p-2 rounded-lg ${color}`}>
          <Icon className="w-5 h-5 text-white" />
        </div>
        <div>
          <p className="text-xs text-gray-500">{label}</p>
          <p className="text-lg font-bold text-gray-900">{formatZAR(amount)}</p>
        </div>
      </div>
    </div>
  );
}
