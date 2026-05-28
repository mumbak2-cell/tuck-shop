"use client";
import { Product, CATEGORIES } from "@/types/database";
import { formatZAR } from "@/lib/format";
import { useState } from "react";

// POS-relevant categories (exclude Ingredients)
const POS_CATEGORIES = CATEGORIES.filter((c) => c !== "Ingredients");

interface Props {
  products: Product[];
  onAddToCart: (product: Product) => void;
}

export function ProductGrid({ products, onAddToCart }: Props) {
  const [activeCategory, setActiveCategory] = useState<string>(POS_CATEGORIES[0]);

  const filtered = products.filter(
    (p) => p.category === activeCategory && !p.discontinued
  );

  return (
    <div className="flex flex-col h-full">
      {/* Category tabs */}
      <div className="flex gap-1 overflow-x-auto pb-2 mb-3 border-b border-gray-200 scrollbar-hide">
        {POS_CATEGORIES.map((cat) => {
          const count = products.filter((p) => p.category === cat && !p.discontinued).length;
          if (count === 0) return null;
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
                {formatZAR(product.selling_price)}
              </span>
              {product.is_prepared && (
                <span className="text-xs text-blue-600 mt-1">Prepared</span>
              )}
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="col-span-full text-center text-gray-400 py-12">
              No products in this category
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
