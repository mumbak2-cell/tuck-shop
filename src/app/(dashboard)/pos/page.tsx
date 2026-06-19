"use client";
import { useEffect, useState, useCallback } from "react";
import { db } from "@/lib/supabase";
import { Product } from "@/types/database";
import { ProductGrid } from "@/components/pos/product-grid";
import { Cart, CartItem } from "@/components/pos/cart";
import { PaymentModal } from "@/components/pos/payment-modal";
import { useShift } from "@/lib/shift-context";
import { useOrg } from "@/lib/org-context";
import { Play } from "lucide-react";
import Link from "next/link";

export default function POSPage() {
  const { isOpen, loading: shiftLoading } = useShift();
  const { requiresShift } = useOrg();
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [showPayment, setShowPayment] = useState(false);

  const fetchProducts = useCallback(async () => {
    const { data } = await db
      .from("products")
      .select("*")
      .eq("discontinued", false)
      .gt("opening_stock", 0)
      .order("name");
    setProducts(data || []);
  }, []);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  function addToCart(product: Product) {
    setCart((prev) => {
      const existing = prev.find((i) => i.productId === product.id);
      if (existing) {
        return prev.map((i) =>
          i.productId === product.id ? { ...i, quantity: i.quantity + 1 } : i
        );
      }
      return [
        ...prev,
        {
          productId: product.id,
          name: product.name,
          unitPrice: product.selling_price,
          quantity: 1,
        },
      ];
    });
  }

  function updateQty(productId: string, delta: number) {
    setCart((prev) =>
      prev
        .map((i) =>
          i.productId === productId ? { ...i, quantity: Math.max(0, i.quantity + delta) } : i
        )
        .filter((i) => i.quantity > 0)
    );
  }

  function removeItem(productId: string) {
    setCart((prev) => prev.filter((i) => i.productId !== productId));
  }

  function clearCart() {
    setCart([]);
  }

  function handleSaleComplete() {
    setShowPayment(false);
    setCart([]);
    fetchProducts(); // Refresh stock levels
  }

  const total = cart.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);

  if (shiftLoading) {
    return <div className="text-center py-12 text-gray-400">Loading...</div>;
  }

  // Shift gate only applies when the operator has opted into the shift workflow.
  if (requiresShift && !isOpen) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <div className="w-16 h-16 bg-amber-100 rounded-full flex items-center justify-center mb-4">
          <Play className="w-8 h-8 text-amber-600" />
        </div>
        <h2 className="text-xl font-bold text-gray-900 mb-2">No shift open</h2>
        <p className="text-sm text-gray-500 mb-6">You need to start a shift before making sales.</p>
        <Link
          href="/shift"
          className="inline-flex items-center gap-2 px-6 py-3 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 transition-colors"
        >
          <Play className="w-5 h-5" />
          Open Shift
        </Link>
      </div>
    );
  }

  return (
    <div className="flex gap-4 h-[calc(100vh-6rem)]">
      {/* Left: Product grid */}
      <div className="flex-1 min-w-0">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">Point of Sale</h1>
        <ProductGrid products={products} onAddToCart={addToCart} />
      </div>

      {/* Right: Cart */}
      <div className="w-80 flex-shrink-0 lg:w-96">
        <Cart
          items={cart}
          onUpdateQty={updateQty}
          onRemove={removeItem}
          onClear={clearCart}
          onCheckout={() => setShowPayment(true)}
        />
      </div>

      {/* Payment modal */}
      <PaymentModal
        open={showPayment}
        onClose={() => setShowPayment(false)}
        items={cart}
        total={total}
        onComplete={handleSaleComplete}
      />
    </div>
  );
}
