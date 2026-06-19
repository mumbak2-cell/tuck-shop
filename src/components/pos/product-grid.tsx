"use client";
import { useEffect, useState } from "react";
import { Product } from "@/types/database";
import { formatMoney } from "@/lib/format";
import { db } from "@/lib/supabase";

interface Props {
  products: Product[];
  onAddToCart: (product: Product) => void;
}

interface CategoryRow {
  name: string;
  sort_order: number;
}

const ALL_TAB = "__all__";

export function ProductGrid({ products, onAddToCart }: Props) {
  const [categories, setCategories] = useState<string[]>([]);
  const [activeCategory, setActiveCategory] = useState<string>(ALL_TAB);

  // Load this org's categories (RLS scopes automatically)
  useEffect(() => {
    (async () => {
      const { data } = await db
        .from("categories")
        .select("name, sort_order")
        .eq("active", true)
        .order("sort_order");
      const names = ((data as CategoryRow[]) || [])
        .map((c) => c.name)
        // Hide Ingredients from POS - they are raw materials, not sellable
        .filter((n) => n !== "Ingredients");
      setCategories(names);
    })();
  }, []);

  // When categories load, default the active tab to "All" so every product is shown.
  // The operator can narrow down by tapping a category tab.

  const filtered =
    activeCategory === ALL_TAB
      ? products.filter((p) => !p.discontinued && p.category !== "Ingredients")
      : products.filter((p) => p.category === activeCategory && !p.discontinued);

  // Only render a category tab if at least one product in that category exists
  const visibleCategories = categories.filter(
    (cat) => products.some((p) => p.category === cat && !p.discontinued)
  );

  const totalCount = products.filter((p) => !p.discontinued && p.category !== "Ingredients").length;

  return (
    <div className="flex flex-col h-full">
      {/* Category tabs */}
      <div className="flex gap-1 overflow-x-auto pb-2 mb-3 border-b border-gray-200 scrollbar-hide">
        <button
          onClick={() => setActiveCategory(ALL_TAB)}
          className={`flex-shrink-0 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
            activeCategory === ALL_TAB
              ? "bg-green-600 text-white"
              : "bg-gray-100 text-gray-700 hover:bg-gray-200"
          }`}
        >
          All
          <span className="ml-1.5 text-xs opacity-70">({totalCount})</span>
        </button>
        {visibleCategories.map((cat) => {
          const count = products.filter((p) => p.category === cat && !p.discontinued).length;
          return (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className={`flex-shrink-0 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                activeCategory === cat
                  ? "bg-green-600 text-white"
                  : "bg-gray-100 text-gray-700 hover:bg-gray-200"
              }`}
            >
              {cat}
              <span className="ml-1.5 text-xs opacity-70">({count})</span>
            </button>
          );
        })}
      </div>

      {/* Product grid — large touch targets */}
      <div className="flex-1 overflow-y-auto">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          {filtered.map((product) => (
            <button
              key={product.id}
              onClick={() => onAddToCart(product)}
              className="flex flex-col items-center justify-center p-4 bg-white border border-gray-200 rounded-xl hover:border-green-400 hover:shadow-md active:scale-95 transition-all min-h-[100px] touch-manipulation"
            >
              <span className="text-sm font-medium text-gray-900 text-center leading-tight">
                {product.name}
              </span>
              <span className="text-lg font-bold text-green-700 mt-2">
                {formatMoney(product.selling_price)}
              </span>
              {product.is_prepared && (
                <span className="text-xs text-blue-600 mt-1">Prepared</span>
              )}
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="col-span-full text-center text-gray-400 py-12">
              {totalCount === 0
                ? "No products available yet. Add products with stock above zero, then refresh."
                : "No products in this category"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
