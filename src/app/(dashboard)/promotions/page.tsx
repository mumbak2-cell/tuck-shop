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
import { Percent, Layers, Plus, Search, X, Calendar, Trash2 } from "lucide-react";

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

interface Combo {
  id: string;
  org_id: string;
  name: string;
  combo_price: number;
  active: boolean;
  created_at: string;
}

interface ComboItem {
  id: string;
  combo_id: string;
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

  const [tab, setTab] = useState<"promotions" | "combos">("promotions");

  /* ---- shared data state ---- */
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);

  /* ---- promotions data state ---- */
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [promoItems, setPromoItems] = useState<Record<string, string[]>>({}); // promo_id -> product_id[]

  /* ---- promotions modal/form state ---- */
  const [showCreate, setShowCreate] = useState(false);
  const [editPromo, setEditPromo] = useState<Promotion | null>(null);
  const [viewPromo, setViewPromo] = useState<Promotion | null>(null);
  const [formName, setFormName] = useState("");
  const [formDiscount, setFormDiscount] = useState("");
  const [formStart, setFormStart] = useState(() => new Date().toLocaleDateString("en-CA"));
  const [formEnd, setFormEnd] = useState("");
  const [selectedProductIds, setSelectedProductIds] = useState<Set<string>>(new Set());
  const [productSearch, setProductSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [overlapWarning, setOverlapWarning] = useState<string | null>(null);

  /* ---- combos data state ---- */
  const [combos, setCombos] = useState<Combo[]>([]);
  const [comboItems, setComboItems] = useState<Record<string, string[]>>({}); // combo_id -> product_id[]

  /* ---- combos modal/form state ---- */
  const [showComboCreate, setShowComboCreate] = useState(false);
  const [editCombo, setEditCombo] = useState<Combo | null>(null);
  const [comboFormName, setComboFormName] = useState("");
  const [comboFormPrice, setComboFormPrice] = useState("");
  const [comboSelectedProductIds, setComboSelectedProductIds] = useState<Set<string>>(new Set());
  const [comboProductSearch, setComboProductSearch] = useState("");
  const [comboSaving, setComboSaving] = useState(false);

  /* ---- fetch (promotions + combos share the one product list) ---- */
  const fetchData = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const [promoRes, comboRes, prods] = await Promise.all([
        db.from("promotions").select("*").eq("org_id", orgId).order("created_at", { ascending: false }),
        db.from("combos").select("*").eq("org_id", orgId).order("created_at", { ascending: false }),
        fetchAllPaged<Product>(() =>
          db.from("products").select("*").eq("discontinued", false).order("name")
        ),
      ]);
      const promos: Promotion[] = promoRes.data ?? [];
      const combosData: Combo[] = comboRes.data ?? [];
      setPromotions(promos);
      setCombos(combosData);
      setProducts(prods);

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
      } else {
        setPromoItems({});
      }

      if (combosData.length > 0) {
        const ids = combosData.map((c) => c.id);
        const { data: items } = await db
          .from("combo_items")
          .select("*")
          .in("combo_id", ids);
        const map: Record<string, string[]> = {};
        for (const it of (items ?? []) as ComboItem[]) {
          (map[it.combo_id] ??= []).push(it.product_id);
        }
        setComboItems(map);
      } else {
        setComboItems({});
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

  /* ================================================================ */
  /*  Promotions                                                       */
  /* ================================================================ */

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

  /* ---- check for overlapping promos on the same products (L6) ---- */
  const checkOverlaps = async (): Promise<string | null> => {
    if (!orgId || selectedProductIds.size === 0 || !formStart || !formEnd) return null;

    const { data: overlapping } = await db
      .from("promotions")
      .select("id, name, start_date, end_date")
      .eq("org_id", orgId)
      .eq("active", true)
      .lte("start_date", formEnd)
      .gte("end_date", formStart);

    type OverlapRow = { id: string; name: string; start_date: string; end_date: string };
    const rows = (overlapping ?? []) as OverlapRow[];
    if (rows.length === 0) return null;

    const others = editPromo
      ? rows.filter((p: OverlapRow) => p.id !== editPromo.id)
      : rows;
    if (others.length === 0) return null;

    const otherIds = others.map((p: OverlapRow) => p.id);
    const { data: sharedItems } = await db
      .from("promotion_items")
      .select("promotion_id, product_id")
      .in("promotion_id", otherIds)
      .in("product_id", Array.from(selectedProductIds));

    type SharedRow = { promotion_id: string; product_id: string };
    const shared = (sharedItems ?? []) as SharedRow[];
    if (shared.length === 0) return null;

    const promoNames = new Set(
      shared.map((si: SharedRow) => others.find((p: OverlapRow) => p.id === si.promotion_id)?.name).filter(Boolean)
    );
    const productNames = new Set(
      shared.map((si: SharedRow) => productMap.get(si.product_id)?.name).filter(Boolean)
    );
    return `${productNames.size} product(s) already in active promo(s): ${[...promoNames].join(", ")}. Products may receive double discounts.`;
  };

  const handleSave = async () => {
    if (!orgId || !formName.trim() || !formEnd || selectedProductIds.size === 0) return;
    const discountNum = parseFloat(formDiscount);
    if (isNaN(discountNum) || discountNum <= 0 || discountNum > 100) return;
    setSaving(true);

    const warning = await checkOverlaps();
    if (warning) {
      setOverlapWarning(warning);
      if (!window.confirm(`⚠ Overlap detected\n\n${warning}\n\nSave anyway?`)) {
        setSaving(false);
        return;
      }
    }
    setOverlapWarning(null);

    try {
      if (editPromo) {
        await db.from("promotions").update({
          name: formName.trim(),
          discount_percent: discountNum,
          start_date: formStart,
          end_date: formEnd,
        }).eq("id", editPromo.id);

        await db.from("promotion_items").delete().eq("promotion_id", editPromo.id);
        const rows = Array.from(selectedProductIds).map((pid) => ({
          promotion_id: editPromo.id,
          product_id: pid,
        }));
        if (rows.length > 0) {
          await db.from("promotion_items").insert(rows);
        }
      } else {
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

  const endPromotion = async (id: string) => {
    await db.from("promotions").update({ active: false }).eq("id", id);
    fetchData();
  };

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

  /* ================================================================ */
  /*  Combos                                                           */
  /* ================================================================ */

  const openComboCreate = () => {
    setComboFormName("");
    setComboFormPrice("");
    setComboSelectedProductIds(new Set());
    setComboProductSearch("");
    setEditCombo(null);
    setShowComboCreate(true);
  };

  const openComboEdit = (c: Combo) => {
    setComboFormName(c.name);
    setComboFormPrice(String(c.combo_price));
    setComboSelectedProductIds(new Set(comboItems[c.id] ?? []));
    setComboProductSearch("");
    setEditCombo(c);
    setShowComboCreate(true);
  };

  const handleComboSave = async () => {
    if (!orgId || !comboFormName.trim() || comboSelectedProductIds.size !== 2) return;
    const priceNum = parseFloat(comboFormPrice);
    if (isNaN(priceNum) || priceNum < 0) return;
    setComboSaving(true);
    try {
      if (editCombo) {
        await db.from("combos").update({
          name: comboFormName.trim(),
          combo_price: priceNum,
        }).eq("id", editCombo.id);

        await db.from("combo_items").delete().eq("combo_id", editCombo.id);
        const rows = Array.from(comboSelectedProductIds).map((pid) => ({
          combo_id: editCombo.id,
          product_id: pid,
        }));
        await db.from("combo_items").insert(rows);
      } else {
        const { data: newCombo, error } = await db
          .from("combos")
          .insert({ org_id: orgId, name: comboFormName.trim(), combo_price: priceNum })
          .select("id")
          .single();
        if (error) throw error;
        const rows = Array.from(comboSelectedProductIds).map((pid) => ({
          combo_id: newCombo.id,
          product_id: pid,
        }));
        await db.from("combo_items").insert(rows);
      }
      setShowComboCreate(false);
      fetchData();
    } finally {
      setComboSaving(false);
    }
  };

  const toggleComboActive = async (c: Combo) => {
    await db.from("combos").update({ active: !c.active }).eq("id", c.id);
    fetchData();
  };

  const handleComboDelete = async (c: Combo) => {
    if (!window.confirm(`Delete "${c.name}"? This can't be undone.`)) return;
    await db.from("combos").delete().eq("id", c.id);
    fetchData();
  };

  const filteredComboProducts = products.filter((p) => {
    if (!comboProductSearch.trim()) return true;
    const q = comboProductSearch.toLowerCase();
    return p.name.toLowerCase().includes(q) || p.inventory_id.toLowerCase().includes(q);
  });

  const toggleComboProduct = (id: string) => {
    setComboSelectedProductIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        // A combo is exactly two products — picking a third replaces the
        // first one picked rather than growing past two.
        if (next.size >= 2) {
          const [first] = next;
          next.delete(first);
        }
        next.add(id);
      }
      return next;
    });
  };

  const comboSelectedTotal = Array.from(comboSelectedProductIds).reduce(
    (sum, pid) => sum + (productMap.get(pid)?.selling_price ?? 0),
    0
  );

  /* ---- render ---- */
  if (loading) {
    return (
      <div className="p-6 text-center text-gray-500">Loading…</div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {tab === "promotions" ? (
            <Percent className="w-6 h-6 text-green-600" />
          ) : (
            <Layers className="w-6 h-6 text-green-600" />
          )}
          <h1 className="text-xl font-bold text-gray-900">Promotions</h1>
        </div>
        {tab === "promotions" ? (
          <Button onClick={openCreate}>
            <Plus className="w-4 h-4 mr-1" /> New Promotion
          </Button>
        ) : (
          <Button onClick={openComboCreate}>
            <Plus className="w-4 h-4 mr-1" /> New Combo
          </Button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200">
        <button
          onClick={() => setTab("promotions")}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            tab === "promotions"
              ? "border-green-600 text-green-700"
              : "border-transparent text-gray-500 hover:text-gray-700"
          }`}
        >
          Promotions
        </button>
        <button
          onClick={() => setTab("combos")}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            tab === "combos"
              ? "border-green-600 text-green-700"
              : "border-transparent text-gray-500 hover:text-gray-700"
          }`}
        >
          Combos
        </button>
      </div>

      {/* ================================================================ */}
      {/* Promotions tab                                                    */}
      {/* ================================================================ */}
      {tab === "promotions" && (
        <>
          {promotions.length === 0 && (
            <div className="text-center py-16 text-gray-500">
              <Percent className="w-12 h-12 mx-auto mb-3 text-gray-300" />
              <p className="text-lg font-medium">No promotions yet</p>
              <p className="text-sm mt-1">Create a promotion to offer temporary discounts on selected products.</p>
            </div>
          )}

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
        </>
      )}

      {/* ================================================================ */}
      {/* Combos tab                                                        */}
      {/* ================================================================ */}
      {tab === "combos" && (
        <>
          <p className="text-sm text-gray-500">
            Bundle two products at a fixed price. Cashiers tap the combo tile at the till to add both at once —
            it never applies automatically just because both items happen to be in the cart.
          </p>

          {combos.length === 0 && (
            <div className="text-center py-16 text-gray-500">
              <Layers className="w-12 h-12 mx-auto mb-3 text-gray-300" />
              <p className="text-lg font-medium">No combos yet</p>
              <p className="text-sm mt-1">Create a combo to bundle two products at a discounted fixed price.</p>
            </div>
          )}

          <div className="grid gap-4">
            {combos.map((c) => {
              const itemIds = comboItems[c.id] ?? [];
              const normalTotal = itemIds.reduce((sum, pid) => sum + (productMap.get(pid)?.selling_price ?? 0), 0);
              const savings = normalTotal - c.combo_price;
              return (
                <div
                  key={c.id}
                  className="bg-white rounded-xl border border-gray-200 p-5 space-y-3 hover:shadow-sm transition-shadow"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="font-semibold text-gray-900">{c.name}</h3>
                      <p className="text-sm text-gray-500 mt-0.5">
                        {formatMoney(c.combo_price)}
                        {normalTotal > 0 && (
                          <>
                            <span className="line-through text-gray-400 ml-2">{formatMoney(normalTotal)}</span>
                            {savings > 0 && <span className="text-green-700 ml-2">save {formatMoney(savings)}</span>}
                          </>
                        )}
                      </p>
                    </div>
                    <Badge color={c.active ? "green" : "gray"}>{c.active ? "Active" : "Inactive"}</Badge>
                  </div>

                  {itemIds.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {itemIds.map((pid) => {
                        const prod = productMap.get(pid);
                        return prod ? (
                          <span key={pid} className="inline-block text-xs bg-gray-100 text-gray-700 rounded-full px-2.5 py-0.5">
                            {prod.name}
                          </span>
                        ) : (
                          <span key={pid} className="inline-block text-xs bg-red-50 text-red-600 rounded-full px-2.5 py-0.5">
                            Unknown product
                          </span>
                        );
                      })}
                    </div>
                  )}

                  <div className="flex items-center gap-2 pt-1">
                    <Button size="sm" variant="ghost" onClick={() => openComboEdit(c)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => toggleComboActive(c)}>
                      {c.active ? "Deactivate" : "Activate"}
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => handleComboDelete(c)}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ============================================================ */}
      {/* Promotion: view modal — full product list                     */}
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
      {/* Promotion: create / edit modal                                 */}
      {/* ============================================================ */}
      <Modal open={showCreate} onClose={() => setShowCreate(false)} title={editPromo ? "Edit Promotion" : "New Promotion"} wide>
        <div className="space-y-5">
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

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Select Products ({selectedProductIds.size} selected)
            </label>

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

      {/* ============================================================ */}
      {/* Combo: create / edit modal                                     */}
      {/* ============================================================ */}
      <Modal open={showComboCreate} onClose={() => setShowComboCreate(false)} title={editCombo ? "Edit Combo" : "New Combo"} wide>
        <div className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Combo Name</label>
            <input
              type="text"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-green-500 focus:border-transparent"
              placeholder="e.g. Burger + Drink"
              value={comboFormName}
              onChange={(e) => setComboFormName(e.target.value)}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Pick exactly two products ({comboSelectedProductIds.size} of 2 selected)
            </label>

            {comboSelectedProductIds.size > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {Array.from(comboSelectedProductIds).map((pid) => {
                  const prod = productMap.get(pid);
                  if (!prod) return null;
                  return (
                    <span key={pid} className="inline-flex items-center gap-1 text-xs bg-green-100 text-green-800 rounded-full px-2.5 py-1">
                      {prod.name}
                      <button onClick={() => toggleComboProduct(pid)} className="hover:text-red-600">
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  );
                })}
              </div>
            )}

            <div className="relative mb-2">
              <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
              <input
                type="text"
                className="w-full border border-gray-300 rounded-lg pl-9 pr-3 py-2 text-sm focus:ring-2 focus:ring-green-500 focus:border-transparent"
                placeholder="Search products…"
                value={comboProductSearch}
                onChange={(e) => setComboProductSearch(e.target.value)}
              />
            </div>

            <div className="border border-gray-200 rounded-lg max-h-48 overflow-y-auto divide-y">
              {filteredComboProducts.slice(0, 100).map((p) => {
                const checked = comboSelectedProductIds.has(p.id);
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
                        onChange={() => toggleComboProduct(p.id)}
                        className="rounded border-gray-300 text-green-600 focus:ring-green-500"
                      />
                      <span>{p.name}</span>
                      <span className="text-gray-400 text-xs">{p.inventory_id}</span>
                    </div>
                    <span className="text-gray-500 whitespace-nowrap">{formatMoney(p.selling_price)}</span>
                  </label>
                );
              })}
              {filteredComboProducts.length > 100 && (
                <div className="px-3 py-2 text-xs text-gray-400 text-center">
                  Showing first 100 of {filteredComboProducts.length} — narrow your search
                </div>
              )}
              {filteredComboProducts.length === 0 && (
                <div className="px-3 py-4 text-sm text-gray-400 text-center">No products found</div>
              )}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Combo Price</label>
            <div className="relative w-40">
              <input
                type="number"
                min={0}
                step={0.01}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-green-500 focus:border-transparent"
                placeholder="0.00"
                value={comboFormPrice}
                onChange={(e) => setComboFormPrice(e.target.value)}
              />
            </div>
            {comboSelectedTotal > 0 && (
              <p className="text-xs text-gray-500 mt-1">
                Normal combined price: {formatMoney(comboSelectedTotal)}
                {comboFormPrice && !isNaN(parseFloat(comboFormPrice)) && (
                  <span className="ml-1">
                    — {parseFloat(comboFormPrice) < comboSelectedTotal ? `saves ${formatMoney(comboSelectedTotal - parseFloat(comboFormPrice))}` : "no discount vs. buying separately"}
                  </span>
                )}
              </p>
            )}
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={() => setShowComboCreate(false)}>Cancel</Button>
            <Button
              onClick={handleComboSave}
              loading={comboSaving}
              disabled={!comboFormName.trim() || comboSelectedProductIds.size !== 2 || !comboFormPrice}
            >
              {editCombo ? "Update Combo" : "Create Combo"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
