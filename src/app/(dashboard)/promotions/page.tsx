"use client";
import { useState, useEffect, useCallback } from "react";
import { db } from "@/lib/supabase";
import { useOrg } from "@/lib/org-context";
import { formatMoney } from "@/lib/format";
import { formatDate } from "@/lib/format";
import { fetchAllPaged } from "@/lib/fetch-all";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Badge } from "@/components/ui/badge";
import type { Product } from "@/types/database";
import { Percent, Plus, Search, X, Calendar, Trash2 } from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Promotion {
  id: string;
  org_id: string;
  name: string;
  discount_percent: number;
  start_date: string;
  end_date: string;
  active: boolean;
  created_at: string;
}

interface PromotionItem {
  id: string;
  promotion_id: string;
  product_id: string;
}

/* ------------------------------------------------------------------ */
/*  Helper: is a promotion currently running?                          */
/* ------------------------------------------------------------------ */

function promoStatus(p: Promotion): "upcoming" | "active" | "ended" | "cancelled" {
  if (!p.active) return "cancelled";
  const today = new Date().toLocaleDateString("en-CA");
  if (p.start_date > today) return "upcoming";
  if (p.end_date < today) return "ended";
  return "active";
}

function statusBadge(s: ReturnType<typeof promoStatus>) {
  const map = {
    active: { variant: "green" as const, label: "Active" },
    upcoming: { variant: "blue" as const, label: "Upcoming" },
    ended: { variant: "gray" as const, label: "Ended" },
    cancelled: { variant: "red" as const, label: "Cancelled" },
  };
  const { variant, label } = map[s];
  return <Badge variant={variant}>{label}</Badge>;
}

/* ------------------------------------------------------------------ */
/*  Page component                                                     */
/* ------------------------------------------------------------------ */

