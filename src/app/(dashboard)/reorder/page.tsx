"use client";
import { useEffect, useState, useMemo } from "react";
import { db } from "@/lib/supabase";
import { useOrg } from "@/lib/org-context";
import { fetchAllPaged } from "@/lib/fetch-all";
import { ArrowLeft, Send, Copy, Check, Package, FileDown } from "lucide-react";
import Link from "next/link";

interface LowStockProduct {
  id: string;
  name: string;
  inventory_id: string;
  reorder_level: number;
  default_supplier: string | null;
  stock: number;
}

interface SupplierInfo {
  name: string;
  phone: string | null;
  email: string | null;
}

export default function ReorderPage() {
  const { lowStockThreshold, orgName, currentLocationName, locations, currentLocationId } = useOrg();
  const [products, setProducts] = useState<LowStockProduct[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [orderQtys, setOrderQtys] = useState<Record<string, number>>({});
  const [filterSupplier, setFilterSupplier] = useState<string>("__all__");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    (async () => {
      const [productRows, stockRows, { data: supplierRows }] = await Promise.all([
        fetchAllPaged<{
          id: string;
          name: string;
          inventory_id: string;
          reorder_level: number;
          default_supplier: string | null;
          discontinued: boolean;
        }>(() =>
          db.from("products")
            .select("id, name, inventory_id, reorder_level, default_supplier, discontinued")
            .eq("discontinued", false)
            .order("name")
        ),
        fetchAllPaged<{ product_id: string; quantity: number }>(() =>
          db.from("product_stock").select("product_id, quantity")
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
          low.push({
            id: p.id,
            name: p.name,
            inventory_id: p.inventory_id,
            reorder_level: p.reorder_level,
            default_supplier: p.default_supplier,
            stock,
          });
          const suggestedQty = Math.max((p.reorder_level || lowStockThreshold) - stock, 1);
          defaultQtys[p.id] = suggestedQty;
        }
      }

      setProducts(low);
      setOrderQtys(defaultQtys);
      setSelectedIds(new Set(low.map((p) => p.id)));
      setSuppliers((supplierRows as SupplierInfo[]) || []);
      setLoading(false);
    })();
  }, [lowStockThreshold]);

  const filtered = useMemo(() => {
    if (filterSupplier === "__all__") return products;
    if (filterSupplier === "__none__") return products.filter((p) => !p.default_supplier);
    return products.filter((p) => p.default_supplier === filterSupplier);
  }, [products, filterSupplier]);

  const supplierNames = useMemo(() => {
    const names = new Set(products.map((p) => p.default_supplier).filter(Boolean) as string[]);
    return [...names].sort();
  }, [products]);

  const selected = filtered.filter((p) => selectedIds.has(p.id));

  function toggleAll(checked: boolean) {
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
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function orderRef(): string {
    const d = new Date();
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `PO-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  function getSupplierInfo() {
    if (filterSupplier === "__all__" || filterSupplier === "__none__") return null;
    return suppliers.find((s) => s.name === filterSupplier) ?? null;
  }

  function getLocationInfo() {
    return locations.find((l) => l.id === currentLocationId) ?? null;
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
    for (let i = 0; i < selected.length; i++) {
      const p = selected[i];
      const qty = orderQtys[p.id] ?? 1;
      lines.push(`${i + 1}. ${p.name} — Qty: ${qty}`);
    }
    lines.push("");
    lines.push(`Total line items: ${selected.length}`);
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

    const rows = selected.map((p, i) => {
      const qty = orderQtys[p.id] ?? 1;
      return `<tr>
        <td class="cell">${i + 1}</td>
        <td class="cell">${p.name}</td>
        <td class="cell r">${qty}</td>
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
      <th class="r" style="width:80px">Qty</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
  <tfoot>
    <tr>
      <td class="foot" colspan="2">Total (${selected.length} item${selected.length !== 1 ? "s" : ""})</td>
      <td class="foot r">${totalQty}</td>
    </tr>
  </tfoot>
</table>

<div class="sig">
  <div class="sig-line">Authorized by</div>
  <div class="sig-line">Date</div>
</div>

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

            <div className="flex gap-2">
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
                    <th className="px-4 py-3 text-right font-medium text-gray-600">Order Qty</th>
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
