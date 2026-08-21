"use client";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/format";
import { db } from "@/lib/supabase";
import { useOrg } from "@/lib/org-context";
import { useOnline } from "@/lib/use-online";
import { readCache } from "@/lib/offline-store";
import { submitSaleBatch } from "@/lib/offline-ops";
import { toInternationalPhone } from "@/lib/currency";
import { localToday } from "@/lib/date-utils";
import { CartItem } from "./cart";
import { Customer } from "@/types/database";
import {
  Banknote,
  CreditCard,
  Users,
  Check,
  MessageCircle,
  Smartphone,
  Building2,
  CircleDollarSign,
  CloudOff,
  Printer,
  Gift,
} from "lucide-react";
import { Receipt, ReceiptData, ZraFiscalData, buildReceiptLines, LINE_WIDTH } from "./receipt";
import { receiptCode } from "@/lib/receipt-code";

/** Expands a combo cart line into its two real underlying product lines.
 *  Ordinary lines pass through unchanged. Used only where a REAL product_id
 *  is required — the sale RPC (stock deduction, sales rows) and the ZRA
 *  fiscal submission — never for the receipt shown to the customer, which
 *  keeps the single, friendlier "Combo: X" line from the cart. */
function expandComboLine(item: CartItem): CartItem[] {
  if (!item.comboBreakdown) return [item];
  return item.comboBreakdown.map((c) => ({
    productId: c.productId,
    name: c.name,
    unitPrice: c.unitPrice,
    quantity: item.quantity,
    costPrice: c.costPrice,
    isWholesale: false,
  }));
}

type PaymentKind = "cash" | "card" | "credit" | "mobile_money" | "eft" | "other";

interface PaymentMethodRow {
  id: string;
  name: string;
  kind: PaymentKind;
  sort_order: number;
}

interface RewardProduct {
  id: string;
  name: string;
  cost_per_unit: number | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  items: CartItem[];
  total: number;
  onComplete: () => void;
}

const KIND_ICON: Record<PaymentKind, React.ElementType> = {
  cash: Banknote,
  card: CreditCard,
  credit: Users,
  mobile_money: Smartphone,
  eft: Building2,
  other: CircleDollarSign,
};

const KIND_COLOR: Record<PaymentKind, string> = {
  cash: "border-green-500 bg-green-50 text-green-700",
  card: "border-blue-500 bg-blue-50 text-blue-700",
  credit: "border-amber-500 bg-amber-50 text-amber-700",
  mobile_money: "border-purple-500 bg-purple-50 text-purple-700",
  eft: "border-indigo-500 bg-indigo-50 text-indigo-700",
  other: "border-gray-500 bg-gray-50 text-gray-700",
};

