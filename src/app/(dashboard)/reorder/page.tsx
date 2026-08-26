"use client";
import { useEffect, useState, useMemo } from "react";
import { db } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useOrg } from "@/lib/org-context";
import { fetchAllPaged } from "@/lib/fetch-all";
import { formatZAR } from "@/lib/format";
import { receiptCode } from "@/lib/receipt-code";
import { ArrowLeft, Send, Copy, Check, Package, FileDown, Search, ClipboardList } from "lucide-react";
import Link from "next/link";

// Software-attribution credit stamped on every generated purchase order
// (WhatsApp text, PDF, Copy) — not shown anywhere in the on-screen picker.
// A plain credit line, not a copyright claim: the PO's content belongs to
// the shop, not to Tilify.
const DOC_FOOTER = "Generated with Tilify · tilify.mkglobal.co.za · support@tilify.mkglobal.co.za";

interface LowStockProduct {
  id: string;
  name: string;
  inventory_id: string;
  reorder_level: number;
  default_supplier: string | null;
  category: string | null;
  qtyInPack: number;
  packageCost: number | null;
  stock: number;
}

interface SupplierInfo {
  name: string;
  phone: string | null;
  email: string | null;
}

export default function ReorderPage() {
  const { name } = useAuth();
  const { lowStockThreshold, orgName, currentLocationName, locations, currentLocationId } = useOrg();
  const [products, setProducts] = useState<LowStockProduct[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [orderQtys, setOrderQtys] = useState<Record<string, number>>({});
  const [filterSupplier, setFilterSupplier] = useState<string>("__all__");
  const [filterCategory, setFilterCategory] = useState<string>("__all__");
  const [search, setSearch] = useState("");
  const [copied, setCopied] = useState(false);
  const [poNumber, setPoNumber] = useState<string | null>(null);
  const [creatingPO, setCreatingPO] = useState(false);

  useEffect(() => {
    if (!currentLocationId) return;
    (async () => {
      const [productRows, stockRows, { data: supplierRows }] = await Promise.all([
        fetchAllPaged<{
          id: string;
          name: string;
          inventory_id: string;
          reorder_level: number;
          default_supplier: string | null;
          category: string | null;
          qty_in_pack: number | null;
          package_price: number | null;
          discontinued: boolean;
        }>(() =>
          db.from("products")
            .select("id, name, inventory_id, reorder_level, default_supplier, category, qty_in_pack, package_price, discontinued")
            .eq("discontinued", false)
            .order("name")
        ),
        fetchAllPaged<{ product_id: string; quantity: number }>(() =>
          db.from("product_stock").select("product_id, quantity").eq("location_id", currentLocationId)
        ),
        db.from("suppliers")
          .select("name, phone, email")
          .eq("active", true)
          .order("name"),
      ]);

      const stockByProduct = new Map<string, number>();
      (stockRows as { product_id: string; quantity: number }[]).forEach((r) => {
        stockByProduct.set(r.product_id, (stockByProduct.get(r.product_id) ?? 0) + Number(r.quantity));
      });

      const low: LowStockProduct[] = [];
      const defaultQtys: Record<string, number> = {};
      for (const p of productRows as typeof productRows) {
        const stock = stockByProduct.get(p.id) ?? 0;
        const threshold = p.reorder_level > 0 ? p.reorder_level : lowStockThreshold;
        if (stock <= threshold) {
          const qtyInPack = p.qty_in_pack || 1;
          low.push({
            id: p.id,
            name: p.name,
            inventory_id: p.inventory_id,
            reorder_level: p.reorder_level,
            default_supplier: p.default_supplier,
            category: p.category,
            qtyInPack,
            packageCost: p.package_price,
            stock,
          });
          // Order Qty is in packages, matching Receive Stock's convention —
          // suppliers sell by the case, not the loose unit.
          const unitsNeeded = Math.max((p.reorder_level || lowStockThreshold) - stock, 1);
          defaultQtys[p.id] = qtyInPack > 1 ? Math.ceil(unitsNeeded / qtyInPack) : unitsNeeded;
        }
      }

      setProducts(low);
      setOrderQtys(defaultQtys);
      setSelectedIds(new Set(low.map((p) => p.id)));
      setSuppliers((supplierRows as SupplierInfo[]) || []);
      setLoading(false);
    })();
  }, [lowStockThreshold, currentLocationId]);

  const filtered = useMemo(() => {
    let list = products;
    if (filterSupplier === "__none__") list = list.filter((p) => !p.default_supplier);
    else if (filterSupplier !== "__all__") list = list.filter((p) => p.default_supplier === filterSupplier);
    if (filterCategory !== "__all__") list = list.filter((p) => p.category === filterCategory);
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((p) => p.name.toLowerCase().includes(q) || p.inventory_id.toLowerCase().includes(q));
    return list;
  }, [products, filterSupplier, filterCategory, search]);

  const supplierNames = useMemo(() => {
    const names = new Set(products.map((p) => p.default_supplier).filter(Boolean) as string[]);
    return [...names].sort();
  }, [products]);

  const categoryNames = useMemo(() => {
    const names = new Set(products.map((p) => p.category).filter(Boolean) as string[]);
    return [...names].sort();
  }, [products]);

  const selected = filtered.filter((p) => selectedIds.has(p.id));

  function toggleAll(checked: boolean) {
    setPoNumber(null);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const p of filtered) {
        if (checked) next.add(p.id);
        else next.delete(p.id);
      }
      return next;
    });
  }

  function toggle(id: string) {
    setPoNumber(null);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function orderRef(): string {
    if (poNumber) return poNumber;
    const d = new Date();
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `PO-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  // Persist the current selection as a real Purchase Order so Receive Stock
  // can pull it back up by number instead of the operator retyping every
  // line. Deliberately full-receive-only (see migration 099) — no partial
  // receiving state machine here, that's what WMS purchase orders are for.
  async function createPurchaseOrder() {
    if (selected.length === 0) return;
    setCreatingPO(true);
    try {
      const id = crypto.randomUUID();
      const number = `PO-${receiptCode(id)}`;
      const sup = getSupplierInfo();
      const subtotal = selected.reduce(
        (s, p) => s + (orderQtys[p.id] ?? 1) * (p.packageCost ?? 0),
        0
      );

      const { error: hErr } = await db.from("purchase_orders").insert({
        id,
        po_number: number,
        supplier: sup?.name ?? null,
        location_id: currentLocationId,
        total_cost: subtotal,
        created_by: name,
      });
      if (hErr) throw hErr;

      const items = selected.map((p) => ({
        po_id: id,
        product_id: p.id,
        item_name: p.name,
        quantity: orderQtys[p.id] ?? 1,
        unit_cost: p.packageCost ?? 0,
        qty_in_pack: p.qtyInPack,
      }));
      const { error: iErr } = await db.from("purchase_order_items").insert(items);
      if (iErr) throw iErr;

      setPoNumber(number);
    } catch (err) {
      const msg = err instanceof Error ? err.message : (err as { message?: string })?.message || "Unknown error";
      alert("Error creating purchase order: " + msg);
    } finally {
      setCreatingPO(false);
    }
  }

  function getSupplierInfo() {
    if (filterSupplier === "__all__" || filterSupplier === "__none__") return null;
    return suppliers.find((s) => s.name === filterSupplier) ?? null;
  }

  function getLocationInfo() {
    return locations.find((l) => l.id === currentLocationId) ?? null;
  }

  // Order Qty is stored in packages (matching Receive Stock's convention).
  // Suppliers order by the case — spell out the unit total alongside so
  // "6" isn't misread as 6 loose units when it means 6 cases of 24.
  function qtyLabel(p: LowStockProduct, qty: number): string {
    if (p.qtyInPack <= 1) return `${qty}`;
    return `${qty} pack${qty !== 1 ? "s" : ""} (${qty * p.qtyInPack} units)`;
  }

  function buildOrderText(): string {
    if (selected.length === 0) return "";
    const ref = orderRef();
    const sup = getSupplierInfo();
    const loc = getLocationInfo();

    const lines: string[] = [];
    lines.push(`*PURCHASE ORDER*`);
    lines.push(`Order No: ${ref}`);
    lines.push(`Date: ${new Date().toLocaleDateString("en-ZA")}`);
    lines.push("");
    lines.push(`*From:* ${orgName || "Our Shop"}${currentLocationName ? ` (${currentLocationName})` : ""}`);
    if (loc?.address) lines.push(loc.address);
    if (loc?.phone) lines.push(`Tel: ${loc.phone}`);
    if (sup) {
      lines.push("");
      lines.push(`*To:* ${sup.name}`);
      if (sup.phone) lines.push(`Tel: ${sup.phone}`);
      if (sup.email) lines.push(`Email: ${sup.email}`);
    }
    lines.push("");
    lines.push("*Items:*");
    let subtotal = 0;
    let hasUnknownCost = false;
    for (let i = 0; i < selected.length; i++) {
      const p = selected[i];
      const qty = orderQtys[p.id] ?? 1;
      if (p.packageCost != null) {
        const lineCost = qty * p.packageCost;
        subtotal += lineCost;
        lines.push(`${i + 1}. ${p.name} — Qty: ${qtyLabel(p, qty)} — ${formatZAR(lineCost)}`);
      } else {
        hasUnknownCost = true;
        lines.push(`${i + 1}. ${p.name} — Qty: ${qtyLabel(p, qty)}`);
      }
    }
    lines.push("");
    lines.push(`Total line items: ${selected.length}`);
    lines.push(`*Estimated Subtotal: ${formatZAR(subtotal)}*${hasUnknownCost ? " (excl. items with no cost set)" : ""}`);
    lines.push("");
    lines.push(`— ${DOC_FOOTER}`);
    return lines.join("\n");
  }

  function shareWhatsApp() {
    const text = buildOrderText();
    if (!text) return;
    const sup = getSupplierInfo();
    const phone = sup?.phone?.replace(/[^0-9+]/g, "") || "";
    const url = phone
      ? `https://wa.me/${phone.replace(/^\+/, "")}?text=${encodeURIComponent(text)}`
      : `https://wa.me/?text=${encodeURIComponent(text)}`;
    window.open(url, "_blank");
  }

  async function copyToClipboard() {
    const text = buildOrderText();
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function exportPDF() {
    if (selected.length === 0) return;
    const ref = orderRef();
    const sup = getSupplierInfo();
    const loc = getLocationInfo();
    const date = new Date().toLocaleDateString("en-ZA");
    const shopName = orgName || "Our Shop";
    const branchLabel = currentLocationName ? ` (${currentLocationName})` : "";

    let subtotal = 0;
    let hasUnknownCost = false;
    const rows = selected.map((p, i) => {
      const qty = orderQtys[p.id] ?? 1;
      const lineCost = p.packageCost != null ? qty * p.packageCost : null;
      if (lineCost != null) subtotal += lineCost;
      else hasUnknownCost = true;
      return `<tr>
        <td class="cell">${i + 1}</td>
        <td class="cell">${p.name}</td>
        <td class="cell r">${qtyLabel(p, qty)}</td>
        <td class="cell r">${p.packageCost != null ? formatZAR(p.packageCost) : "—"}</td>
        <td class="cell r">${lineCost != null ? formatZAR(lineCost) : "—"}</td>
      </tr>`;
    }).join("");

    const totalQty = selected.reduce((s, p) => s + (orderQtys[p.id] ?? 1), 0);

    const html = `<!DOCTYPE html><html><head><title>PO ${ref}</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;padding:40px;color:#111;font-size:13px;line-height:1.5}
  h1{font-size:22px;margin:0 0 4px}
  .meta{color:#555;margin:2px 0}
  .grid{display:flex;justify-content:space-between;margin:24px 0 20px;gap:40px}
  .block{flex:1}
  .block h3{font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#888;margin:0 0 4px;border-bottom:1px solid #ddd;padding-bottom:4px}
  .block p{margin:2px 0}
  table{width:100%;border-collapse:collapse;margin-top:16px}
  th{text-align:left;padding:8px 12px;border-bottom:2px solid #333;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#555}
  .cell{padding:8px 12px;border-bottom:1px solid #e5e7eb}
  .r{text-align:right}
  .foot{padding:10px 12px;font-weight:bold;border-top:2px solid #333}
  .sig{margin-top:60px;display:flex;gap:80px}
  .sig-line{border-top:1px solid #333;padding-top:6px;width:200px;font-size:12px;color:#555}
  .footer{margin-top:40px;padding-top:12px;border-top:1px solid #e5e7eb;font-size:10px;color:#999;text-align:center}
  @media print{body{padding:20px}}
</style></head><body>

<h1>PURCHASE ORDER</h1>
<p class="meta"><strong>Order No:</strong> ${ref}</p>
<p class="meta"><strong>Date:</strong> ${date}</p>

<div class="grid">
  <div class="block">
    <h3>From (Buyer)</h3>
    <p><strong>${shopName}${branchLabel}</strong></p>
    ${loc?.address ? `<p>${loc.address}</p>` : ""}
    ${loc?.phone ? `<p>Tel: ${loc.phone}</p>` : ""}
  </div>
  ${sup ? `<div class="block">
    <h3>To (Supplier)</h3>
    <p><strong>${sup.name}</strong></p>
    ${sup.phone ? `<p>Tel: ${sup.phone}</p>` : ""}
    ${sup.email ? `<p>Email: ${sup.email}</p>` : ""}
  </div>` : ""}
</div>

<table>
  <thead>
    <tr>
      <th style="width:40px">#</th>
      <th>Product Description</th>
      <th class="r" style="width:150px">Qty</th>
      <th class="r" style="width:90px">Unit Cost</th>
      <th class="r" style="width:100px">Line Total</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
  <tfoot>
    <tr>
      <td class="foot" colspan="2">Total (${selected.length} item${selected.length !== 1 ? "s" : ""})</td>
      <td class="foot r">${totalQty}</td>
      <td class="foot"></td>
      <td class="foot r">${formatZAR(subtotal)}</td>
    </tr>
  </tfoot>
</table>
${hasUnknownCost ? `<p class="meta" style="font-style:italic">Subtotal excludes items with no cost set.</p>` : ""}

<div class="sig">
  <div class="sig-line">Authorized by</div>
  <div class="sig-line">Date</div>
</div>

<p class="footer">${DOC_FOOTER}</p>

</body></html>`;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(html);
    w.document.close();
    w.setTimeout(() => { w.print(); }, 300);
  }

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-48" />
          <div className="h-64 bg-gray-200 rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard" className="text-gray-400 hover:text-gray-600">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div>
          <h1 className="text-xl font-bold text-gray-900">Reorder List</h1>
          <p className="text-sm text-gray-500">
            {products.length} product{products.length !== 1 ? "s" : ""} at or below reorder level
          </p>
        </div>
      </div>

      {products.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <Package className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500">All products are above reorder level.</p>
        </div>
      ) : (
        <>
          {/* Filters and actions */}
          <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
            <div className="flex flex-col sm:flex-row gap-3 w-full sm:w-auto">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search products..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full sm:w-56 pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
                />
              </div>
              <select
                value={filterSupplier}
                onChange={(e) => setFilterSupplier(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
              >
                <option value="__all__">All suppliers</option>
                <option value="__none__">No supplier assigned</option>
                {supplierNames.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <select
                value={filterCategory}
                onChange={(e) => setFilterCategory(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
              >
                <option value="__all__">All categories</option>
                {categoryNames.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>

            <div className="flex gap-2 items-center flex-wrap">
              {poNumber ? (
                <div className="flex items-center gap-2 px-3 py-2 bg-indigo-50 border border-indigo-200 rounded-lg text-sm text-indigo-700">
                  <ClipboardList className="w-4 h-4" />
                  <span className="font-medium">{poNumber} saved</span>
                  <button
                    onClick={() => setPoNumber(null)}
                    className="text-indigo-400 hover:text-indigo-600 text-xs underline ml-1"
                  >
                    New PO
                  </button>
                </div>
              ) : (
                <button
                  onClick={createPurchaseOrder}
                  disabled={selected.length === 0 || creatingPO}
                  className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ClipboardList className="w-4 h-4" />
                  {creatingPO ? "Creating..." : "Create PO"}
                </button>
              )}
              <button
                onClick={shareWhatsApp}
                disabled={selected.length === 0}
                className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Send className="w-4 h-4" />
                WhatsApp
              </button>
              <button
                onClick={exportPDF}
                disabled={selected.length === 0}
                className="flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <FileDown className="w-4 h-4" />
                PDF
              </button>
              <button
                onClick={copyToClipboard}
                disabled={selected.length === 0}
                className="flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>

          {/* Product table */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="px-4 py-3 text-left">
                      <input
                        type="checkbox"
                        checked={filtered.length > 0 && filtered.every((p) => selectedIds.has(p.id))}
                        onChange={(e) => toggleAll(e.target.checked)}
                        className="rounded border-gray-300 text-green-600 focus:ring-green-500"
                      />
                    </th>
                    <th className="px-4 py-3 text-left font-medium text-gray-600">Product</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-600">Supplier</th>
                    <th className="px-4 py-3 text-right font-medium text-gray-600">Stock</th>
                    <th className="px-4 py-3 text-right font-medium text-gray-600">Reorder Lvl</th>
                    <th className="px-4 py-3 text-right font-medium text-gray-600">Order Qty (packs)</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((p) => (
                    <tr
                      key={p.id}
                      className={`border-b border-gray-50 last:border-0 ${selectedIds.has(p.id) ? "bg-green-50/50" : ""}`}
                    >
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(p.id)}
                          onChange={() => toggle(p.id)}
                          className="rounded border-gray-300 text-green-600 focus:ring-green-500"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-900">{p.name}</div>
                        <div className="text-xs text-gray-400">{p.inventory_id}</div>
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {p.default_supplier || <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className={`font-semibold ${p.stock === 0 ? "text-red-600" : "text-amber-600"}`}>
                          {p.stock}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-gray-500">
                        {p.reorder_level || lowStockThreshold}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <input
                          type="number"
                          min={1}
                          value={orderQtys[p.id] ?? 1}
                          onChange={(e) => {
                            const v = parseInt(e.target.value);
                            if (v > 0) setOrderQtys((prev) => ({ ...prev, [p.id]: v }));
                          }}
                          className="w-20 border border-gray-300 rounded px-2 py-1 text-sm text-right focus:border-green-500 focus:ring-1 focus:ring-green-500"
                        />
                        {p.qtyInPack > 1 && (
                          <div className="text-xs text-gray-400 mt-1">
                            ×{p.qtyInPack} = {(orderQtys[p.id] ?? 1) * p.qtyInPack} units
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Summary */}
          <div className="text-sm text-gray-500 text-right">
            {selected.length} of {filtered.length} selected
          </div>
        </>
      )}
    </div>
  );
}
