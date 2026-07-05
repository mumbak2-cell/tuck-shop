"use client";
import { useEffect, useState, useCallback } from "react";
import { db } from "@/lib/supabase";
import { Product } from "@/types/database";
import { ProductGrid } from "@/components/pos/product-grid";
import { Cart, CartItem } from "@/components/pos/cart";
import { PaymentModal } from "@/components/pos/payment-modal";
import { useShift } from "@/lib/shift-context";
import { useOrg } from "@/lib/org-context";
import { fetchAllPaged } from "@/lib/fetch-all";
import { readCache } from "@/lib/offline-store";
import { Play } from "lucide-react";
import Link from "next/link";

/** product_id → discount percent for currently active promotions */
type DiscountMap = Map<string, number>;

export default function POSPage() {
  const { isOpen, loading: shiftLoading } = useShift();
  const { requiresShift, currentLocationId, orgId } = useOrg();
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [showPayment, setShowPayment] = useState(false);
  const [discountMap, setDiscountMap] = useState<DiscountMap>(new Map());

  const fetchProducts = useCallback(async () => {
    // Cached fallback - shared between online-failure and offline paths.
    const fromCache = (): Product[] => {
      if (!orgId) return [];
      const cachedProducts = (readCache<Product>(orgId, "products") ?? []).filter((p) => !p.discontinued);
      const cachedStock = (readCache<{ product_id: string; quantity: number; location_id: string }>(orgId, "product_stock") ?? [])
        .filter((s) => !currentLocationId || s.location_id === currentLocationId);
      const stockMap = new Map<string, number>();
      cachedStock.forEach((s) => stockMap.set(s.product_id, s.quantity));
      if (stockMap.size > 0) {
        return cachedProducts
          .filter((p) => (stockMap.get(p.id) ?? 0) > 0)
          .map((p) => ({ ...p, opening_stock: stockMap.get(p.id) ?? 0 }));
      }
      return cachedProducts.filter((p) => p.opening_stock > 0);
    };

    // When offline, skip the network call entirely. Supabase requests hang
    // indefinitely on no-connection rather than rejecting, which would leave
    // the POS stuck on a loading state.
    if (!navigator.onLine) {
      setProducts(fromCache());
      return;
    }

    // Paginate via .range() so Supabase's max_rows ceiling doesn't truncate
    // catalogues above 1000 SKUs.
    let allProducts: Product[];
    try {
      allProducts = await fetchAllPaged<Product>(() =>
        db.from("products").select("*").eq("discontinued", false).order("name")
      );
    } catch {
      setProducts(fromCache());
      return;
    }

    // Filter to products that have stock at the CURRENT LOCATION (per-location
    // model). Falls back to the legacy org-wide opening_stock > 0 filter if
    // product_stock cannot be read (migration 024 not yet run on this DB).
    if (currentLocationId) {
      try {
        const stockRows = await fetchAllPaged<{ product_id: string; quantity: number }>(() =>
          db
            .from("product_stock")
            .select("product_id, quantity")
            .eq("location_id", currentLocationId)
            .gt("quantity", 0)
        );
        const sellableIds = new Set<string>(stockRows.map((r) => r.product_id));
        // Replace each product's opening_stock with its per-location quantity
        // so cart and stock-check downstream code reads the right number.
        const stockMap: Record<string, number> = {};
        stockRows.forEach((r) => {
          stockMap[r.product_id] = r.quantity;
        });
        const filtered = allProducts
          .filter((p) => sellableIds.has(p.id))
          .map((p) => ({ ...p, opening_stock: stockMap[p.id] ?? 0 }));
        setProducts(filtered.length > 0 ? filtered : fromCache());
        return;
      } catch {
        // fall through to legacy org-wide filter below
      }
    }

    // Fallback: legacy org-wide filter
    const filtered = allProducts.filter((p) => p.opening_stock > 0);
    setProducts(filtered.length > 0 ? filtered : fromCache());
  }, [currentLocationId, orgId]);

  // Fetch active promotions → build product discount map
  const fetchPromotions = useCallback(async () => {
    if (!orgId) return;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const { data: promos } = await db
        .from("promotions")
        .select("id, discount_percent")
        .eq("org_id", orgId)
        .eq("active", true)
        .lte("start_date", today)
        .gte("end_date", today);
      if (!promos || promos.length === 0) { setDiscountMap(new Map()); return; }
      const promoIds = promos.map((p: { id: string }) => p.id);
      const { data: items } = await db
        .from("promotion_items")
        .select("product_id, promotion_id")
        .in("promotion_id", promoIds);
      const discountByPromo = new Map<string, number>();
      for (const p of promos as { id: string; discount_percent: number }[]) {
        discountByPromo.set(p.id, p.discount_percent);
      }
      const map: DiscountMap = new Map();
      for (const it of (items ?? []) as { product_id: string; promotion_id: string }[]) {
        const pct = discountByPromo.get(it.promotion_id) ?? 0;
        // If a product is in multiple promotions, apply the highest discount
        const existing = map.get(it.product_id) ?? 0;
        if (pct > existing) map.set(it.product_id, pct);
      }
      setDiscountMap(map);
    } catch {
      // promotions table may not exist yet — silently ignore
      setDiscountMap(new Map());
    }
  }, [orgId]);

  useEffect(() => {
    fetchProducts();
    fetchPromotions();
  }, [fetchProducts, fetchPromotions]);

  function addToCart(product: Product) {
    const discountPct = discountMap.get(product.id) ?? 0;
    const effectivePrice = discountPct > 0
      ? Math.round(product.selling_price * (1 - discountPct / 100) * 100) / 100
      : product.selling_price;

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
          unitPrice: effectivePrice,
          quantity: 1,
          costPrice: product.cost_per_unit ?? 0,
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
    fetchProducts();
    fetchPromotions();
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
        <ProductGrid products={products} onAddToCart={addToCart} discountMap={discountMap} />
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