export function PaymentModal({ open, onClose, items, total, onComplete }: Props) {
  const orgState = useOrg();
  const { currentLocationId, orgId } = orgState;
  const online = useOnline();
  const [methods, setMethods] = useState<PaymentMethodRow[]>([]);
  const [methodsLoaded, setMethodsLoaded] = useState(false);
  const [methodsError, setMethodsError] = useState(false);
  const [queuedToast, setQueuedToast] = useState(false);
  const [selectedMethodId, setSelectedMethodId] = useState<string | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<string>("");
  const [cashTendered, setCashTendered] = useState<string>("");
  const [cashBack, setCashBack] = useState<string>("");
  const [paymentReference, setPaymentReference] = useState<string>("");
  const [processing, setProcessing] = useState(false);
  // Reentrancy guard for handlePay. `processing` (React state) is NOT enough
  // on its own — a state update only takes effect on the next render, so if
  // the same click/tap somehow re-invokes handlePay before that render
  // commits (slow device, a queued second click event, etc.), `processing`
  // can still read false the second time through. A ref updates immediately
  // and synchronously, with no render in between, so it can't be beaten by
  // that race. Surfaced as duplicated sales: a cashier tapping "Complete
  // Sale" more than once while it was loading got one real sale per tap —
  // submit_sale_batch's own dedupe check (id = ANY(p_sale_ids)) never caught
  // it because offline-ops.ts generates fresh random sale_ids on every call,
  // so back-to-back attempts never shared an id for that check to match on.
  const submittingRef = useRef(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");

  // --- WhatsApp receipt state ---
  const [whatsAppPhone, setWhatsAppPhone] = useState("");
  const [showWhatsAppInput, setShowWhatsAppInput] = useState(false);
  const [zraFiscal, setZraFiscal] = useState<ZraFiscalData | null>(null);
  // The code printed on the receipt, set once the sale is recorded. Held in
  // state rather than generated inside buildReceiptData, which used to mint a
  // fresh random number on every render — so the printed receipt, the
  // WhatsApp image and the ZRA submission each carried a different number.
  const [receiptNo, setReceiptNo] = useState<string>("");
  // Per-branch receipts toggle (location_settings, key receipts_enabled).
  // Absence of a row = enabled; cached locally so the offline POS honours it.
  const [receiptsEnabled, setReceiptsEnabled] = useState(true);
  // Per-branch cash back (location_settings). Absence of a row = off, so no
  // shop gets a cash-out field it did not ask for.
  const [cashBackEnabled, setCashBackEnabled] = useState(false);
  // Per-branch card incentive: a free item on electronic sales over a spend.
  const [cardReward, setCardReward] = useState<{
    enabled: boolean;
    threshold: number;
    productId: string | null;
  }>({ enabled: false, threshold: 0, productId: null });

  useEffect(() => {
    if (open) {
      setSelectedMethodId(null);
      setSelectedCustomer("");
      setCashTendered("");
      setCashBack("");
      setPaymentReference("");
      setSuccess(false);
      setError("");
      setMethodsLoaded(false);
      setMethodsError(false);
      setQueuedToast(false);
      setShowWhatsAppInput(false);
      setWhatsAppPhone("");
      setZraFiscal(null);
      setReceiptNo("");

      // Per-branch till settings. Receipts default ON when no row exists,
      // cash back defaults OFF — it is opt-in per shop, not a default till
      // behaviour.
      const receiptsCacheKey = "tilify_receipts_enabled_" + (currentLocationId ?? "");
      const cashBackCacheKey = "tilify_cash_back_enabled_" + (currentLocationId ?? "");
      try {
        setReceiptsEnabled(window.localStorage.getItem(receiptsCacheKey) !== "false");
        setCashBackEnabled(window.localStorage.getItem(cashBackCacheKey) === "true");
      } catch {
        setReceiptsEnabled(true);
        setCashBackEnabled(false);
      }
      const rewardCacheKey = "tilify_card_reward_" + (currentLocationId ?? "");
      try {
        const raw = window.localStorage.getItem(rewardCacheKey);
        setCardReward(raw ? JSON.parse(raw) : { enabled: false, threshold: 0, productId: null });
      } catch {
        setCardReward({ enabled: false, threshold: 0, productId: null });
      }
      if (navigator.onLine && currentLocationId) {
        db.from("location_settings")
          .select("key, value")
          .eq("location_id", currentLocationId)
          .in("key", [
            "receipts_enabled",
            "cash_back_enabled",
            "card_reward_enabled",
            "card_reward_threshold",
            "card_reward_product_id",
          ])
          .then(({ data }: { data: { key: string; value: string }[] | null }) => {
            const byKey = new Map((data || []).map((r) => [r.key, r.value]));
            const receipts = byKey.get("receipts_enabled") !== "false";
            const cashBackOn = byKey.get("cash_back_enabled") === "true";
            const reward = {
              enabled: byKey.get("card_reward_enabled") === "true",
              threshold: parseFloat(byKey.get("card_reward_threshold") ?? "") || 0,
              productId: byKey.get("card_reward_product_id") || null,
            };
            setReceiptsEnabled(receipts);
            setCashBackEnabled(cashBackOn);
            setCardReward(reward);
            try {
              window.localStorage.setItem(receiptsCacheKey, receipts ? "true" : "false");
              window.localStorage.setItem(cashBackCacheKey, cashBackOn ? "true" : "false");
              window.localStorage.setItem(rewardCacheKey, JSON.stringify(reward));
            } catch {
              // ignore — cache is best-effort
            }
          });
      }

      const cachedMethods = orgId
        ? (readCache<PaymentMethodRow>(orgId, "payment_methods") ?? [])
            .filter((m) => (m as PaymentMethodRow & { active?: boolean }).active !== false)
            .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
        : [];
      const cachedCustomers = orgId
        ? (readCache<Customer & { location_id?: string | null }>(orgId, "customers") ?? [])
            .filter((c) => !currentLocationId || !c.location_id || c.location_id === currentLocationId)
            .sort((a, b) => a.name.localeCompare(b.name))
        : [];

      if (!navigator.onLine) {
        setMethods(cachedMethods);
        setCustomers(cachedCustomers);
        setMethodsLoaded(true);
        return;
      }

      const methodsRequest = db
        .from("payment_methods")
        .select("id, name, kind, sort_order")
        .eq("active", true)
        .order("sort_order");
      const timeout = new Promise<{ data: null; error: { message: string } }>((resolve) => {
        setTimeout(() => resolve({ data: null, error: { message: "timeout" } }), 4000);
      });

      Promise.race([methodsRequest, timeout]).then((result) => {
        const { data, error: err } = result as { data: PaymentMethodRow[] | null; error: { message: string } | null };
        if (err && cachedMethods.length > 0) {
          setMethods(cachedMethods);
        } else if (err) {
          setMethodsError(true);
        } else {
          setMethods(data && data.length > 0 ? data : cachedMethods);
        }
        setMethodsLoaded(true);
      });

      let customerQuery = db.from("customers").select("*").order("name");
      if (currentLocationId) customerQuery = customerQuery.eq("location_id", currentLocationId);
      const customerTimeout = new Promise<{ data: null }>((resolve) => {
        setTimeout(() => resolve({ data: null }), 4000);
      });
      Promise.race([customerQuery, customerTimeout]).then((result) => {
        const { data } = result as { data: Customer[] | null };
        setCustomers(data && data.length > 0 ? data : cachedCustomers);
      });
    }
  }, [open, currentLocationId, orgId]);

  const receiptRef = useRef<HTMLDivElement>(null);

  const selectedMethod = methods.find((m) => m.id === selectedMethodId) || null;
  const selectedKind = selectedMethod?.kind ?? null;

  // Cash back only makes sense where the customer is paying electronically —
  // the card funds the cash handed over. Never on a cash or credit sale.
  const allowsCashBack =
    cashBackEnabled &&
    (selectedKind === "card" || selectedKind === "eft" || selectedKind === "mobile_money");
  const cashBackAmount = allowsCashBack ? Math.max(0, parseFloat(cashBack) || 0) : 0;
  const amountToCharge = total + cashBackAmount;

  const paysElectronically =
    selectedKind === "card" || selectedKind === "eft" || selectedKind === "mobile_money";

  // The nominated freebie. Cache first so the incentive survives a till going
  // offline, but fall back to a lookup — the cache is only written once the
  // background sync has run, and without this the panel silently never shows.
  const [rewardProduct, setRewardProduct] = useState<RewardProduct | null>(null);

  useEffect(() => {
    if (!open) return;
    if (!cardReward.enabled || !cardReward.productId) {
      setRewardProduct(null);
      return;
    }
    const cached = orgId ? readCache<RewardProduct>(orgId, "products") ?? [] : [];
    const hit = cached.find((p) => p.id === cardReward.productId);
    if (hit) {
      setRewardProduct(hit);
      return;
    }
    if (!navigator.onLine) {
      setRewardProduct(null);
      return;
    }
    db.from("products")
      .select("id, name, cost_per_unit")
      .eq("id", cardReward.productId)
      .maybeSingle()
      .then(({ data }: { data: RewardProduct | null }) => setRewardProduct(data ?? null));
  }, [open, cardReward.enabled, cardReward.productId, orgId]);

  // Earned on the goods total only — cash back must not buy a free snack.
  const rewardEarned =
    cardReward.enabled && paysElectronically && rewardProduct !== null && total >= cardReward.threshold;

  const rewardLine: CartItem | null = rewardEarned && rewardProduct
    ? {
        productId: rewardProduct.id,
        name: rewardProduct.name,
        unitPrice: 0,
        quantity: 1,
        costPrice: rewardProduct.cost_per_unit ?? 0,
      }
    : null;

  // The freebie rides along as a zero-price line: stock comes down and its
  // cost lands in COGS, while revenue is untouched.
  const linesForSale = rewardLine ? [...items, rewardLine] : items;

  const buildReceiptData = useCallback((): ReceiptData | null => {
    const loc = (currentLocationId && orgState.locations)
      ? orgState.locations.find((l: { id: string }) => l.id === currentLocationId)
      : null;
    if (!selectedMethod) return null;
    const tendered = cashTendered ? parseFloat(cashTendered) : null;
    const customer = selectedKind === "credit"
      ? customers.find((c) => c.id === selectedCustomer)
      : null;
    return {
      orgName: orgState.orgName ?? "Shop",
      locationName: loc?.name ?? "",
      locationAddress: loc?.address,
      locationPhone: loc?.phone,
      items: linesForSale,
      total,
      paymentMethod: selectedMethod.name,
      cashTendered: tendered,
      change: tendered != null && tendered > total ? tendered - total : null,
      cashBack: cashBackAmount > 0 ? cashBackAmount : null,
      paymentReference: paymentReference || null,
      customerName: customer?.name ?? null,
      customerTpin: (customer as { tpin?: string | null } | null | undefined)?.tpin ?? null,
      saleDate: new Date(),
      tpin: orgState.tpin,
      vatPercent: orgState.vatPercent,
      receiptNumber: receiptNo || null,
      zra: zraFiscal,
    };
  }, [currentLocationId, orgState, selectedMethod, selectedKind, cashTendered, cashBackAmount, customers, selectedCustomer, linesForSale, total, paymentReference, zraFiscal, receiptNo]);

  function handlePrintReceipt() {
    const el = receiptRef.current;
    if (!el) return;
    const printWindow = window.open("", "_blank", "width=350,height=600");
    if (!printWindow) return;
    printWindow.document.write(
      "<!DOCTYPE html><html><head><title>Receipt</title>" +
      "<style>body{margin:0;padding:0}@page{size:80mm auto;margin:0}</style>" +
      "</head><body>" + el.innerHTML + "</body></html>"
    );
    printWindow.document.close();
    setTimeout(() => {
      printWindow.print();
      printWindow.close();
    }, 300);
  }

  async function handlePay() {
    // Must be the very first check — before validation, before anything else
    // — so a reentrant call can never slip past it regardless of why it fired.
    if (submittingRef.current) return;

    // Never fail silently — a dead button with no message is impossible for a
    // cashier to diagnose mid-queue.
    if (!selectedMethod) {
      setError("Choose how the customer is paying first.");
      return;
    }
    if (selectedKind === "credit" && !selectedCustomer) {
      setError("Please select a customer for credit sale.");
      return;
    }
    if (!orgId || !currentLocationId) {
      setError("Shop not loaded yet. Try again in a moment.");
      return;
    }

    submittingRef.current = true;
    setProcessing(true);
    setError("");

    try {
    const result = await submitSaleBatch({
      org_id: orgId,
      location_id: currentLocationId,
      payment_method: selectedMethod.name,
      payment_reference: paymentReference.trim() || null,
      customer_id: selectedKind === "credit" ? selectedCustomer : null,
      sale_date: localToday(),
      created_at: new Date().toISOString(),
      cash_back: cashBackAmount,
      // Expanded here, not in linesForSale itself — the receipt (built from
      // linesForSale elsewhere) should keep showing one "Combo: X" line, but
      // the actual sale needs real product_ids for stock deduction and
      // per-product reporting.
      lines: linesForSale.flatMap(expandComboLine).map((item) => ({
        product_id: item.productId,
        quantity: item.quantity,
        unit_price: item.unitPrice,
        total_amount: item.unitPrice * item.quantity,
        cost_price: item.costPrice,
        is_wholesale: item.isWholesale ?? false,
      })),
    });

    setProcessing(false);

    if (!result.ok) {
      setError(result.error || "Failed to process sale");
      return;
    }

    if (result.queued) {
      setQueuedToast(true);
    }

    // Number the receipt from the transaction where we can, since that is what
    // the lookup keys on. A queued sale has no transaction yet, so it falls
    // back to the first line's id — find_sale_by_receipt_code matches either.
    let code = receiptCode(result.sale_ids[0]);
    if (!result.queued && navigator.onLine) {
      const { data: row } = await db
        .from("sales")
        .select("transaction_id")
        .eq("id", result.sale_ids[0])
        .maybeSingle();
      const txn = (row as { transaction_id: string | null } | null)?.transaction_id;
      if (txn) code = receiptCode(txn);
    }
    setReceiptNo(code);

    setSuccess(true);

    // --- ZRA Smart Invoice submission (non-blocking) ---
    // Fire after the sale succeeds. If VSDC is unreachable, the sale still
    // stands — the ZRA invoice can be retried from the admin panel.
    if (online && !result.queued && result.sale_ids?.[0]) {
      const saleId = result.sale_ids[0];
      submitToZra({
        saleId,
        items: items.flatMap(expandComboLine).map((item) => ({
          productId: item.productId,
          name: item.name,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        })),
        total,
        paymentMethod: selectedMethod.name,
        customerName: selectedKind === "credit"
          ? customers.find((c) => c.id === selectedCustomer)?.name ?? null
          : null,
        saleDate: new Date().toISOString(),
        receiptNo,
      }).then((fiscal) => {
        if (fiscal) setZraFiscal(fiscal);
      }).catch(() => {
        // Silently fail — sale is already recorded, ZRA can be retried
      });
    }
    } finally {
      submittingRef.current = false;
    }
  }

  /** Submit sale to ZRA via the server-side proxy. Returns the fiscal data or null. */
  async function submitToZra(payload: {
    saleId: string;
    items: { productId: string; name: string; quantity: number; unitPrice: number }[];
    total: number;
    paymentMethod: string;
    customerName?: string | null;
    saleDate: string;
    receiptNo: string;
  }): Promise<ZraFiscalData | null> {
    try {
      const { data: { session } } = await db.auth.getSession();
      if (!session?.access_token) return null;

      const res = await fetch("/api/zra/submit-sale", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!json?.rcptNo) return null;
      return {
        rcptNo: String(json.rcptNo),
        sdcId: json.sdcId ?? null,
        rcptSign: json.rcptSign ?? null,
        intrlData: json.intrlData ?? null,
        vsdcRcptPbctDate: json.vsdcRcptPbctDate ?? null,
      };
    } catch {
      return null;
    }
  }

  /** Generate a receipt-sized PNG, download it, then open WhatsApp so the
   *  user can attach the file. Works with WhatsApp for Windows / mobile. */
  function sendWhatsAppReceipt(phone?: string) {
    const customer = selectedKind === "credit"
      ? customers.find((c) => c.id === selectedCustomer)
      : null;

    const rawPhone = phone || customer?.phone;
    if (!rawPhone) {
      setShowWhatsAppInput(true);
      return;
    }

    // Open WhatsApp window immediately (user-gesture context) so the browser doesn't block it
    const intlPhone = toInternationalPhone(rawPhone, orgState.currency);
    const waWindow = window.open("about:blank", "_blank");

    generateReceiptImage().then((blob) => {
      if (!blob) return;

      // Download the receipt image
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "receipt-" + Date.now() + ".png";
      a.click();
      URL.revokeObjectURL(url);

      // Navigate the already-opened window to WhatsApp
      const shortMsg = "Please find your receipt attached.";
      const waUrl = "https://wa.me/" + intlPhone + "?text=" + encodeURIComponent(shortMsg);
      if (waWindow) {
        waWindow.location.href = waUrl;
      } else {
        window.location.href = waUrl;
      }
    });
  }

  function generateReceiptImage(): Promise<Blob | null> {
    return new Promise((resolve) => {
      const rd = buildReceiptData();
      if (!rd) { resolve(null); return; }
      const lines = buildReceiptLines(rd);
      const hasFiscal = !!rd.zra;

      const FONT = "12px 'Courier New', monospace";
      const PD = 16;
      const LH = 18;

      const mc = document.createElement("canvas");
      const mx = mc.getContext("2d");
      if (!mx) { resolve(null); return; }
      mx.font = FONT;
      const textW = Math.ceil(mx.measureText("M".repeat(LINE_WIDTH)).width);
      const CW = textW + PD * 2;
      const qrH = hasFiscal ? 140 : 0;
      const CH = PD * 2 + lines.length * LH + qrH;

      const canvas = document.createElement("canvas");
      canvas.width = CW;
      canvas.height = CH;
      const ctx = canvas.getContext("2d");
      if (!ctx) { resolve(null); return; }

      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, CW, CH);
      ctx.font = FONT;
      ctx.fillStyle = "#000";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";

      let y = PD;
      for (const line of lines) {
        ctx.fillText(line, PD, y);
        y += LH;
      }

      if (hasFiscal) {
        const size = 120;
        const bx = (CW - size) / 2;
        ctx.save();
        ctx.strokeStyle = "#000";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.strokeRect(bx, y + 4, size, size);
        ctx.restore();
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = "10px 'Courier New', monospace";
        ctx.fillText("ZRA QR CODE", CW / 2, y + 4 + size / 2 - 8);
        ctx.fillText("(added at go-live)", CW / 2, y + 4 + size / 2 + 8);
      }

      canvas.toBlob((blob) => resolve(blob), "image/png");
    });
  }

  // Resolve customer for display in success screen
  const creditCustomer = useMemo(
    () => selectedKind === "credit" ? customers.find((c) => c.id === selectedCustomer) : null,
    [selectedKind, customers, selectedCustomer]
  );

  if (success) {
    const receiptData = buildReceiptData();
    return (
      <Modal open={open} onClose={onComplete} title="Sale Complete">
        <div className="flex flex-col items-center py-8">
          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mb-4">
            <Check className="w-8 h-8 text-green-600" />
          </div>
          <p className="text-xl font-bold text-gray-900">{formatMoney(amountToCharge)}</p>
          <p className="text-sm text-gray-500 mt-1">
            Paid by {selectedMethod?.name ?? "—"}
          </p>
          {cashBackAmount > 0 && (
            <div className="mt-3 bg-blue-50 border border-blue-200 rounded-xl px-6 py-3 text-center">
              <p className="text-sm text-blue-600">Cash back to hand over</p>
              <p className="text-3xl font-bold text-blue-700">{formatMoney(cashBackAmount)}</p>
            </div>
          )}
          {rewardLine && (
            <div className="mt-3 bg-green-50 border border-green-200 rounded-xl px-6 py-3 text-center">
              <p className="text-sm text-green-600">Free item to hand over</p>
              <p className="text-lg font-bold text-green-700">{rewardLine.name}</p>
            </div>
          )}
          {queuedToast && (
            <div className="mt-3 inline-flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-full px-3 py-1.5">
              <CloudOff className="w-4 h-4 text-amber-700" />
              <span className="text-xs text-amber-900">
                Queued &mdash; will sync when you&apos;re back online
              </span>
            </div>
          )}
          {selectedKind === "cash" && cashTendered && parseFloat(cashTendered) > total && (
            <div className="mt-3 bg-green-50 border border-green-200 rounded-xl px-6 py-3 text-center">
              <p className="text-sm text-green-600">Change Due</p>
              <p className="text-3xl font-bold text-green-700">{formatMoney(parseFloat(cashTendered) - total)}</p>
            </div>
          )}
          {paymentReference && (
            <p className="text-xs text-gray-500 mt-3">Ref: {paymentReference}</p>
          )}

          {/* Action buttons */}
          <div className="flex flex-col gap-2 mt-6 w-full max-w-xs">
            {receiptsEnabled && (
              <>
                <Button onClick={handlePrintReceipt} variant="secondary" className="w-full">
                  <Printer className="w-4 h-4 mr-2" />
                  Print Receipt
                </Button>
                <Button onClick={() => sendWhatsAppReceipt(creditCustomer?.phone ?? undefined)} variant="secondary" className="w-full">
                  <MessageCircle className="w-4 h-4 mr-2" />
                  WhatsApp Receipt
                </Button>

                {showWhatsAppInput && (
                  <div className="flex gap-2">
                    <input
                      type="tel"
                      inputMode="tel"
                      value={whatsAppPhone}
                      onChange={(e) => setWhatsAppPhone(e.target.value)}
                      placeholder="Phone number"
                      className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
                      autoFocus
                    />
                    <Button
                      onClick={() => whatsAppPhone.trim() && sendWhatsAppReceipt(whatsAppPhone.trim())}
                      disabled={!whatsAppPhone.trim()}
                      size="sm"
                    >
                      Send
                    </Button>
                  </div>
                )}
              </>
            )}

            <Button onClick={onComplete} className="w-full">
              Done
            </Button>
          </div>
        </div>

        {receiptsEnabled && receiptData && (
          <div style={{ position: "absolute", left: "-9999px", top: 0 }}>
            <div ref={receiptRef} className="receipt-print-container">
              <Receipt data={receiptData} />
            </div>
          </div>
        )}
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={onClose} title="Payment" wide>
      <div className="space-y-6">
        <div className="text-center py-4 bg-gray-50 rounded-xl">
          <p className="text-sm text-gray-500">Amount Due</p>
          <p className="text-3xl font-bold text-gray-900">{formatMoney(total)}</p>
          <p className="text-xs text-gray-400 mt-1">{items.length} item(s)</p>
        </div>

        {!online && methods.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs flex items-center gap-2">
            <CloudOff className="w-4 h-4 text-amber-600 flex-shrink-0" />
            <span className="text-amber-900">
              <strong>Offline.</strong> This sale will queue locally and sync when you&apos;re back online.
            </span>
          </div>
        )}

        <div>
          <p className="text-sm font-medium text-gray-700 mb-3">Select payment method</p>
          {!methodsLoaded ? (
            <div className="text-sm text-gray-400 italic py-6 text-center border border-dashed border-gray-200 rounded-lg">
              Loading payment methods...
            </div>
          ) : methods.length === 0 ? (
            <div className="text-sm text-gray-400 italic py-6 text-center border border-dashed border-gray-200 rounded-lg">
              No payment methods configured. Re-run shop setup or add methods in Settings.
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {methods.map((m) => {
                const Icon = KIND_ICON[m.kind] ?? CircleDollarSign;
                const active = selectedMethodId === m.id;
                return (
                  <button
                    key={m.id}
                    onClick={() => setSelectedMethodId(m.id)}
                    className={`flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all touch-manipulation ${
                      active
                        ? KIND_COLOR[m.kind]
                        : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
                    }`}
                  >
                    <Icon className="w-7 h-7" />
                    <span className="text-sm font-medium text-center leading-tight">{m.name}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {selectedKind === "cash" && (
          <div>
            <label htmlFor="cash-tendered" className="text-sm font-medium text-gray-700 mb-2 block">Cash tendered</label>
            <input
              id="cash-tendered"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={cashTendered}
              onChange={(e) => setCashTendered(e.target.value)}
              placeholder={"Min " + formatMoney(total)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-lg font-semibold text-center focus:border-green-500 focus:ring-1 focus:ring-green-500"
            />
            {cashTendered && parseFloat(cashTendered) >= total && (
              <div className="mt-3 bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-center">
                <p className="text-sm text-green-600">Change</p>
                <p className="text-2xl font-bold text-green-700">{formatMoney(parseFloat(cashTendered) - total)}</p>
              </div>
            )}
            {cashTendered && parseFloat(cashTendered) > 0 && parseFloat(cashTendered) < total && (
              <p className="mt-2 text-sm text-red-600 text-center">
                Short by {formatMoney(total - parseFloat(cashTendered))}
              </p>
            )}
          </div>
        )}

        {rewardEarned && rewardProduct && (
          <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-3 flex items-center gap-3">
            <Gift className="w-5 h-5 text-green-600 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-green-900">
                Free {rewardProduct.name}
              </p>
              <p className="text-xs text-green-700">
                Added to this sale at no charge — hand it over with the goods.
              </p>
            </div>
          </div>
        )}

        {cardReward.enabled && paysElectronically && rewardProduct && !rewardEarned && (
          <p className="text-xs text-gray-500">
            {formatMoney(cardReward.threshold - total)} more on card earns a free{" "}
            {rewardProduct.name}.
          </p>
        )}

        {allowsCashBack && (
          <div>
            <label htmlFor="cash-back" className="text-sm font-medium text-gray-700 mb-2 block">Cash back (optional)</label>
            <input
              id="cash-back"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={cashBack}
              onChange={(e) => setCashBack(e.target.value)}
              placeholder="0.00"
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
            />
            <p className="text-xs text-gray-500 mt-1">
              Cash handed to the customer on top of the goods. It is added to the card
              charge and taken out of the till.
            </p>
            {cashBackAmount > 0 && (
              <div className="mt-3 bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 text-sm space-y-1">
                <div className="flex justify-between text-blue-900">
                  <span>Goods</span>
                  <span>{formatMoney(total)}</span>
                </div>
                <div className="flex justify-between text-blue-900">
                  <span>+ Cash back</span>
                  <span>{formatMoney(cashBackAmount)}</span>
                </div>
                <div className="flex justify-between font-semibold text-blue-900 pt-1 border-t border-blue-200">
                  <span>Charge to card</span>
                  <span>{formatMoney(amountToCharge)}</span>
                </div>
                <p className="text-xs text-blue-700 pt-1">
                  Hand over {formatMoney(cashBackAmount)} in cash.
                </p>
              </div>
            )}
          </div>
        )}

        {(selectedKind === "card" || selectedKind === "eft") && (
          <div>
            <label htmlFor="payment-ref" className="text-sm font-medium text-gray-700 mb-2 block">
              Reference (optional)
            </label>
            <input
              id="payment-ref"
              type="text"
              value={paymentReference}
              onChange={(e) => setPaymentReference(e.target.value)}
              placeholder="Approval / transaction code"
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
            />
          </div>
        )}

        {selectedKind === "credit" && (
          <div>
            <label htmlFor="credit-customer" className="text-sm font-medium text-gray-700 mb-2 block">Select customer</label>
            {customers.length === 0 ? (
              <p className="text-sm text-gray-400">
                No customers found. Add customers in the Customers module first.
              </p>
            ) : (
              <select
                id="credit-customer"
                value={selectedCustomer}
                onChange={(e) => setSelectedCustomer(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
              >
                <option value="">Choose a customer...</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} (owes {formatMoney(c.balance)})
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        {error && (
          <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>
        )}

        <Button
          onClick={handlePay}
          disabled={
            !selectedMethod ||
            processing ||
            (selectedKind === "cash" && (!cashTendered || parseFloat(cashTendered) < total))
          }
          loading={processing}
          size="lg"
          className="w-full text-base py-4"
        >
          {"Complete Sale — " + formatMoney(amountToCharge)}
        </Button>
      </div>
    </Modal>
  );
}
