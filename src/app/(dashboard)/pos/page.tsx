"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import { db } from "@/lib/supabase";
import { Product } from "@/types/database";
import { ProductGrid } from "@/components/pos/product-grid";
import { Cart, CartItem } from "@/components/pos/cart";
import { PaymentModal } from "@/components/pos/payment-modal";
import { useShift } from "@/lib/shift-context";
import { useOrg } from "@/lib/org-context";
import { fetchAllPaged } from "@/lib/fetch-all";
import { readCache } from "@/lib/offline-store";
import { formatZAR } from "@/lib/format";
import { useToast } from "@/components/ui/toast";
import { useParkedCount } from "@/lib/use-offline-sync";
import { Play, AlertTriangle, Layers } from "lucide-react";
import Link from "next/link";

/** product_id → discount percent for currently active promotions */
type DiscountMap = Map<string, number>;

/** A combo as stored in the DB — just the definition, not resolved against
 *  the current product/stock list yet (that happens at render time). */
interface ComboDef {
  id: string;
  name: string;
  combo_price: number;
  productIds: string[];
}

/** A combo actually offerable right now — both products exist at this
 *  location and have stock. Resolved from ComboDef + the current products
 *  list, same "no row unless there's something to sell" rule the rest of
 *  the POS already follows. */
interface ComboTile {
  id: string;
  name: string;
  combo_price: number;
  prodA: Product;
  prodB: Product;
  stock: number;
}

/**
 * Build a product_id → override-price map from per-location price rows,
 * keeping only rows for the current location. No location (or no rows) ⇒
 * empty map, so every product falls back to its base selling_price.
 */
function buildPriceMap(
  rows: { product_id: string; selling_price: number | string; location_id: string }[],
  locationId: string | null
): Map<string, number> {
  const m = new Map<string, number>();
  if (!locationId) return m;
  for (const r of rows) {
    if (r.location_id === locationId) m.set(r.product_id, Number(r.selling_price));
  }
  return m;
}

