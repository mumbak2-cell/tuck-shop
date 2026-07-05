"use client";
import { formatZAR } from "@/lib/format";
import { Minus, Plus, Trash2, ShoppingCart, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface CartItem {
  productId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  /** Cost per unit snapshot at add-to-cart time. */
  costPrice: number;
  /** Available stock at the current location (H8: stock warning, not a block). */
  availableStock?: number;
}

interface Props {
  items: CartItem[];
  onUpdateQty: (productId: string, delta: number) => void;
  onRemove: (productId: string) => void;
  onClear: () => void;
  onCheckout: () => void;
}

export function Cart({ items, onUpdateQty, onRemove, onClear, onCheckout }: Props) {
  const total = items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
  const itemCount = items.reduce((sum, i) => sum + i.quantity, 0);

  return (
    <div className="flex flex-col h-full bg-white rounded-xl border border-gray-200">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
        <div className="flex items-center gap-2">
          <ShoppingCart className="w-5 h-5 text-green-600" />
          <h2 className="font-semibold text-gray-900">Cart</h2>
          {itemCount > 0 && (
            <span className="bg-green-600 text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center">
              {itemCount}
            </span>
          )}
        </div>
        {items.length > 0 && (
          <button onClick={onClear} className="text-xs text-red-500 hover:underline">
            Clear
          </button>
        )}
      </div>

      {/* Cart items */}
      <div className="flex-1 overflow-y-auto px-4 py-2">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-400">
            <ShoppingCart className="w-10 h-10 mb-2 opacity-30" />
            <p className="text-sm">Tap a product to add it</p>
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((item) => (
              <div
                key={item.productId}
                className="flex items-center gap-3 py-2 border-b border-gray-100 last:border-0"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{item.name}</p>
                  <p className="text-xs text-gray-500">
                    {formatZAR(item.unitPrice)} each
                  </p>
                  {/* H8 fix: warn when cart quantity exceeds available stock */}
                  {item.availableStock != null && item.quantity > item.availableStock && (
                    <p className="text-xs text-amber-600 flex items-center gap-1 mt-0.5">
                      <AlertTriangle className="w-3 h-3" />
                      Only {item.availableStock} in stock
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => onUpdateQty(item.productId, -1)}
                    className="w-8 h-8 flex items-center justify-center rounded-lg bg-gray-100 hover:bg-gray-200 active:bg-gray-300 touch-manipulation"
                  >
                    <Minus className="w-4 h-4" />
                  </button>
                  <span className="w-8 text-center text-sm font-semibold">{item.quantity}</span>
                  <button
                    onClick={() => onUpdateQty(item.productId, 1)}
                    className="w-8 h-8 flex items-center justify-center rounded-lg bg-gray-100 hover:bg-gray-200 active:bg-gray-300 touch-manipulation"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
                <div className="text-right w-16">
                  <p className="text-sm font-semibold">{formatZAR(item.unitPrice * item.quantity)}</p>
                </div>
                <button
                  onClick={() => onRemove(item.productId)}
                  className="p-1 text-gray-400 hover:text-red-500 touch-manipulation"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Total and checkout */}
      <div className="border-t border-gray-200 px-4 py-3 space-y-3">
        <div className="flex justify-between items-center">
          <span className="text-gray-600 font-medium">Total</span>
          <span className="text-2xl font-bold text-gray-900">{formatZAR(total)}</span>
        </div>
        <Button
          onClick={onCheckout}
          disabled={items.length === 0}
          size="lg"
          className="w-full text-base py-4"
        >
          Charge {formatZAR(total)}
        </Button>
      </div>
    </div>
  );
}
