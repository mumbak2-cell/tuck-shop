"use client";
// POS product grid built for high-SKU operators (1,000+ products).
//
// Layout (desktop / tablet):
//   [vertical category sidebar] | [search bar] [responsive product grid]
//
// On mobile, the category sidebar collapses to a horizontal scroll above the
// products. The search bar filters by product name OR inventory_id (case
// insensitive) and runs together with the category filter so the cashier can
// drill from 1,300 → 200 → 5 products in two taps and one search.

import { useEffect, useState, useMemo, useRef } from "react";
import { Product } from "@/types/database";
import { formatMoney } from "@/lib/format";
import { db } from "@/lib/supabase";
import { Search, X, LayoutGrid } from "lucide-react";

interface Props {
  products: Product[];
  onAddToCart: (product: Product) => void;
  discountMap?: Map<string, number>;
  /** Called after barcode auto-add clears the search. */
  onBarcodeAutoAdd?: () => void;
}

interface CategoryRow {
  name: string;
  sort_order: number;
}

const ALL_TAB = "__all__";

export function ProductGrid({ products, onAddToCart, discountMap, onBarcodeAutoAdd }: Props) {
  const [categories, setCategories] = useState<string[]>([]);
  const [activeCategory, setActiveCategory] = useState<string>(ALL_TAB);
  const [search, setSearch] = useState("");

  useEffect(() => {
    (async () => {
      // Pull the org's explicit category list for sort_order if it exists.
      // Operators who imported products via CSV may have no rows here — in
      // that case we fall back to deriving categories from the products
      // themselves so the sidebar still works.
      const { data } = await db
        .from("categories")
        .select("name, sort_order")
        .eq("active", true)
        .order("sort_order");
      const names = ((data as CategoryRow[]) || [])
        .map((c) => c.name)
        // Hide Ingredients from POS — they are raw materials, not sellable
        .filter((n) => n !== "Ingredients");
      setCategories(names);
    })();
  }, []);

  // Compute counts per category — derived from products, so search-bar typing
  // doesn't change them (categories are absolute, not relative to search).
  const liveProducts = useMemo(
    () => products.filter((p) => !p.discontinued && p.category !== "Ingredients"),
    [products]
  );
  const totalCount = liveProducts.length;
  const countByCategory = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of liveProducts) {
      const cat = (p.category || "Uncategorised").trim() || "Uncategorised";
      m.set(cat, (m.get(cat) || 0) + 1);
    }
    return m;
  }, [liveProducts]);

  // Show every category that has at least one product. If the categories
  // table is populated, honour its sort order; otherwise fall back to an
  // alphabetical list pulled straight from the products.
  const visibleCategories = useMemo(() => {
    const productCats = new Set<string>(countByCategory.keys());
    const fromSorted = categories.filter((c) => productCats.has(c));
    const known = new Set(fromSorted);
    // Anything in products but not in the categories table — append at the
    // end alphabetically so it still appears.
    const leftovers = [...productCats]
      .filter((c) => !known.has(c))
      .sort((a, b) => a.localeCompare(b));
    return [...fromSorted, ...leftovers];
  }, [categories, countByCategory]);

  // Filter products by category, then by search term.
  const searchLower = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    let list = activeCategory === ALL_TAB
      ? liveProducts
      : liveProducts.filter((p) => {
          const cat = (p.category || "Uncategorised").trim() || "Uncategorised";
          return cat === activeCategory;
        });
    if (searchLower) {
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(searchLower) ||
          (p.inventory_id && p.inventory_id.toLowerCase().includes(searchLower))
      );
    }
    return list;
  }, [liveProducts, activeCategory, searchLower]);

  // L2: Barcode scan auto-add. When the search box contains an exact
  // inventory_id match against a single product, auto-add it to the cart and
  // clear the search. A small delay (400ms) prevents firing while the user
  // is still typing or while a barcode scanner is streaming characters.
  const autoAddTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (autoAddTimer.current) clearTimeout(autoAddTimer.current);
    if (!searchLower) return;

    autoAddTimer.current = setTimeout(() => {
      const exactMatch = liveProducts.filter(
        (p) => p.inventory_id && p.inventory_id.toLowerCase() === searchLower
      );
      if (exactMatch.length === 1) {
        onAddToCart(exactMatch[0]);
        setSearch("");
        onBarcodeAutoAdd?.();
      }
    }, 400);

    return () => {
      if (autoAddTimer.current) clearTimeout(autoAddTimer.current);
    };
  }, [searchLower, liveProducts, onAddToCart, onBarcodeAutoAdd]);

  // Cap the number of rendered products to avoid jank when search is empty and
  // catalogue is huge. Anything past the cap is reachable via search/category.
  const RENDER_CAP = 200;
  const renderList = filtered.slice(0, RENDER_CAP);
  const cappedHidden = Math.max(0, filtered.length - RENDER_CAP);

  return (
    <div className="flex flex-col lg:flex-row gap-3 h-full min-h-0">
      {/* ── Category sidebar (vertical on desktop, horizontal scroll on mobile) ── */}
      <div className="lg:w-48 lg:flex-shrink-0 lg:overflow-y-auto">
        <div className="flex lg:flex-col gap-2 overflow-x-auto lg:overflow-x-visible scrollbar-hide pb-1 lg:pb-0">
          <CategoryButton
            label="All"
            count={totalCount}
            active={activeCategory === ALL_TAB}
            onClick={() => setActiveCategory(ALL_TAB)}
            icon={<LayoutGrid className="w-4 h-4" />}
          />
          {visibleCategories.map((cat) => (
            <CategoryButton
              key={cat}
              label={cat}
              count={countByCategory.get(cat) || 0}
              active={activeCategory === cat}
              onClick={() => setActiveCategory(cat)}
            />
          ))}
        </div>
      </div>

      {/* ── Search bar + product grid ── */}
      <div className="flex-1 flex flex-col min-h-0">
        <div className="relative mb-3 flex-shrink-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${totalCount} products by name or ID...`}
            aria-label="Search products by name or barcode"
            role="searchbox"
            className="w-full pl-10 pr-10 py-3 bg-white border border-gray-200 rounded-lg text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-gray-400 hover:text-gray-700"
              aria-label="Clear search"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="text-center text-gray-400 py-16">
              {totalCount === 0
                ? "No products available yet. Add products with stock above zero, then refresh."
                : searchLower
                ? `No products match "${search}" in ${activeCategory === ALL_TAB ? "the catalogue" : activeCategory}.`
                : "No products in this category"}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2" role="list" aria-label="Products">
                {renderList.map((product) => {
                  const discountPct = discountMap?.get(product.id) ?? 0;
                  const hasDiscount = discountPct > 0;
                  const salePrice = hasDiscount
                    ? Math.round(product.selling_price * (1 - discountPct / 100) * 100) / 100
                    : product.selling_price;
                  return (
                    <button
                      key={product.id}
                      onClick={() => onAddToCart(product)}
                      aria-label={`Add ${product.name} to cart, ${formatMoney(hasDiscount ? salePrice : product.selling_price)}`}
                      role="listitem"
                      className={`flex flex-col items-center justify-center p-3 border rounded-xl hover:shadow-md active:scale-95 transition-all min-h-[90px] touch-manipulation ${
                        hasDiscount
                          ? "bg-red-50 border-red-200 hover:border-red-400"
                          : "bg-white border-gray-200 hover:border-green-400"
                      }`}
                    >
                      <span className="text-xs font-medium text-gray-900 text-center leading-tight line-clamp-2">
                        {product.name}
                      </span>
                      {hasDiscount ? (
                        <div className="flex flex-col items-center mt-1">
                          <span className="text-[10px] line-through text-gray-400">
                            {formatMoney(product.selling_price)}
                          </span>
                          <span className="text-base font-bold text-red-600">
                            {formatMoney(salePrice)}
                          </span>
                          <span className="text-[10px] font-semibold text-red-500">-{discountPct}%</span>
                        </div>
                      ) : (
                        <span className="text-base font-bold text-green-700 mt-1.5">
                          {formatMoney(product.selling_price)}
                        </span>
                      )}
                      {product.is_prepared && (
                        <span className="text-[10px] text-blue-600 mt-0.5">Prepared</span>
                      )}
                    </button>
                  );
                })}
              </div>
              {cappedHidden > 0 && (
                <p className="text-center text-xs text-gray-400 mt-3">
                  Showing first {RENDER_CAP} of {filtered.length} matches. Use search or pick a
                  category to narrow down.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function CategoryButton({
  label,
  count,
  active,
  onClick,
  icon,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={`${label} category, ${count} items`}
      aria-pressed={active}
      className={`flex-shrink-0 lg:w-full text-left px-3 py-3 rounded-xl border-2 transition-colors touch-manipulation ${
        active
          ? "bg-green-600 text-white border-green-600 shadow-md"
          : "bg-amber-50 border-amber-100 text-gray-800 hover:bg-amber-100"
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        {icon && <span className="flex-shrink-0">{icon}</span>}
        <span className="font-semibold text-sm truncate">{label}</span>
      </div>
      <p className={`text-xs mt-0.5 ${active ? "text-green-50" : "text-gray-500"}`}>
        {count} {count === 1 ? "item" : "items"}
      </p>
    </button>
  );
}
