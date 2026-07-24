"use client";
import { useState, useEffect } from "react";
import { db, supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useOrg } from "@/lib/org-context";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { Modal } from "@/components/ui/modal";
import { Badge } from "@/components/ui/badge";
import { formatZAR, formatDate } from "@/lib/format";
import { Receipt, Plus, Trash2, Filter, CloudOff, Users, Paperclip } from "lucide-react";
import { EXPENSE_CATEGORIES, INVENTORY_EXPENSE_CATEGORIES, type Expense, type ExpenseCategory } from "@/types/database";
import { insertOrQueue } from "@/lib/offline-ops";
import { ReceiptUpload } from "@/components/ui/receipt-upload";
import { ReceiptViewer } from "@/components/ui/receipt-viewer";
import { deleteReceiptIfUnreferenced, discardUnsavedReceipt } from "@/lib/receipt-storage";

export default function ExpensesPage() {
  const { name } = useAuth();
  const { currentLocationId, currentLocationName, orgId, role } = useOrg();
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [loading, setLoading] = useState(true);
  const [queuedNote, setQueuedNote] = useState<string | null>(null);
  const [viewingReceipt, setViewingReceipt] = useState<string | null>(null);

  // Owner-only: per-cashier expense breakdown for the selected dates/branch.
  interface CashierRow { userId: string | null; name: string; email: string | null; total: number; count: number }
  const [cashierReport, setCashierReport] = useState<CashierRow[]>([]);
  const [reportLoading, setReportLoading] = useState(false);

  // Filters
  const [filterCategory, setFilterCategory] = useState<string>("all");
  const [filterFrom, setFilterFrom] = useState(() => {
    const d = new Date();
    d.setDate(1); // first of month
    return d.toISOString().split("T")[0];
  });
  const [filterTo, setFilterTo] = useState(() => new Date().toISOString().split("T")[0]);

  // Form
  const [formDate, setFormDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [formCategory, setFormCategory] = useState<ExpenseCategory>("Transport");
  const [formDescription, setFormDescription] = useState("");
  const [formAmount, setFormAmount] = useState("");
  const [formDirectorName, setFormDirectorName] = useState("");
  const [formReceiptPath, setFormReceiptPath] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadExpenses();
  }, [filterCategory, filterFrom, filterTo, currentLocationId]);

  // Owner-only per-cashier report. loadCashierReport no-ops for non-owners.
  useEffect(() => {
    loadCashierReport();
  }, [role, filterFrom, filterTo, currentLocationId]);

  async function loadExpenses() {
    setLoading(true);
    let query = db
      .from("expenses")
      .select("*")
      .gte("expense_date", filterFrom)
      .lte("expense_date", filterTo)
      .order("expense_date", { ascending: false });

    if (filterCategory !== "all") {
      query = query.eq("category", filterCategory);
    }
    // Per-location: show only this shop's expenses.
    if (currentLocationId) {
      query = query.eq("location_id", currentLocationId);
    }

    const { data } = await query;
    setExpenses(data || []);
    setLoading(false);
  }

  async function loadCashierReport() {
    // Owner or manager (admin) may see who spent what; cashiers may not.
    if (role !== "owner" && role !== "admin") {
      setCashierReport([]);
      return;
    }
    setReportLoading(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const t = sess.session?.access_token;
      if (!t) {
        setReportLoading(false);
        return;
      }
      const params = new URLSearchParams({ from: filterFrom, to: filterTo });
      if (currentLocationId) params.set("locationId", currentLocationId);
      const res = await fetch(`/api/reports/cashier-expenses?${params.toString()}`, {
        headers: { Authorization: `Bearer ${t}` },
      });
      const json = await res.json();
      if (res.ok) setCashierReport(json.cashiers || []);
    } catch {
      // Non-critical — leave the report empty on failure.
    } finally {
      setReportLoading(false);
    }
  }

  async function handleSave() {
    if (!formAmount || parseFloat(formAmount) <= 0) return;
    if (!orgId) {
      alert("Shop not loaded yet. Try again in a moment.");
      return;
    }
    setSaving(true);

    const result = await insertOrQueue({
      org_id: orgId,
      table: "expenses",
      queueKind: "insert_expense",
      row: {
        expense_date: formDate,
        category: formCategory,
        description: formDescription || null,
        amount: parseFloat(formAmount),
        director_name: formCategory === "Director Withdrawal" ? formDirectorName || null : null,
        recorded_by: name,
        location_id: currentLocationId,
        ...(formReceiptPath ? { receipt_path: formReceiptPath } : {}),
      } as { id?: string } & Record<string, unknown>,
    });

    setSaving(false);

    if (!result.ok) {
      alert("Error saving expense: " + (result.error || "unknown"));
      return;
    }

    setShowAdd(false);
    resetForm();
    if (result.queued) {
      setQueuedNote(`Expense saved offline — will sync when you're back online.`);
      setTimeout(() => setQueuedNote(null), 4000);
    }
    loadExpenses();
  }

  async function handleDelete(id: string, receiptPath: string | null) {
    if (!confirm("Delete this expense entry?")) return;
    await db.from("expenses").delete().eq("id", id);
    // After the row is gone, drop its receipt unless something else still
    // needs it — a delivery and its auto-created expense share one file.
    if (receiptPath) await deleteReceiptIfUnreferenced(receiptPath);
    loadExpenses();
  }

  async function handleCancel() {
    // The file uploads as soon as it is picked, so abandoning the form would
    // leave an object no row references.
    if (formReceiptPath) await discardUnsavedReceipt(formReceiptPath);
    setShowAdd(false);
    resetForm();
  }

  function resetForm() {
    setFormDate(new Date().toISOString().split("T")[0]);
    setFormCategory("Transport");
    setFormDescription("");
    setFormAmount("");
    setFormDirectorName("");
    setFormReceiptPath(null);
  }

  const totalAmount = expenses.reduce((sum, e) => sum + e.amount, 0);
  const directorTotal = expenses
    .filter((e) => e.category === "Director Withdrawal")
    .reduce((sum, e) => sum + e.amount, 0);
  const operatingTotal = totalAmount - directorTotal;

  const categoryColors: Record<string, string> = {
    Transport: "blue",
    Fuel: "amber",
    Rent: "purple",
    Electricity: "yellow",
    Consumables: "gray",
    Wages: "green",
    "Stock Purchases": "cyan",
    "Ingredient Purchases": "cyan",
    "Director Withdrawal": "red",
    Other: "gray",
  };

  return (
    <div>
      {queuedNote && (
        <div className="mb-4 inline-flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm text-amber-900">
          <CloudOff className="w-4 h-4 text-amber-700" /> {queuedNote}
        </div>
      )}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Receipt className="w-7 h-7 text-green-600" />
            Expenses & Outflows
          </h1>
          <p className="text-sm text-gray-500 mt-1">Track daily outflows, expenses, and director withdrawals</p>
        </div>
        <Button onClick={() => setShowAdd(true)}>
          <Plus className="w-4 h-4 mr-2" /> Record Expense
        </Button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-white border border-gray-200 rounded-xl px-5 py-4">
          <p className="text-sm text-gray-500">Total Outflows</p>
          <p className="text-2xl font-bold text-gray-900">{formatZAR(totalAmount)}</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl px-5 py-4">
          <p className="text-sm text-gray-500">Operating Expenses</p>
          <p className="text-2xl font-bold text-gray-900">{formatZAR(operatingTotal)}</p>
        </div>
        <div className="bg-white border border-red-100 rounded-xl px-5 py-4">
          <p className="text-sm text-red-600">Director Withdrawals</p>
          <p className="text-2xl font-bold text-red-700">{formatZAR(directorTotal)}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4 items-end">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">From</label>
          <input
            type="date"
            value={filterFrom}
            onChange={(e) => setFilterFrom(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">To</label>
          <input
            type="date"
            value={filterTo}
            onChange={(e) => setFilterTo(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Category</label>
          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
          >
            <option value="all">All Categories</option>
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Owner/manager: per-cashier breakdown for the selected period/branch */}
      {(role === "owner" || role === "admin") && (
        <div className="bg-white border border-gray-200 rounded-xl p-5 mb-6">
          <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2 mb-1">
            <Users className="w-4 h-4 text-green-600" />
            Expenses by cashier
          </h2>
          <p className="text-xs text-gray-500 mb-3">
            Who recorded expenses at {currentLocationName || "this shop"} in the selected dates.
          </p>
          {reportLoading ? (
            <p className="text-sm text-gray-400 py-2">Loading…</p>
          ) : cashierReport.length === 0 ? (
            <p className="text-sm text-gray-400 py-2">No expenses recorded in this period.</p>
          ) : (
            <div className="divide-y divide-gray-100">
              {cashierReport.map((c) => (
                <div key={c.userId ?? "unattributed"} className="flex items-center justify-between py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{c.name}</p>
                    {c.email && <p className="text-xs text-gray-500 truncate">{c.email}</p>}
                  </div>
                  <div className="text-right shrink-0 ml-3">
                    <p className="text-sm font-semibold text-gray-900">{formatZAR(c.total)}</p>
                    <p className="text-xs text-gray-500">
                      {c.count} {c.count === 1 ? "entry" : "entries"}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Expenses list */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading...</div>
      ) : expenses.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <Receipt className="w-12 h-12 mx-auto mb-3 opacity-50" />
          <p>No expenses recorded for this period.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {expenses.map((exp) => (
            <div
              key={exp.id}
              className="bg-white border border-gray-200 rounded-xl px-5 py-4 flex items-center justify-between"
            >
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <Badge color={categoryColors[exp.category] || "gray"}>{exp.category}</Badge>
                  {exp.director_name && (
                    <span className="text-xs text-red-600 font-medium">{exp.director_name}</span>
                  )}
                </div>
                <p className="font-medium text-gray-900 mt-1">{exp.description || exp.category}</p>
                <p className="text-xs text-gray-500">
                  {formatDate(exp.expense_date)} · Recorded by {exp.recorded_by || "Unknown"}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <p className="text-lg font-bold text-gray-900">{formatZAR(exp.amount)}</p>
                {exp.receipt_path && (
                  <Tooltip label="View receipt">
                    <button
                      onClick={() => setViewingReceipt(exp.receipt_path)}
                      aria-label="View receipt"
                      className="p-1.5 text-gray-400 hover:text-green-600 rounded"
                    >
                      <Paperclip className="w-4 h-4" />
                    </button>
                  </Tooltip>
                )}
                <Tooltip label="Delete expense">
                  <button
                    onClick={() => handleDelete(exp.id, exp.receipt_path)}
                    aria-label="Delete expense"
                    className="p-1.5 text-gray-400 hover:text-red-600 rounded"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </Tooltip>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Expense Modal */}
      <Modal open={showAdd} onClose={handleCancel} title="Record Expense">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
            <input
              type="date"
              value={formDate}
              onChange={(e) => setFormDate(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
            <select
              value={formCategory}
              onChange={(e) => setFormCategory(e.target.value as ExpenseCategory)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
            >
              {EXPENSE_CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            {INVENTORY_EXPENSE_CATEGORIES.includes(formCategory) && (
              <p className="text-xs text-gray-500 mt-1.5">
                Counts as money out on the Cash spent report, but not against profit — buying
                inventory becomes a cost through Cost of Goods Sold when the item sells.
              </p>
            )}
          </div>

          {formCategory === "Director Withdrawal" && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Director Name</label>
              <input
                type="text"
                value={formDirectorName}
                onChange={(e) => setFormDirectorName(e.target.value)}
                placeholder="e.g. Mumba Kunda"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
              />
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description (optional)</label>
            <input
              type="text"
              value={formDescription}
              onChange={(e) => setFormDescription(e.target.value)}
              placeholder="e.g. Petrol for delivery, Monthly rent"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Amount (R)</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={formAmount}
              onChange={(e) => setFormAmount(e.target.value)}
              placeholder="0.00"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
            />
          </div>

          {orgId && (
            <ReceiptUpload orgId={orgId} value={formReceiptPath} onUploaded={setFormReceiptPath} />
          )}

          <div className="flex gap-3 pt-2">
            <Button variant="secondary" onClick={handleCancel} className="flex-1">
              Cancel
            </Button>
            <Button onClick={handleSave} loading={saving} disabled={!formAmount || parseFloat(formAmount) <= 0} className="flex-1">
              Save Expense
            </Button>
          </div>
        </div>
      </Modal>

      <ReceiptViewer path={viewingReceipt} onClose={() => setViewingReceipt(null)} />
    </div>
  );
}
