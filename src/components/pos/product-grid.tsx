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

import { useEffect, useLayoutEffect, useState, useMemo } from "react";
import { Product } from "@/types/database";
import { formatMoney } from "@/lib/format";
import { db } from "@/lib/supabase";
import { Search, X, LayoutGrid, List } from "lucide-react";

interface Props {
  products: Product[];
  onAddToCart: (product: Product) => void;
  discountMap?: Map<string, number>;
  /** Called after barcode auto-add clears the search. */
  onBarcodeAutoAdd?: () => void;
  /** Active location name — shown in the empty state so an empty grid caused
   *  by being on the wrong branch is self-explanatory. */
  locationName?: string | null;
  /** True when the org has more than one location, so the empty state can
   *  suggest switching branches rather than only receiving stock. */
  hasMultipleLocations?: boolean;
}

interface CategoryRow {
  name: string;
  sort_order: number;
}

const ALL_TAB = "__all__";

/** At or below this many units left, the tile warns the cashier. The grid only
 *  shows items with stock above zero, so the badge covers 5 down to 1 — at zero
 *  the item leaves the grid entirely, which is its own (existing) signal. */
const LOW_STOCK_AT = 5;

export function ProductGrid({ products, onAddToCart, discountMap, onBarcodeAutoAdd, locationName, hasMultipleLocations }: Props) {
  const [categories, setCategories] = useState<string[]>([]);
  const [activeCategory, setActiveCategory] = useState<string>(ALL_TAB);
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

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
  // inventory_id match against a single product, add it to the cart and
  // clear the search immediately — no artificial delay.
  //
  // This used to wait 400ms of quiet before deciding a scan was complete,
  // to avoid firing mid-scan while a barcode scanner was still streaming
  // characters in. But an exact match against exactly one product is
  // already unambiguous the instant it happens — waiting doesn't make it
  // any more certain, it only opens a window where a SECOND scan's
  // keystrokes can land in the box before the delayed clear runs, append
  // onto the first code instead of starting fresh, and silently match
  // nothing at all. Confirmed: two scans of the same item ~200ms apart
  // lost the second scan entirely — no error, no charge for that unit,
  // just a garbled leftover string sitting in the search box.
  //
  // useLayoutEffect (not useEffect) so the match is detected synchronously
  // with the render that produced it, before the browser can process any
  // further queued keyboard event. The state update itself goes through
  // queueMicrotask rather than running directly in the effect body — a
  // microtask still fully drains before the next queued event (so the
  // timing guarantee against the old race is unchanged, just deferred by
  // a fraction of a millisecond), and it's the pattern react-hooks'
  // set-state-in-effect rule expects for a setState that belongs here.
  useLayoutEffect(() => {
    if (!searchLower) return;
    const exactMatch = liveProducts.filter(
      (p) => p.inventory_id && p.inventory_id.toLowerCase() === searchLower
    );
    if (exactMatch.length === 1) {
      queueMicrotask(() => {
        onAddToCart(exactMatch[0]);
        setSearch("");
        onBarcodeAutoAdd?.();
      });
    }
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
        <div className="flex gap-2 mb-3 flex-shrink-0">
          <div className="relative flex-1">
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
          <button
            onClick={() => setViewMode(viewMode === "grid" ? "list" : "grid")}
            aria-label={`Switch to ${viewMode === "grid" ? "list" : "grid"} view`}
            className={`flex-shrink-0 p-3 rounded-lg border transition-colors ${
              viewMode === "list"
                ? "bg-green-600 text-white border-green-600"
                : "bg-white text-gray-600 border-gray-200 hover:border-green-400"
            }`}
          >
            {viewMode === "grid" ? <List className="w-5 h-5" /> : <LayoutGrid className="w-5 h-5" />}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            totalCount === 0 ? (
              <div className="text-center text-gray-500 py-16 px-6 max-w-sm mx-auto">
                <LayoutGrid className="w-10 h-10 mx-auto mb-3 text-gray-300" />
                <p className="font-medium text-gray-700">
                  No items in stock{locationName ? ` at ${locationName}` : ""}
                </p>
                <p className="text-sm mt-1.5 text-gray-500">
                  {hasMultipleLocations
                    ? "Switch to another branch above, or receive stock for this one."
                    : "Receive stock (quantity above zero) for your items, then refresh."}
                </p>
              </div>
            ) : (
              <div className="text-center text-gray-400 py-16">
                {searchLower
                  ? `No products match "${search}" in ${activeCategory === ALL_TAB ? "the catalogue" : activeCategory}.`
                  : "No products in this category"}
              </div>
            )
          ) : (
            <>
              {viewMode === "grid" ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2" role="list" aria-label="Products">
                {renderList.map((product) => {
                  const discountPct = discountMap?.get(product.id) ?? 0;
                  const hasDiscount = discountPct > 0;
                  const salePrice = hasDiscount
                    ? Math.round(product.selling_price * (1 - discountPct / 100) * 100) / 100
                    : product.selling_price;
                  const unitsLeft = product.opening_stock ?? 0;
                  const isLow = unitsLeft > 0 && unitsLeft <= LOW_STOCK_AT;
                  return (
                    <button
                      key={product.id}
                      onClick={() => onAddToCart(product)}
                      aria-label={`Add ${product.name} to cart, ${formatMoney(hasDiscount ? salePrice : product.selling_price)}${isLow ? `, only ${unitsLeft} left` : ""}`}
                      role="listitem"
                      className={`flex flex-col items-center justify-center p-3 border rounded-xl hover:shadow-md active:scale-95 transition-all min-h-[90px] touch-manipulation ${
                        hasDiscount
                          ? "bg-red-50 border-red-200 hover:border-red-400"
                          : "bg-white border-gray-200 hover:border-green-400"
                      }`}
                    >
                      <span className="text-xs font-medium text-gray-900 text-center leading-tight line-clamp-3 sm:line-clamp-2">
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
                      {isLow && (
                        <span className="mt-0.5 rounded px-1.5 py-0.5 text-[10px] font-semibold bg-amber-100 text-amber-800">
                          {unitsLeft} left
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              ) : (
              <div className="flex flex-col gap-1" role="list" aria-label="Products">
                {renderList.map((product) => {
                  const discountPct = discountMap?.get(product.id) ?? 0;
                  const hasDiscount = discountPct > 0;
                  const salePrice = hasDiscount
                    ? Math.round(product.selling_price * (1 - discountPct / 100) * 100) / 100
                    : product.selling_price;
                  const unitsLeft = product.opening_stock ?? 0;
                  const isLow = unitsLeft > 0 && unitsLeft <= LOW_STOCK_AT;
                  return (
                    <button
                      key={product.id}
                      onClick={() => onAddToCart(product)}
                      aria-label={`Add ${product.name} to cart, ${formatMoney(hasDiscount ? salePrice : product.selling_price)}${isLow ? `, only ${unitsLeft} left` : ""}`}
                      role="listitem"
                      className={`flex items-center gap-3 px-3 py-2.5 border rounded-lg hover:shadow-sm active:scale-[0.99] transition-all touch-manipulation ${
                        hasDiscount
                          ? "bg-red-50 border-red-200 hover:border-red-400"
                          : "bg-white border-gray-200 hover:border-green-400"
                      }`}
                    >
                      <span className="flex-1 text-sm font-medium text-gray-900 text-left">
                        {product.name}
                      </span>
                      {product.is_prepared && (
                        <span className="text-[10px] text-blue-600 flex-shrink-0">Prepared</span>
                      )}
                      {isLow && (
                        <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold bg-amber-100 text-amber-800 flex-shrink-0">
                          {unitsLeft} left
                        </span>
                      )}
                      {hasDiscount ? (
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className="text-xs line-through text-gray-400">
                            {formatMoney(product.selling_price)}
                          </span>
                          <span className="text-sm font-bold text-red-600">
                            {formatMoney(salePrice)}
                          </span>
                          <span className="text-[10px] font-semibold text-red-500">-{discountPct}%</span>
                        </div>
                      ) : (
                        <span className="text-sm font-bold text-green-700 flex-shrink-0">
                          {formatMoney(product.selling_price)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              )}
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
