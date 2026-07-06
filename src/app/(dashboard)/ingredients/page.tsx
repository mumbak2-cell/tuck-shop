"use client";
import { useEffect, useState, useCallback } from "react";
import { db } from "@/lib/supabase";
import { Ingredient } from "@/types/database";
import { formatZAR } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useDebounce } from "@/lib/use-debounce";
import { Plus, Search } from "lucide-react";

export default function IngredientsPage() {
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Ingredient | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [form, setForm] = useState({
    name: "", unit: "", purchase_size: "", purchase_price: "",
    current_stock: "0", reorder_level: "0",
  });

  const fetchIngredients = useCallback(async () => {
    setLoading(true);
    let query = db.from("ingredients").select("*").order("name");
    if (debouncedSearch) query = query.ilike("name", `%${debouncedSearch}%`);
    const { data } = await query;
    setIngredients(data || []);
    setLoading(false);
  }, [debouncedSearch]);

  useEffect(() => { fetchIngredients(); }, [fetchIngredients]);

  function openNew() {
    setEditing(null);
    setForm({ name: "", unit: "", purchase_size: "", purchase_price: "", current_stock: "0", reorder_level: "0" });
    setShowForm(true);
  }

  function openEdit(ing: Ingredient) {
    setEditing(ing);
    setForm({
      name: ing.name, unit: ing.unit, purchase_size: ing.purchase_size || "",
      purchase_price: ing.purchase_price.toString(), current_stock: ing.current_stock.toString(),
      reorder_level: ing.reorder_level.toString(),
    });
    setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);
    const payload = {
      name: form.name.trim(), unit: form.unit.trim(),
      purchase_size: form.purchase_size.trim() || null,
      purchase_price: parseFloat(form.purchase_price),
      current_stock: parseFloat(form.current_stock) || 0,
      reorder_level: parseFloat(form.reorder_level) || 0,
    };
    if (!payload.name || !payload.unit || !payload.purchase_price) {
      setError("Name, unit and price are required."); setSaving(false); return;
    }
    const result = editing
      ? await db.from("ingredients").update(payload).eq("id", editing.id)
      : await db.from("ingredients").insert(payload);
    if (result.error) { setError(result.error.message); setSaving(false); return; }
    setSaving(false);
    setShowForm(false);
    fetchIngredients();
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Ingredients</h1>
        <Button onClick={openNew}><Plus className="w-4 h-4 mr-2" /> Add Ingredient</Button>
      </div>

      <div className="relative mb-6 max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input
          type="text" placeholder="Search ingredients..." value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
        />
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-4 py-3 font-medium text-gray-500">Ingredient</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Unit</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Purchase Size</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500">Price</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500">Stock</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={6} className="px-4 py-12 text-center text-gray-400">Loading...</td></tr>
              ) : ingredients.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-12 text-center text-gray-400">No ingredients found</td></tr>
              ) : (
                ingredients.map((ing) => (
                  <tr key={ing.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">{ing.name}</td>
                    <td className="px-4 py-3 text-gray-600">{ing.unit}</td>
                    <td className="px-4 py-3 text-gray-600">{ing.purchase_size || "—"}</td>
                    <td className="px-4 py-3 text-right">{formatZAR(ing.purchase_price)}</td>
                    <td className="px-4 py-3 text-right">{ing.current_stock}</td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => openEdit(ing)} className="text-green-600 hover:underline text-xs">Edit</button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Modal open={showForm} onClose={() => setShowForm(false)} title={editing ? "Edit Ingredient" : "Add Ingredient"}>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>}
          <Input label="Name *" value={form.name} onChange={(e) => setForm({...form, name: e.target.value})} placeholder="e.g. Cake Flour" />
          <div className="grid grid-cols-2 gap-4">
            <Input label="Unit *" value={form.unit} onChange={(e) => setForm({...form, unit: e.target.value})} placeholder="kg, g, ml, each" />
            <Input label="Purchase Size" value={form.purchase_size} onChange={(e) => setForm({...form, purchase_size: e.target.value})} placeholder="e.g. 2.5kg bag" />
          </div>
          <Input label="Purchase Price (R) *" type="number" step="0.01" value={form.purchase_price} onChange={(e) => setForm({...form, purchase_price: e.target.value})} />
          <div className="grid grid-cols-2 gap-4">
            <Input label="Current Stock" type="number" step="0.01" value={form.current_stock} onChange={(e) => setForm({...form, current_stock: e.target.value})} />
            <Input label="Reorder Level" type="number" step="0.01" value={form.reorder_level} onChange={(e) => setForm({...form, reorder_level: e.target.value})} />
          </div>
          <div className="flex justify-end gap-3 pt-4 border-t">
            <Button type="button" variant="secondary" onClick={() => setShowForm(false)}>Cancel</Button>
            <Button type="submit" loading={saving}>{editing ? "Save Changes" : "Add Ingredient"}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