export default function POSPage() {
  const { isOpen, loading: shiftLoading } = useShift();
  const { requiresShift, currentLocationId, orgId, locations } = useOrg();
  const toast = useToast();
  const parkedCount = useParkedCount(orgId);
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [showPayment, setShowPayment] = useState(false);
  const [mobileCartOpen, setMobileCartOpen] = useState(false);
  const [discountMap, setDiscountMap] = useState<DiscountMap>(new Map());
  const [wholesaleEnabled, setWholesaleEnabled] = useState(false);
  const [combos, setCombos] = useState<ComboDef[]>([]);
  // FULL catalogue (before the per-location stock filter runs) so a barcode
  // scan or a name search can tell "this product doesn't exist" apart from
  // "it exists but has no stock here" and say so, instead of doing nothing
  // either way.
  const [catalogProducts, setCatalogProducts] = useState<Product[]>([]);
  const [outOfStockMessage, setOutOfStockMessage] = useState<string | null>(null);
  const outOfStockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchProducts = useCallback(async () => {
    // Cached fallback - shared between online-failure and offline paths.
    const fromCache = (): Product[] => {
      if (!orgId) return [];
      const cachedProducts = (readCache<Product>(orgId, "products") ?? []).filter((p) => !p.discontinued);
      // Per-branch price overrides for the current location; missing → base price.
      const priceMap = buildPriceMap(
        readCache<{ product_id: string; selling_price: number | string; location_id: string }>(orgId, "product_location_prices") ?? [],
        currentLocationId
      );
      const withBranchPrice = (p: Product): Product => {
        const o = priceMap.get(p.id);
        return o == null ? p : { ...p, selling_price: o };
      };
      const cachedStock = (readCache<{ product_id: string; quantity: number; location_id: string }>(orgId, "product_stock") ?? [])
        .filter((s) => !currentLocationId || s.location_id === currentLocationId);
      const stockMap = new Map<string, number>();
      cachedStock.forEach((s) => stockMap.set(s.product_id, s.quantity));
      if (stockMap.size > 0) {
        return cachedProducts
          .filter((p) => (stockMap.get(p.id) ?? 0) > 0)
          .map((p) => withBranchPrice({ ...p, opening_stock: stockMap.get(p.id) ?? 0 }));
      }
      return cachedProducts.filter((p) => p.opening_stock > 0).map(withBranchPrice);
    };

    // When offline, skip the network call entirely. Supabase requests hang
    // indefinitely on no-connection rather than rejecting, which would leave
    // the POS stuck on a loading state.
    if (!navigator.onLine) {
      setProducts(fromCache());
      toast.info("Offline — using cached products");
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
      toast.info("Could not load products — using cached data");
      return;
    }

    setCatalogProducts(allProducts);

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
        // Per-branch price overrides for this location. A read failure (e.g.
        // migration 042 not yet applied) degrades to base prices, never breaks
        // the POS load.
        const priceRows = await fetchAllPaged<{ product_id: string; selling_price: number | string }>(() =>
          db
            .from("product_location_prices")
            .select("product_id, selling_price")
            .eq("location_id", currentLocationId)
        ).catch(() => [] as { product_id: string; selling_price: number | string }[]);
        const priceMap = new Map<string, number>();
        priceRows.forEach((r) => priceMap.set(r.product_id, Number(r.selling_price)));

        const sellableIds = new Set<string>(stockRows.map((r) => r.product_id));
        // Replace each product's opening_stock with its per-location quantity
        // so cart and stock-check downstream code reads the right number, and
        // its selling_price with the branch override where one exists.
        const stockMap: Record<string, number> = {};
        stockRows.forEach((r) => {
          stockMap[r.product_id] = r.quantity;
        });
        const filtered = allProducts
          .filter((p) => sellableIds.has(p.id))
          .map((p) => {
            const override = priceMap.get(p.id);
            return {
              ...p,
              opening_stock: stockMap[p.id] ?? 0,
              ...(override != null ? { selling_price: override } : {}),
            };
          });
        if (filtered.length > 0) {
          setProducts(filtered);
        } else {
          setProducts(fromCache());
          toast.info("No stock at this branch — showing cached products");
        }
        return;
      } catch {
        toast.info("Could not check branch stock — using cached data");
        // fall through to legacy org-wide filter below
      }
    }

    // Fallback: legacy org-wide filter
    const filtered = allProducts.filter((p) => p.opening_stock > 0);
    if (filtered.length > 0) {
      setProducts(filtered);
    } else {
      setProducts(fromCache());
      toast.info("No stock at this branch — showing cached products");
    }
  }, [currentLocationId, orgId, toast]);

  // Fetch active promotions → build product discount map.
  // Returns the new map so callers can use it immediately (React state
  // updates are async and won't be visible in the same tick).
  const fetchPromotions = useCallback(async (): Promise<DiscountMap> => {
    const empty: DiscountMap = new Map();
    if (!orgId || !navigator.onLine) return empty;
    try {
      const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in local tz
      const { data: promos } = await db
        .from("promotions")
        .select("id, discount_percent")
        .eq("org_id", orgId)
        .eq("active", true)
        .lte("start_date", today)
        .gte("end_date", today);
      if (!promos || promos.length === 0) { setDiscountMap(empty); return empty; }
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
      return map;
    } catch {
      // promotions table may not exist yet — silently ignore
      setDiscountMap(empty);
      return empty;
    }
  }, [orgId]);

  // Fetch active combos (manual-add bundle tiles). Independent of the
  // per-product discount system (promotions) — a combo is a deliberate
  // cashier action, not something that applies automatically.
  const fetchCombos = useCallback(async () => {
    if (!orgId || !navigator.onLine) { setCombos([]); return; }
    try {
      const { data: rows } = await db
        .from("combos")
        .select("id, name, combo_price")
        .eq("org_id", orgId)
        .eq("active", true);
      if (!rows || rows.length === 0) { setCombos([]); return; }
      const ids = (rows as { id: string }[]).map((r) => r.id);
      const { data: items } = await db
        .from("combo_items")
        .select("combo_id, product_id")
        .in("combo_id", ids);
      const itemsByCombo: Record<string, string[]> = {};
      for (const it of (items ?? []) as { combo_id: string; product_id: string }[]) {
        (itemsByCombo[it.combo_id] ??= []).push(it.product_id);
      }
      setCombos(
        (rows as { id: string; name: string; combo_price: number }[]).map((r) => ({
          ...r,
          productIds: itemsByCombo[r.id] ?? [],
        }))
      );
    } catch {
      // combos table may not exist yet — silently ignore
      setCombos([]);
    }
  }, [orgId]);

  useEffect(() => {
    void (async () => {
      await fetchProducts();
      await fetchPromotions();
      await fetchCombos();
    })();
  }, [fetchProducts, fetchPromotions, fetchCombos]);

  useEffect(() => {
    return () => {
      if (outOfStockTimer.current) clearTimeout(outOfStockTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!currentLocationId || !navigator.onLine) return;
    (async () => {
      const { data } = await db
        .from("location_settings")
        .select("value")
        .eq("location_id", currentLocationId)
        .eq("key", "wholesale_enabled")
        .maybeSingle();
      setWholesaleEnabled((data as { value: string } | null)?.value === "true");
    })();
  }, [currentLocationId]);

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
          availableStock: product.opening_stock ?? undefined,
          wholesaleEnabled: product.wholesale_enabled,
          wholesaleMinQty: product.wholesale_min_qty,
          isWholesale: false,
          retailPrice: effectivePrice,
        },
      ];
    });
  }

  /** Combos resolved against the current product list: only offered when
   *  both underlying products exist here (right branch, in stock). */
  const comboTiles: ComboTile[] = combos
    .map((c): ComboTile | null => {
      if (c.productIds.length !== 2) return null;
      const prodA = products.find((p) => p.id === c.productIds[0]);
      const prodB = products.find((p) => p.id === c.productIds[1]);
      if (!prodA || !prodB) return null;
      const stock = Math.min(prodA.opening_stock ?? 0, prodB.opening_stock ?? 0);
      if (stock <= 0) return null;
      return { id: c.id, name: c.name, combo_price: c.combo_price, prodA, prodB, stock };
    })
    .filter((c): c is ComboTile => c !== null);

  function addComboToCart(combo: ComboTile) {
    const { prodA, prodB } = combo;
    // Split the fixed combo price between the two products proportionally
    // to their normal selling price, so per-product revenue/COGS reporting
    // stays meaningful. The remainder goes to the second product so the
    // two amounts always sum to EXACTLY combo_price — never a cent off
    // from independent rounding.
    const totalNormal = prodA.selling_price + prodB.selling_price;
    const priceA = totalNormal > 0
      ? Math.round(combo.combo_price * (prodA.selling_price / totalNormal) * 100) / 100
      : Math.round((combo.combo_price / 2) * 100) / 100;
    const priceB = Math.round((combo.combo_price - priceA) * 100) / 100;

    // Synthetic id — never collides with a real product id, so a combo
    // line can never accidentally merge with (or be merged into) a normal
    // cart line for either of its underlying products.
    const comboLineId = `combo:${combo.id}`;

    setCart((prev) => {
      const existing = prev.find((i) => i.productId === comboLineId);
      if (existing) {
        return prev.map((i) =>
          i.productId === comboLineId ? { ...i, quantity: i.quantity + 1 } : i
        );
      }
      return [
        ...prev,
        {
          productId: comboLineId,
          name: combo.name,
          unitPrice: combo.combo_price,
          quantity: 1,
          costPrice: (prodA.cost_per_unit ?? 0) + (prodB.cost_per_unit ?? 0),
          availableStock: combo.stock,
          comboBreakdown: [
            { productId: prodA.id, name: prodA.name, unitPrice: priceA, costPrice: prodA.cost_per_unit ?? 0 },
            { productId: prodB.id, name: prodB.name, unitPrice: priceB, costPrice: prodB.cost_per_unit ?? 0 },
          ],
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

  // Set an exact quantity (typed in the cart) rather than stepping by ±1.
  // Floors at 1 — removal is the trash button, not typing 0.
  function setQty(productId: string, quantity: number) {
    setCart((prev) =>
      prev.map((i) => (i.productId === productId ? { ...i, quantity: Math.max(1, quantity) } : i))
    );
  }

  function removeItem(productId: string) {
    setCart((prev) => prev.filter((i) => i.productId !== productId));
  }

  function clearCart() {
    setCart([]);
  }

  /** A barcode scan or name search matched a real product in the catalogue
   *  that has no stock at this location — say so, rather than behaving
   *  identically to an unknown/mistyped search. Shown as a centered banner
   *  (not the corner toast stack) and held longer, so it's hard to miss at
   *  a till mid-scan. */
  const showOutOfStockMessage = useCallback((message: string) => {
    if (outOfStockTimer.current) clearTimeout(outOfStockTimer.current);
    setOutOfStockMessage(message);
    outOfStockTimer.current = setTimeout(() => setOutOfStockMessage(null), 8000);
  }, []);
  // Stable references: ProductGrid's debounced name-search effect depends on
  // these, and an unstable (freshly-created-every-render) function reference
  // there re-triggers that effect on every render this component makes —
  // including the render caused by dismissing the message, which would
  // immediately reschedule and reshow it right after dismissal.
  const handleBarcodeOutOfStock = useCallback(
    (name: string) => showOutOfStockMessage(`No stock available for "${name}"`),
    [showOutOfStockMessage]
  );
  const handleNameSearchOutOfStock = useCallback(
    (names: string[]) => {
      const shown = names.slice(0, 3).join(", ");
      const rest = names.length > 3 ? ` +${names.length - 3} more` : "";
      showOutOfStockMessage(`No stock available for ${shown}${rest}`);
    },
    [showOutOfStockMessage]
  );

  /** Wholesale price for a line, given the discount the cashier typed. */
  function wholesalePrice(retailPrice: number, pct: string | undefined): number {
    const discount = parseFloat(pct ?? "");
    if (!isFinite(discount) || discount <= 0) return retailPrice;
    const capped = Math.min(discount, 100);
    return Math.round(retailPrice * (1 - capped / 100) * 100) / 100;
  }

  // Toggling wholesale off clears the negotiated discount, so re-ticking the
  // box never silently re-applies a rate the cashier can no longer see.
  function toggleWholesale(productId: string) {
    setCart((prev) =>
      prev.map((item) => {
        if (item.productId !== productId) return item;
        const retailPrice = item.retailPrice ?? item.unitPrice;
        const isWholesale = !item.isWholesale;
        return {
          ...item,
          isWholesale,
          wholesaleDiscountPct: isWholesale ? item.wholesaleDiscountPct : undefined,
          unitPrice: isWholesale ? wholesalePrice(retailPrice, item.wholesaleDiscountPct) : retailPrice,
        };
      })
    );
  }

  function setWholesaleDiscount(productId: string, pct: string) {
    setCart((prev) =>
      prev.map((item) => {
        if (item.productId !== productId) return item;
        const retailPrice = item.retailPrice ?? item.unitPrice;
        return { ...item, wholesaleDiscountPct: pct, unitPrice: wholesalePrice(retailPrice, pct) };
      })
    );
  }

  /** Re-derive promo prices at checkout so stale discounts don't persist (M18). */
  /** Re-derive promo prices at checkout so stale discounts don't persist (M18). */
  async function handleCheckout() {
    // Refresh promotions and use the RETURNED map (React state update is async,
    // so the closure `discountMap` would still hold the old value).
    const latestDiscounts = await fetchPromotions();
    setCart((prev) =>
      prev.map((item) => {
        const product = products.find((p) => p.id === item.productId);
        if (!product) return item;
        const discountPct = latestDiscounts.get(item.productId) ?? 0;
        const retailPrice = discountPct > 0
          ? Math.round(product.selling_price * (1 - discountPct / 100) * 100) / 100
          : product.selling_price;
        // The wholesale rate is negotiated at the till, so it survives this
        // refresh and re-applies on top of whatever the promo price now is.
        const effectivePrice = item.isWholesale
          ? wholesalePrice(retailPrice, item.wholesaleDiscountPct)
          : retailPrice;
        return effectivePrice !== item.unitPrice || retailPrice !== item.retailPrice
          ? { ...item, unitPrice: effectivePrice, retailPrice }
          : item;
      })
    );
    setShowPayment(true);
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
    <div className="flex flex-col md:flex-row gap-4 h-[calc(100dvh-6rem)]">
      {/* Product grid */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">Point of Sale</h1>
        {parkedCount > 0 && (
          <div className="mx-4 mt-2 px-4 py-2 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-sm text-red-700">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            <span>{parkedCount} sale{parkedCount > 1 ? "s" : ""} failed to sync after multiple attempts.</span>
          </div>
        )}
        {comboTiles.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-2">
            {comboTiles.map((c) => (
              <button
                key={c.id}
                onClick={() => addComboToCart(c)}
                aria-label={`Add combo ${c.name} to cart, ${formatZAR(c.combo_price)}`}
                className="flex items-center gap-2 rounded-xl border border-green-200 bg-green-50 hover:bg-green-100 active:bg-green-200 px-3 py-2 text-left transition-colors touch-manipulation"
              >
                <Layers className="w-4 h-4 text-green-600 flex-shrink-0" />
                <span>
                  <span className="block text-sm font-medium text-gray-900">{c.name}</span>
                  <span className="block text-xs text-green-700">{formatZAR(c.combo_price)}</span>
                </span>
              </button>
            ))}
          </div>
        )}
        <ProductGrid
          products={products}
          onAddToCart={addToCart}
          discountMap={discountMap}
          locationName={locations.find((l) => l.id === currentLocationId)?.name ?? null}
          hasMultipleLocations={locations.length > 1}
          catalogProducts={catalogProducts}
          onOutOfStock={handleBarcodeOutOfStock}
          onNameSearchOutOfStock={handleNameSearchOutOfStock}
        />
      </div>

      {/* Desktop/tablet cart (hidden on mobile) */}
      <div className="hidden md:block md:w-80 lg:w-96 flex-shrink-0">
        <Cart
          items={cart}
          onUpdateQty={updateQty}
          onSetQty={setQty}
          onRemove={removeItem}
          onClear={clearCart}
          onCheckout={handleCheckout}
          onToggleWholesale={toggleWholesale}
          onSetWholesaleDiscount={setWholesaleDiscount}
          branchWholesaleEnabled={wholesaleEnabled}
        />
      </div>

      {/* Mobile cart toggle (H6 fix) */}
      {cart.length > 0 && !mobileCartOpen && (
        <button
          onClick={() => setMobileCartOpen(true)}
          className="md:hidden fixed bottom-4 left-4 right-4 z-30 bg-green-600 text-white rounded-xl py-3 px-4 font-semibold shadow-lg flex items-center justify-between"
        >
          <span>View Cart ({cart.reduce((s, i) => s + i.quantity, 0)} items)</span>
          <span>{formatZAR(total)}</span>
        </button>
      )}

      {/* Mobile slide-up cart panel (H6 fix) */}
      {mobileCartOpen && (
        <div className="md:hidden fixed inset-0 z-40 flex flex-col">
          <div
            className="flex-shrink-0 bg-black/30"
            style={{ height: "15dvh" }}
            onClick={() => setMobileCartOpen(false)}
          />
          <div className="flex-1 bg-white rounded-t-2xl shadow-xl overflow-y-auto">
            <div className="sticky top-0 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
              <h2 className="font-semibold text-gray-900">Cart</h2>
              <button
                onClick={() => setMobileCartOpen(false)}
                className="text-sm text-green-600 font-medium"
              >
                Done
              </button>
            </div>
            <div className="p-4">
              <Cart
                items={cart}
                onUpdateQty={updateQty}
                onSetQty={setQty}
                onRemove={removeItem}
                onClear={clearCart}
                onCheckout={() => { setMobileCartOpen(false); handleCheckout(); }}
                onToggleWholesale={toggleWholesale}
                onSetWholesaleDiscount={setWholesaleDiscount}
                branchWholesaleEnabled={wholesaleEnabled}
              />
            </div>
          </div>
        </div>
      )}

      {/* Out-of-stock banner — centered and held longer than the corner
          toasts, so it's hard to miss mid-scan. Tap to dismiss early. */}
      {outOfStockMessage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4 pointer-events-none">
          <div
            onClick={() => setOutOfStockMessage(null)}
            className="pointer-events-auto max-w-sm text-center bg-red-600 text-white text-base font-semibold px-6 py-4 rounded-xl shadow-2xl cursor-pointer"
          >
            {outOfStockMessage}
          </div>
        </div>
      )}

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
