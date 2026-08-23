"use client";
import { useState, useEffect, useCallback } from "react";
import { db } from "@/lib/supabase";
import { fetchAllPaged } from "@/lib/fetch-all";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Tooltip } from "@/components/ui/tooltip";
import { Plus, Pencil, Trash2 } from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────
// Expense categories management modal — mirrors ManageCategoriesModal on
// the Products page (src/app/(dashboard)/products/page.tsx), but scoped to
// expense_categories (migration 097). Each org defines its own list: a
// pharmacy has no use for "Fuel"/"Rent" and needs "Security Guard" instead
// of what a tuck shop needs.
//
// "Stock Purchases" and "Ingredient Purchases" are not specially protected
// here — an org can remove either from its picker. Receive Stock still
// writes "Stock Purchases" directly regardless (src/app/(dashboard)/receive-stock/page.tsx),
// and the P&L / Cash-spent COGS-exclusion logic (INVENTORY_EXPENSE_CATEGORIES
// in src/types/database.ts) matches by name, not by list membership.
// ─────────────────────────────────────────────────────────────────────────

export function ManageExpenseCategoriesModal({
  open, onClose, onChanged,
}: {
  open: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [rows, setRows] = useState<{ name: string; count: number; inTable: boolean }[]>([]);
  const [loading, setLoading] = useState(true);
  const [newCategory, setNewCategory] = useState("");
  const [adding, setAdding] = useState(false);
  const [renameFrom, setRenameFrom] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const [{ data: catRows }, expCats] = await Promise.all([
      db.from("expense_categories").select("name").eq("active", true).order("sort_order"),
      fetchAllPaged<{ category: string }>(() => db.from("expenses").select("category")),
    ]);
    const tableNames = new Set<string>(((catRows as { name: string }[]) || []).map((c) => c.name));
    const counts = new Map<string, number>();
    expCats.forEach((r) => {
      const c = (r.category || "").trim();
      if (c) counts.set(c, (counts.get(c) || 0) + 1);
    });
    const all = new Set<string>([...tableNames, ...counts.keys()]);
    const list = [...all]
      .map((name) => ({
        name,
        count: counts.get(name) || 0,
        inTable: tableNames.has(name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    setRows(list);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (open) {
      refresh();
      setNewCategory("");
      setRenameFrom(null);
      setRenameTo("");
      setMsg(null);
    }
  }, [open, refresh]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const name = newCategory.trim();
    if (!name) return;
    setAdding(true);
    setMsg(null);
    const { error } = await db.from("expense_categories").insert({ name, sort_order: rows.length, active: true });
    setAdding(false);
    if (error) {
      setMsg(`Could not add: ${error.message}`);
      return;
    }
    setNewCategory("");
    await refresh();
    await onChanged();
  }

  async function handleRename(originalName: string) {
    const next = renameTo.trim();
    if (!next || next === originalName) {
      setRenameFrom(null);
      return;
    }
    setBusy(originalName);
    setMsg(null);
    // Rename the expense_categories-table row if it exists
    const tableUpdate = await db.from("expense_categories").update({ name: next }).eq("name", originalName);
    // Rename every expense currently tagged with the old name
    const expensesUpdate = await db.from("expenses").update({ category: next }).eq("category", originalName);
    setBusy(null);
    if (tableUpdate.error && tableUpdate.error.code !== "23505") {
      setMsg(`Rename failed on category list: ${tableUpdate.error.message}`);
      return;
    }
    if (expensesUpdate.error) {
      setMsg(`Expenses were not fully renamed: ${expensesUpdate.error.message}`);
      return;
    }
    setRenameFrom(null);
    setRenameTo("");
    await refresh();
    await onChanged();
  }

  async function handleRemove(name: string, count: number) {
    if (count > 0) {
      alert(`Cannot remove "${name}" — ${count} expense${count !== 1 ? "s" : ""} already use it. Rename the category instead, or re-categorise those expenses first.`);
      return;
    }
    if (!confirm(`Remove "${name}" from your category list?`)) return;
    setBusy(name);
    await db.from("expense_categories").update({ active: false }).eq("name", name);
    setBusy(null);
    await refresh();
    await onChanged();
  }

  return (
    <Modal open={open} onClose={onClose} title="Manage Expense Categories" wide>
      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          Define what expense categories make sense for your business. Add new ones, rename existing ones (every
          expense with that category updates automatically), or remove categories you don&apos;t use any more.
        </p>

        {/* Add */}
        <form onSubmit={handleAdd} className="flex gap-2">
          <input
            type="text"
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            placeholder="New category name (e.g. Security Guard)"
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
          />
          <Button type="submit" loading={adding}>
            <Plus className="w-4 h-4 mr-1" /> Add
          </Button>
        </form>

        {msg && (
          <div className="bg-amber-50 border border-amber-200 text-amber-900 px-3 py-2 rounded-lg text-sm">{msg}</div>
        )}

        {/* List */}
        <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-96 overflow-y-auto">
          {loading ? (
            <div className="px-4 py-6 text-center text-sm text-gray-400">Loading...</div>
          ) : rows.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-gray-400">No categories yet — add your first one above.</div>
          ) : (
            rows.map((r) => (
              <div key={r.name} className="group px-4 py-3 flex items-center justify-between gap-3">
                {renameFrom === r.name ? (
                  <>
                    <input
                      type="text"
                      value={renameTo}
                      autoFocus
                      onChange={(e) => setRenameTo(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleRename(r.name);
                        if (e.key === "Escape") setRenameFrom(null);
                      }}
                      className="flex-1 border border-green-400 rounded-lg px-3 py-1.5 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
                    />
                    <button type="button" onClick={() => handleRename(r.name)} className="text-sm text-green-700 hover:underline">Save</button>
                    <button type="button" onClick={() => setRenameFrom(null)} className="text-sm text-gray-500 hover:underline">Cancel</button>
                  </>
                ) : (
                  <>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{r.name}</p>
                      <p className="text-xs text-gray-500">
                        {r.count} expense{r.count !== 1 ? "s" : ""}
                        {!r.inTable && " · only on past expenses (not in your category list)"}
                      </p>
                    </div>
                    <div className="inline-flex shrink-0 gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                      <Tooltip label="Rename category">
                        <button
                          type="button"
                          onClick={() => { setRenameFrom(r.name); setRenameTo(r.name); }}
                          disabled={busy === r.name}
                          aria-label={`Rename ${r.name}`}
                          className="rounded p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900 disabled:opacity-50"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                      </Tooltip>
                      <Tooltip label={r.count > 0 ? `In use by ${r.count} expense${r.count !== 1 ? "s" : ""}` : "Remove category"}>
                        <button
                          type="button"
                          onClick={() => handleRemove(r.name, r.count)}
                          disabled={busy === r.name}
                          aria-label={`Remove ${r.name}`}
                          className="rounded p-1.5 text-gray-500 hover:bg-red-50 hover:text-red-700 disabled:opacity-50"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </Tooltip>
                    </div>
                  </>
                )}
              </div>
            ))
          )}
        </div>

        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose}>Done</Button>
        </div>
      </div>
    </Modal>
  );
}