export default function PromotionsPage() {
  const { orgId } = useOrg();

  /* ---- data state ---- */
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [promoItems, setPromoItems] = useState<Record<string, string[]>>({}); // promo_id -> product_id[]
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);

  /* ---- modal state ---- */
  const [showCreate, setShowCreate] = useState(false);
  const [editPromo, setEditPromo] = useState<Promotion | null>(null);
  const [viewPromo, setViewPromo] = useState<Promotion | null>(null);

  /* ---- form state ---- */
  const [formName, setFormName] = useState("");
  const [formDiscount, setFormDiscount] = useState("");
  const [formStart, setFormStart] = useState(() => new Date().toLocaleDateString("en-CA"));
  const [formEnd, setFormEnd] = useState("");
  const [selectedProductIds, setSelectedProductIds] = useState<Set<string>>(new Set());
  const [productSearch, setProductSearch] = useState("");
  const [saving, setSaving] = useState(false);

  /* ---- fetch ---- */
  const fetchData = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const [promoRes, prods] = await Promise.all([
        db.from("promotions").select("*").eq("org_id", orgId).order("created_at", { ascending: false }),
        fetchAllPaged<Product>(() =>
          db.from("products").select("*").eq("discontinued", false).order("name")
        ),
      ]);
      const promos: Promotion[] = promoRes.data ?? [];
      setPromotions(promos);
      setProducts(prods);

      // fetch promotion_items for all promotions
      if (promos.length > 0) {
        const ids = promos.map((p) => p.id);
        const { data: items } = await db
          .from("promotion_items")
          .select("*")
          .in("promotion_id", ids);
        const map: Record<string, string[]> = {};
        for (const it of (items ?? []) as PromotionItem[]) {
          (map[it.promotion_id] ??= []).push(it.product_id);
        }
        setPromoItems(map);
      }
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  /* ---- product map for display ---- */
  const productMap = new Map(products.map((p) => [p.id, p]));

  /* ---- open create modal ---- */
  const openCreate = () => {
    setFormName("");
    setFormDiscount("");
    setFormStart(new Date().toLocaleDateString("en-CA"));
    setFormEnd("");
    setSelectedProductIds(new Set());
    setProductSearch("");
    setEditPromo(null);
    setShowCreate(true);
  };

  /* ---- open edit modal ---- */
  const openEdit = (p: Promotion) => {
    setFormName(p.name);
    setFormDiscount(String(p.discount_percent));
    setFormStart(p.start_date);
    setFormEnd(p.end_date);
    setSelectedProductIds(new Set(promoItems[p.id] ?? []));
    setProductSearch("");
    setEditPromo(p);
    setShowCreate(true);
  };

  /* ---- save (create or update) ---- */
  const handleSave = async () => {
    if (!orgId || !formName.trim() || !formEnd || selectedProductIds.size === 0) return;
    const discountNum = parseFloat(formDiscount);
    if (isNaN(discountNum) || discountNum <= 0 || discountNum > 100) return;
    setSaving(true);
    try {
      if (editPromo) {
        // update promotion
        await db.from("promotions").update({
          name: formName.trim(),
          discount_percent: discountNum,
          start_date: formStart,
          end_date: formEnd,
        }).eq("id", editPromo.id);

        // replace items: delete old, insert new
        await db.from("promotion_items").delete().eq("promotion_id", editPromo.id);
        const rows = Array.from(selectedProductIds).map((pid) => ({
          promotion_id: editPromo.id,
          product_id: pid,
        }));
        if (rows.length > 0) {
          await db.from("promotion_items").insert(rows);
        }
      } else {
        // create
        const { data: newPromo, error } = await db
          .from("promotions")
          .insert({
            org_id: orgId,
            name: formName.trim(),
            discount_percent: discountNum,
            start_date: formStart,
            end_date: formEnd,
          })
          .select("id")
          .single();
        if (error) throw error;
        const rows = Array.from(selectedProductIds).map((pid) => ({
          promotion_id: newPromo.id,
          product_id: pid,
        }));
        if (rows.length > 0) {
          await db.from("promotion_items").insert(rows);
        }
      }
      setShowCreate(false);
      fetchData();
    } finally {
      setSaving(false);
    }
  };

  /* ---- end promotion early ---- */
  const endPromotion = async (id: string) => {
    await db.from("promotions").update({ active: false }).eq("id", id);
    fetchData();
  };

  /* ---- filtered products for picker ---- */
  const filteredProducts = products.filter((p) => {
    if (!productSearch.trim()) return true;
    const q = productSearch.toLowerCase();
    return p.name.toLowerCase().includes(q) || p.inventory_id.toLowerCase().includes(q);
  });

  const toggleProduct = (id: string) => {
    setSelectedProductIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /* ---- render ---- */
  if (loading) {
    return (
      <div className="p-6 text-center text-gray-500">Loading promotions…</div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Percent className="w-6 h-6 text-green-600" />
          <h1 className="text-xl font-bold text-gray-900">Promotions</h1>
        </div>
        <Button onClick={openCreate}>
          <Plus className="w-4 h-4 mr-1" /> New Promotion
        </Button>
      </div>

      {/* Empty state */}
      {promotions.length === 0 && (
        <div className="text-center py-16 text-gray-500">
          <Percent className="w-12 h-12 mx-auto mb-3 text-gray-300" />
          <p className="text-lg font-medium">No promotions yet</p>
          <p className="text-sm mt-1">Create a promotion to offer temporary discounts on selected products.</p>
        </div>
      )}

      {/* Promotion cards */}
      <div className="grid gap-4">
        {promotions.map((p) => {
          const status = promoStatus(p);
          const itemIds = promoItems[p.id] ?? [];
          return (
            <div
              key={p.id}
              className="bg-white rounded-xl border border-gray-200 p-5 space-y-3 hover:shadow-sm transition-shadow"
            >
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-semibold text-gray-900">{p.name}</h3>
                  <p className="text-sm text-gray-500 mt-0.5">
                    {p.discount_percent}% off · {itemIds.length} product{itemIds.length !== 1 ? "s" : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {statusBadge(status)}
                </div>
              </div>

              <div className="flex items-center gap-4 text-sm text-gray-600">
                <span className="flex items-center gap-1">
                  <Calendar className="w-4 h-4" />
                  {formatDate(p.start_date)} — {formatDate(p.end_date)}
                </span>
              </div>

              {/* Show a few product names */}
              {itemIds.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {itemIds.slice(0, 5).map((pid) => {
                    const prod = productMap.get(pid);
                    return prod ? (
                      <span key={pid} className="inline-block text-xs bg-gray-100 text-gray-700 rounded-full px-2.5 py-0.5">
                        {prod.name}
                      </span>
                    ) : null;
                  })}
                  {itemIds.length > 5 && (
                    <span className="text-xs text-gray-400">+{itemIds.length - 5} more</span>
                  )}
                </div>
              )}

              {/* Actions */}
              <div className="flex items-center gap-2 pt-1">
                <Button size="sm" variant="ghost" onClick={() => setViewPromo(p)}>
                  View
                </Button>
                {(status === "active" || status === "upcoming") && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => openEdit(p)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => endPromotion(p.id)}>
                      End Now
                    </Button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* ============================================================ */}
      {/* View modal — full product list for a promotion                */}
      {/* ============================================================ */}
      <Modal open={!!viewPromo} onClose={() => setViewPromo(null)} title={viewPromo?.name ?? "Promotion"} wide>
        {viewPromo && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <span className="text-gray-500">Discount</span>
                <p className="font-medium">{viewPromo.discount_percent}%</p>
              </div>
              <div>
                <span className="text-gray-500">Status</span>
                <p>{statusBadge(promoStatus(viewPromo))}</p>
              </div>
              <div>
                <span className="text-gray-500">Start</span>
                <p className="font-medium">{formatDate(viewPromo.start_date)}</p>
              </div>
              <div>
                <span className="text-gray-500">End</span>
                <p className="font-medium">{formatDate(viewPromo.end_date)}</p>
              </div>
            </div>

            <div>
              <h4 className="text-sm font-medium text-gray-700 mb-2">Products in this promotion</h4>
              <div className="max-h-60 overflow-y-auto divide-y">
                {(promoItems[viewPromo.id] ?? []).map((pid) => {
                  const prod = productMap.get(pid);
                  if (!prod) return null;
                  const discounted = prod.selling_price * (1 - viewPromo.discount_percent / 100);
                  return (
                    <div key={pid} className="py-2 flex items-center justify-between text-sm">
                      <span>{prod.name}</span>
                      <span>
                        <span className="line-through text-gray-400 mr-2">{formatMoney(prod.selling_price)}</span>
                        <span className="font-medium text-green-700">{formatMoney(discounted)}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* ============================================================ */}
      {/* Create / Edit modal                                           */}
      {/* ============================================================ */}
      <Modal open={showCreate} onClose={() => setShowCreate(false)} title={editPromo ? "Edit Promotion" : "New Promotion"} wide>
        <div className="space-y-5">
          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Promotion Name</label>
            <input
              type="text"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-green-500 focus:border-transparent"
              placeholder="e.g. Winter Clearance"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
            />
          </div>

          {/* Discount */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Discount Percentage</label>
            <div className="relative w-32">
              <input
                type="number"
                min={1}
                max={100}
                step={1}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm pr-8 focus:ring-2 focus:ring-green-500 focus:border-transparent"
                placeholder="10"
                value={formDiscount}
                onChange={(e) => setFormDiscount(e.target.value)}
              />
              <span className="absolute right-3 top-2 text-gray-400 text-sm">%</span>
            </div>
          </div>

          {/* Dates */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Start Date</label>
              <input
                type="date"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-green-500 focus:border-transparent"
                value={formStart}
                onChange={(e) => setFormStart(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">End Date</label>
              <input
                type="date"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-green-500 focus:border-transparent"
                value={formEnd}
                min={formStart}
                onChange={(e) => setFormEnd(e.target.value)}
              />
            </div>
          </div>

          {/* Product picker */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Select Products ({selectedProductIds.size} selected)
            </label>

            {/* Selected chips */}
            {selectedProductIds.size > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {Array.from(selectedProductIds).map((pid) => {
                  const prod = productMap.get(pid);
                  if (!prod) return null;
                  return (
                    <span key={pid} className="inline-flex items-center gap-1 text-xs bg-green-100 text-green-800 rounded-full px-2.5 py-1">
                      {prod.name}
                      <button onClick={() => toggleProduct(pid)} className="hover:text-red-600">
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  );
                })}
              </div>
            )}

            {/* Search */}
            <div className="relative mb-2">
              <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
              <input
                type="text"
                className="w-full border border-gray-300 rounded-lg pl-9 pr-3 py-2 text-sm focus:ring-2 focus:ring-green-500 focus:border-transparent"
                placeholder="Search products…"
                value={productSearch}
                onChange={(e) => setProductSearch(e.target.value)}
              />
            </div>

            {/* Product list */}
            <div className="border border-gray-200 rounded-lg max-h-48 overflow-y-auto divide-y">
              {filteredProducts.slice(0, 100).map((p) => {
                const checked = selectedProductIds.has(p.id);
                const discountVal = parseFloat(formDiscount);
                const showDiscount = !isNaN(discountVal) && discountVal > 0 && discountVal <= 100;
                return (
                  <label
                    key={p.id}
                    className={`flex items-center justify-between px-3 py-2 text-sm cursor-pointer hover:bg-gray-50 ${
                      checked ? "bg-green-50" : ""
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleProduct(p.id)}
                        className="rounded border-gray-300 text-green-600 focus:ring-green-500"
                      />
                      <span>{p.name}</span>
                      <span className="text-gray-400 text-xs">{p.inventory_id}</span>
                    </div>
                    <span className="text-gray-500 whitespace-nowrap">
                      {formatMoney(p.selling_price)}
                      {showDiscount && checked && (
                        <span className="ml-1 text-green-700 font-medium">
                          → {formatMoney(p.selling_price * (1 - discountVal / 100))}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
              {filteredProducts.length > 100 && (
                <div className="px-3 py-2 text-xs text-gray-400 text-center">
                  Showing first 100 of {filteredProducts.length} — narrow your search
                </div>
              )}
              {filteredProducts.length === 0 && (
                <div className="px-3 py-4 text-sm text-gray-400 text-center">No products found</div>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button
              onClick={handleSave}
              loading={saving}
              disabled={!formName.trim() || !formEnd || selectedProductIds.size === 0 || !formDiscount}
            >
              {editPromo ? "Update Promotion" : "Create Promotion"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
