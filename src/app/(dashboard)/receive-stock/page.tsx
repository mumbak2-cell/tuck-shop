"use client";
import { useState, useEffect } from "react";
import { db } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useOrg } from "@/lib/org-context";
import { fetchAllPaged } from "@/lib/fetch-all";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { formatZAR, formatDate } from "@/lib/format";
import { PackagePlus, Plus, Trash2, Search, Save, History, Paperclip, ChefHat, ChevronDown, ChevronRight, Pencil, Check, X, Send, FileDown, Copy, ClipboardList } from "lucide-react";
import type { Product, Ingredient } from "@/types/database";
import { SupplierSelect } from "@/components/suppliers/supplier-select";
import { ReceiptUpload } from "@/components/ui/receipt-upload";
import { ReceiptViewer } from "@/components/ui/receipt-viewer";
import { localToday } from "@/lib/date-utils";
import { receiptCode } from "@/lib/receipt-code";
import { escapeHtml } from "@/lib/print-utils";

// Same software-attribution credit stamped on Reorder List documents —
// a plain credit line, not a copyright claim.
const DOC_FOOTER = "Generated with Tilify · tilify.mkglobal.co.za · support@tilify.mkglobal.co.za";

interface ReceiptLine {
  id: string;
  type: "product" | "ingredient";
  itemId: string;
  itemName: string;
  inventoryId?: string;
  quantity: number | "";
  unitCost: number;
  qtyInPack: number; // units per pack (products only, 1 for ingredients)
}

interface PastReceipt {
  id: string;
  receipt_date: string;
  supplier: string | null;
  total_cost: number;
  recorded_by: string | null;
  receipt_path: string | null;
  created_at: string;
  location_id: string | null;
}

interface SupplierInfo {
  name: string;
  phone: string | null;
  email: string | null;
}

interface ReceiptItemRow {
  id: string;
  product_id: string | null;
  ingredient_id: string | null;
  quantity: number;
  unit_cost: number;
  line_total: number;
  item_name: string;
  item_type: "product" | "ingredient";
}

interface OpenPO {
  id: string;
  po_number: string;
  supplier: string | null;
  total_cost: number;
  created_at: string;
  created_by: string | null;
}

export default function ReceiveStockPage() {
  const { name, role } = useAuth();
  const { currentLocationId, currentLocationName, orgId, orgName, locations } = useOrg();
  const [products, setProducts] = useState<Product[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [lines, setLines] = useState<ReceiptLine[]>([]);
  const [supplier, setSupplier] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [search, setSearch] = useState("");
  const [showPicker, setShowPicker] = useState(false);
  const [tab, setTab] = useState<"new" | "history">("new");
  const [history, setHistory] = useState<PastReceipt[]>([]);
  const [createExpense, setCreateExpense] = useState(true);
  // How the delivery was paid for. Drives the cash-spent report: stock bought
  // on account leaves the bank later, so it must not count as cash out today.
  const [paidBy, setPaidBy] = useState<"cash" | "account" | "electronic">("cash");
  const [receiptPath, setReceiptPath] = useState<string | null>(null);
  const [preparedFood, setPreparedFood] = useState(false);
  const [viewingReceipt, setViewingReceipt] = useState<string | null>(null);
  const [expandedReceipt, setExpandedReceipt] = useState<string | null>(null);
  const [receiptItems, setReceiptItems] = useState<Record<string, ReceiptItemRow[]>>({});
  const [editingReceipt, setEditingReceipt] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Record<string, { quantity: number; unit_cost: number }>>({});
  const [savingEdit, setSavingEdit] = useState(false);
  const [attachingReceipt, setAttachingReceipt] = useState<string | null>(null);
  const [suppliersInfo, setSuppliersInfo] = useState<SupplierInfo[]>([]);
  const [copiedReceiptId, setCopiedReceiptId] = useState<string | null>(null);
  const [openPOs, setOpenPOs] = useState<OpenPO[]>([]);
  const [showPOPicker, setShowPOPicker] = useState(false);
  const [poSearch, setPoSearch] = useState("");
  const [linkedPO, setLinkedPO] = useState<{ id: string; number: string } | null>(null);
  const [loadingPO, setLoadingPO] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    // Paginate products via .range() — Supabase max_rows (default 1000)
    // would otherwise truncate large catalogues. Ingredients tables stay
    // small so a plain query is fine there.
    const [prods, { data: ings }, { data: hist }, { data: sups }, { data: pos }] = await Promise.all([
      fetchAllPaged<Product>(() =>
        db.from("products").select("*").eq("discontinued", false).order("name")
      ),
      db.from("ingredients").select("*").order("name"),
      db.from("stock_receipts").select("*").order("created_at", { ascending: false }).limit(20),
      db.from("suppliers").select("name, phone, email").eq("active", true).order("name"),
      db.from("purchase_orders")
        .select("id, po_number, supplier, total_cost, created_at, created_by")
        .eq("status", "Draft")
        .order("created_at", { ascending: false }),
    ]);
    setProducts(prods);
    setIngredients(ings || []);
    setHistory(hist || []);
    setSuppliersInfo((sups as SupplierInfo[]) || []);
    setOpenPOs((pos as OpenPO[]) || []);
  }

  function addLine(type: "product" | "ingredient", item: Product | Ingredient) {
    if (preparedFood && !(type === "product" && (item as Product).is_prepared)) {
      alert("Prepared food receipt: only prepared items can be added.");
      return;
    }
    const existing = lines.find(
      (l) => l.type === type && l.itemId === item.id
    );
    if (existing) {
      setLines(lines.map((l) =>
        l.id === existing.id ? { ...l, quantity: (typeof l.quantity === "number" ? l.quantity : 0) + 1 } : l
      ));
    } else {
      const unitCost = type === "product"
        ? ((item as Product).package_price || 0)
        : (item as Ingredient).purchase_price;
      const qtyInPack = type === "product" ? ((item as Product).qty_in_pack || 1) : 1;
      setLines([
        ...lines,
        {
          id: crypto.randomUUID(),
          type,
          itemId: item.id,
          itemName: item.name,
          inventoryId: type === "product" ? (item as Product).inventory_id : undefined,
          quantity: "",
          unitCost,
          qtyInPack,
        },
      ]);
    }
    setShowPicker(false);
    setSearch("");
  }

  function updateLine(id: string, field: "quantity" | "unitCost", value: number | "") {
    setLines(lines.map((l) => (l.id === id ? { ...l, [field]: value } : l)));
  }

  function removeLine(id: string) {
    setLines(lines.filter((l) => l.id !== id));
  }

  // Pull a PO's lines into the form so the operator doesn't retype a delivery
  // that was already planned on Reorder List. Replaces whatever's on the form
  // — confirmed first if there's manual work in progress, so it isn't lost
  // silently.
  async function loadPurchaseOrder(po: OpenPO) {
    if (lines.length > 0 && !confirm(`Replace the ${lines.length} item(s) already on this form with ${po.po_number}'s items?`)) {
      return;
    }
    setLoadingPO(true);
    try {
      const { data: items, error } = await db
        .from("purchase_order_items")
        .select("product_id, ingredient_id, item_name, quantity, unit_cost, qty_in_pack")
        .eq("po_id", po.id);
      if (error) throw error;
      if (!items || items.length === 0) {
        alert("This purchase order has no items.");
        return;
      }

      if (
        preparedFood &&
        items.some((it: { product_id: string | null }) => {
          const p = it.product_id ? products.find((pp) => pp.id === it.product_id) : undefined;
          return !p?.is_prepared;
        })
      ) {
        alert("Prepared food receipt: this purchase order has non-prepared items and can't be loaded here.");
        return;
      }

      const newLines: ReceiptLine[] = items.map((it: {
        product_id: string | null;
        ingredient_id: string | null;
        item_name: string;
        quantity: number;
        unit_cost: number;
        qty_in_pack: number;
      }) => {
        const type: "product" | "ingredient" = it.product_id ? "product" : "ingredient";
        const product = it.product_id ? products.find((p) => p.id === it.product_id) : undefined;
        return {
          id: crypto.randomUUID(),
          type,
          itemId: (it.product_id ?? it.ingredient_id) as string,
          itemName: it.item_name,
          inventoryId: product?.inventory_id,
          quantity: it.quantity,
          unitCost: it.unit_cost,
          qtyInPack: it.qty_in_pack || 1,
        };
      });

      setLines(newLines);
      setSupplier(po.supplier || "");
      if (!notes) setNotes(`From ${po.po_number}`);
      setLinkedPO({ id: po.id, number: po.po_number });
      setShowPOPicker(false);
      setPoSearch("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : (err as { message?: string })?.message || "Unknown error";
      alert("Error loading purchase order: " + msg);
    } finally {
      setLoadingPO(false);
    }
  }

  const totalCost = preparedFood
    ? 0
    : lines.reduce((sum, l) => sum + (typeof l.quantity === "number" ? l.quantity : 0) * l.unitCost, 0);

  // A line counts as prepared only if it's a product flagged is_prepared.
  // Ingredient lines and regular products are never prepared, so a prepared-food
  // receipt rejects them.
  const lineIsPrepared = (l: ReceiptLine) =>
    l.type === "product" && !!products.find((p) => p.id === l.itemId)?.is_prepared;

  async function handleSave() {
    if (lines.length === 0) return;
    const hasBlank = lines.some((l) => l.quantity === "" || l.quantity <= 0);
    if (hasBlank) {
      alert("Every item needs a quantity greater than zero.");
      return;
    }
    setSaving(true);
    setSuccess(false);

    try {
      // 1. Create receipt header
      // location_id records WHICH branch received this delivery (migration 059).
      // Step 3 below already puts the units at currentLocationId; without it on
      // the header, Revenue Assurance cannot tell which branch was replenished
      // and credits the delivery to every one of them.
      const headerRow: Record<string, unknown> = {
        receipt_date: localToday(),
        supplier: supplier || null,
        notes: notes || null,
        total_cost: totalCost,
        recorded_by: name,
        paid_by: paidBy,
        location_id: currentLocationId,
      };
      if (receiptPath) headerRow.receipt_path = receiptPath;
      if (linkedPO) headerRow.po_id = linkedPO.id;

      let { data: receipt, error: hErr } = await db
        .from("stock_receipts")
        .insert(headerRow)
        .select()
        .single();

      // Migration 099's po_id can arrive after this code deploys, same as
      // location_id (059) below — PostgREST reports an unknown column as
      // PGRST204, a plain object not an Error, so read .code off it directly.
      // Degrade to an unlinked receipt rather than failing the delivery.
      if (hErr && (hErr as { code?: string }).code === "PGRST204" && "po_id" in headerRow) {
        delete headerRow.po_id;
        ({ data: receipt, error: hErr } = await db
          .from("stock_receipts")
          .insert(headerRow)
          .select()
          .single());
      }

      // Migration 059 is applied by hand while this code deploys on merge, so
      // it can arrive first. Same PGRST204 degrade, for location_id instead.
      if (hErr && (hErr as { code?: string }).code === "PGRST204") {
        delete headerRow.location_id;
        ({ data: receipt, error: hErr } = await db
          .from("stock_receipts")
          .insert(headerRow)
          .select()
          .single());
      }
      if (hErr) throw hErr;

      // 2. Create receipt items
      const items = lines.map((l) => ({
        receipt_id: receipt.id,
        product_id: l.type === "product" ? l.itemId : null,
        ingredient_id: l.type === "ingredient" ? l.itemId : null,
        quantity: l.quantity,
        unit_cost: l.unitCost,
      }));
      const { error: iErr } = await db.from("stock_receipt_items").insert(items);
      if (iErr) throw iErr;

      // 3. Increment stock for each line — retry once on failure, collect
      // any items that still fail so the user knows exactly what to fix.
      const failedItems: string[] = [];
      for (const l of lines) {
        if (l.type === "product") {
          const totalUnits = Math.round((l.quantity as number) * l.qtyInPack);
          if (!currentLocationId) {
            failedItems.push(l.itemName + " (no branch selected)");
            continue;
          }
          const rpcArgs = {
            p_product_id: l.itemId,
            p_quantity: totalUnits,
            p_location_id: currentLocationId,
          };
          const { error: err1 } = await db.rpc("add_product_stock_at_location", rpcArgs);
          if (err1) {
            await new Promise((r) => setTimeout(r, 500));
            const { error: err2 } = await db.rpc("add_product_stock_at_location", rpcArgs);
            if (err2) failedItems.push(l.itemName);
          }
        } else {
          const rpcArgs = { p_ingredient_id: l.itemId, p_quantity: l.quantity };
          const { error: err1 } = await db.rpc("add_ingredient_stock", rpcArgs);
          if (err1) {
            await new Promise((r) => setTimeout(r, 500));
            const { error: err2 } = await db.rpc("add_ingredient_stock", rpcArgs);
            if (err2) failedItems.push(l.itemName);
          }
        }
      }

      // 4. Optionally create expense entry (never for prepared food).
      // The receipt path is copied across so the delivery's paperwork is
      // reachable from Expenses too, not only from this page's History —
      // looking for it under Expenses and not finding it invites recording
      // the same delivery a second time. Both rows then reference one object,
      // which is why deleting either goes through
      // deleteReceiptIfUnreferenced() rather than removing the file outright.
      if (!preparedFood && createExpense && totalCost > 0) {
        await db.from("expenses").insert({
          expense_date: localToday(),
          category: "Stock Purchases",
          description: supplier ? `Stock delivery from ${supplier}` : "Stock delivery",
          amount: totalCost,
          recorded_by: name,
          ...(receiptPath ? { receipt_path: receiptPath } : {}),
        });
      }

      if (failedItems.length > 0) {
        alert(
          "Receipt saved but stock did NOT update for:\n\n" +
          failedItems.join("\n") +
          "\n\nPlease adjust stock manually for these items or re-enter them."
        );
      }

      // 5. Close out the PO this receipt was loaded from, if any. One receipt
      // fully closes the whole PO (no partial-receive tracking, see migration
      // 099) — best-effort: a failure here must not undo the delivery that
      // was just recorded and stocked.
      if (linkedPO) {
        await db.from("purchase_orders")
          .update({ status: "Received", received_at: new Date().toISOString() })
          .eq("id", linkedPO.id);
      }

      setSuccess(failedItems.length === 0);
      setLines([]);
      setSupplier("");
      setNotes("");
      setReceiptPath(null);
      setPreparedFood(false);
      setLinkedPO(null);
      loadData();
      if (failedItems.length === 0) setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : (err as { message?: string })?.message || "Unknown error";
      alert("Error saving receipt: " + msg);
    } finally {
      setSaving(false);
    }
  }

  async function toggleExpand(receiptId: string) {
    if (expandedReceipt === receiptId) {
      setExpandedReceipt(null);
      setEditingReceipt(null);
      return;
    }
    setExpandedReceipt(receiptId);
    setEditingReceipt(null);
    if (receiptItems[receiptId]) return;
    const { data } = await db
      .from("stock_receipt_items")
      .select("id, product_id, ingredient_id, quantity, unit_cost, line_total, products(name), ingredients(name)")
      .eq("receipt_id", receiptId);
    if (data) {
      const rows: ReceiptItemRow[] = data.map((d: Record<string, unknown>) => ({
        id: d.id as string,
        product_id: d.product_id as string | null,
        ingredient_id: d.ingredient_id as string | null,
        quantity: d.quantity as number,
        unit_cost: d.unit_cost as number,
        line_total: d.line_total as number,
        item_name: (d.products as { name: string } | null)?.name || (d.ingredients as { name: string } | null)?.name || "Unknown",
        item_type: d.product_id ? "product" as const : "ingredient" as const,
      }));
      setReceiptItems((prev) => ({ ...prev, [receiptId]: rows }));
    }
  }

  function startEdit(receiptId: string, items: ReceiptItemRow[]) {
    setEditingReceipt(receiptId);
    const draft: Record<string, { quantity: number; unit_cost: number }> = {};
    for (const it of items) {
      draft[it.id] = { quantity: it.quantity, unit_cost: it.unit_cost };
    }
    setEditDraft(draft);
  }

  async function saveEdit(receiptId: string) {
    setSavingEdit(true);
    try {
      for (const [itemId, vals] of Object.entries(editDraft)) {
        await db
          .from("stock_receipt_items")
          .update({ quantity: vals.quantity, unit_cost: vals.unit_cost })
          .eq("id", itemId);
      }
      const newTotal = Object.values(editDraft).reduce((s, v) => s + v.quantity * v.unit_cost, 0);
      await db.from("stock_receipts").update({ total_cost: newTotal }).eq("id", receiptId);
      setReceiptItems((prev) => {
        const updated = prev[receiptId]?.map((it) => {
          const d = editDraft[it.id];
          if (!d) return it;
          return { ...it, quantity: d.quantity, unit_cost: d.unit_cost, line_total: d.quantity * d.unit_cost };
        });
        return { ...prev, [receiptId]: updated || [] };
      });
      setHistory((prev) => prev.map((r) => r.id === receiptId ? { ...r, total_cost: newTotal } : r));
      setEditingReceipt(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : (err as { message?: string })?.message || "Unknown error";
      alert("Error saving changes: " + msg);
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleAttachReceipt(receiptId: string, path: string | null) {
    if (!path) return;
    await db.from("stock_receipts").update({ receipt_path: path }).eq("id", receiptId);
    setHistory((prev) => prev.map((r) => r.id === receiptId ? { ...r, receipt_path: path } : r));
    setAttachingReceipt(null);
  }

  function getSupplierInfo(supplierName: string | null): SupplierInfo | null {
    if (!supplierName) return null;
    return suppliersInfo.find((s) => s.name === supplierName) ?? null;
  }

  function getReceiptLocation(locationId: string | null) {
    if (!locationId) return null;
    return locations.find((l) => l.id === locationId) ?? null;
  }

  function buildReceiptText(r: PastReceipt, items: ReceiptItemRow[]): string {
    const sup = getSupplierInfo(r.supplier);
    const loc = getReceiptLocation(r.location_id);

    const lines: string[] = [];
    lines.push(`*GOODS RECEIVED NOTE*`);
    lines.push(`GRN No: ${receiptCode(r.id)}`);
    lines.push(`Date: ${formatDate(r.receipt_date)}`);
    lines.push("");
    lines.push(`*Received by:* ${orgName || "Our Shop"}${loc?.name ? ` (${loc.name})` : ""}`);
    if (loc?.address) lines.push(loc.address);
    if (loc?.phone) lines.push(`Tel: ${loc.phone}`);
    lines.push("");
    lines.push(`*From (Supplier):* ${r.supplier || "Not specified"}`);
    if (sup?.phone) lines.push(`Tel: ${sup.phone}`);
    if (sup?.email) lines.push(`Email: ${sup.email}`);
    lines.push("");
    lines.push("*Items:*");
    items.forEach((it, i) => {
      lines.push(`${i + 1}. ${it.item_name} — Qty: ${it.quantity} — ${formatZAR(it.line_total)}`);
    });
    lines.push("");
    lines.push(`Total line items: ${items.length}`);
    lines.push(`*Total: ${formatZAR(r.total_cost)}*`);
    if (r.recorded_by) lines.push(`Recorded by: ${r.recorded_by}`);
    lines.push("");
    lines.push(`— ${DOC_FOOTER}`);
    return lines.join("\n");
  }

  function shareReceiptWhatsApp(r: PastReceipt, items: ReceiptItemRow[]) {
    const text = buildReceiptText(r, items);
    const sup = getSupplierInfo(r.supplier);
    const phone = sup?.phone?.replace(/[^0-9+]/g, "") || "";
    const url = phone
      ? `https://wa.me/${phone.replace(/^\+/, "")}?text=${encodeURIComponent(text)}`
      : `https://wa.me/?text=${encodeURIComponent(text)}`;
    window.open(url, "_blank");
  }

  async function copyReceiptText(r: PastReceipt, items: ReceiptItemRow[]) {
    await navigator.clipboard.writeText(buildReceiptText(r, items));
    setCopiedReceiptId(r.id);
    setTimeout(() => setCopiedReceiptId(null), 2000);
  }

  function exportReceiptPDF(r: PastReceipt, items: ReceiptItemRow[]) {
    const sup = getSupplierInfo(r.supplier);
    const loc = getReceiptLocation(r.location_id);
    const shopName = orgName || "Our Shop";
    const branchLabel = loc?.name ? ` (${loc.name})` : "";

    const rows = items.map((it, i) => `<tr>
        <td class="cell">${i + 1}</td>
        <td class="cell">${escapeHtml(it.item_name)}</td>
        <td class="cell r">${it.quantity}</td>
        <td class="cell r">${formatZAR(it.unit_cost)}</td>
        <td class="cell r">${formatZAR(it.line_total)}</td>
      </tr>`).join("");

    const html = `<!DOCTYPE html><html><head><title>GRN ${receiptCode(r.id)}</title>
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
  .footer{margin-top:40px;padding-top:12px;border-top:1px solid #e5e7eb;font-size:10px;color:#999;text-align:center}
  @media print{body{padding:20px}}
</style></head><body>

<h1>GOODS RECEIVED NOTE</h1>
<p class="meta"><strong>GRN No:</strong> ${receiptCode(r.id)}</p>
<p class="meta"><strong>Date:</strong> ${formatDate(r.receipt_date)}</p>

<div class="grid">
  <div class="block">
    <h3>Received By</h3>
    <p><strong>${escapeHtml(shopName)}${escapeHtml(branchLabel)}</strong></p>
    ${loc?.address ? `<p>${escapeHtml(loc.address)}</p>` : ""}
    ${loc?.phone ? `<p>Tel: ${escapeHtml(loc.phone)}</p>` : ""}
  </div>
  <div class="block">
    <h3>Supplier</h3>
    <p><strong>${escapeHtml(r.supplier || "Not specified")}</strong></p>
    ${sup?.phone ? `<p>Tel: ${escapeHtml(sup.phone)}</p>` : ""}
    ${sup?.email ? `<p>Email: ${escapeHtml(sup.email)}</p>` : ""}
  </div>
</div>

<table>
  <thead>
    <tr>
      <th style="width:40px">#</th>
      <th>Item</th>
      <th class="r" style="width:80px">Qty</th>
      <th class="r" style="width:90px">Unit Cost</th>
      <th class="r" style="width:100px">Line Total</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
  <tfoot>
    <tr>
      <td class="foot" colspan="4">Total (${items.length} item${items.length !== 1 ? "s" : ""})</td>
      <td class="foot r">${formatZAR(r.total_cost)}</td>
    </tr>
  </tfoot>
</table>
${r.recorded_by ? `<p class="meta" style="margin-top:16px">Recorded by: ${escapeHtml(r.recorded_by)}</p>` : ""}

<p class="footer">${DOC_FOOTER}</p>

</body></html>`;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(html);
    w.document.close();
    w.setTimeout(() => { w.print(); }, 300);
  }

  // Filter items for picker — split products into purchased vs prepared
  const searchLower = search.toLowerCase();
  const allFilteredProducts = products.filter(
    (p) =>
      p.name.toLowerCase().includes(searchLower) ||
      p.inventory_id.toLowerCase().includes(searchLower)
  );
  // A prepared food receipt can only take prepared items, so hide the other
  // two groups from the picker entirely rather than let them be clicked.
  const filteredProducts = preparedFood ? [] : allFilteredProducts.filter((p) => !p.is_prepared);
  const filteredPrepared = allFilteredProducts.filter((p) => p.is_prepared);
  const filteredIngredients = preparedFood
    ? []
    : ingredients.filter((i) => i.name.toLowerCase().includes(searchLower));

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <PackagePlus className="w-7 h-7 text-green-600" />
            Receive Stock
          </h1>
          <p className="text-sm text-gray-500 mt-1">Record incoming deliveries for products and ingredients</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant={tab === "new" ? "primary" : "secondary"}
            onClick={() => setTab("new")}
            size="sm"
          >
            <Plus className="w-4 h-4 mr-1" /> New Receipt
          </Button>
          <Button
            variant={tab === "history" ? "primary" : "secondary"}
            onClick={() => setTab("history")}
            size="sm"
          >
            <History className="w-4 h-4 mr-1" /> History
          </Button>
        </div>
      </div>

      {tab === "new" && (
        <div className="space-y-6">
          {/* Supplier and notes */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Supplier (optional)</label>
              <SupplierSelect value={supplier} onChange={setSupplier} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Notes (optional)</label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. Weekly restock, Invoice #12345"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
              />
            </div>
          </div>

          {/* Prepared food toggle */}
          <button
            type="button"
            onClick={() => {
              if (!preparedFood && lines.some((l) => !lineIsPrepared(l))) {
                alert("Remove non-prepared items first, then switch to a prepared food receipt.");
                return;
              }
              setPreparedFood(!preparedFood);
            }}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium border transition-colors w-fit ${
              preparedFood
                ? "border-amber-500 bg-amber-50 text-amber-700"
                : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
            }`}
          >
            <ChefHat className="w-4 h-4" />
            {preparedFood ? "Prepared food — no cost or expense" : "Prepared food?"}
          </button>

          {/* Attach receipt */}
          {orgId && (
            <ReceiptUpload orgId={orgId} value={receiptPath} onUploaded={setReceiptPath} />
          )}

          {/* Linked PO badge */}
          {linkedPO && (
            <div className="flex items-center gap-2 px-3 py-2 bg-indigo-50 border border-indigo-200 rounded-lg text-sm text-indigo-700 w-fit">
              <ClipboardList className="w-4 h-4" />
              <span>Loaded from <span className="font-medium">{linkedPO.number}</span> — saving will mark it received</span>
              <button
                onClick={() => setLinkedPO(null)}
                className="text-indigo-400 hover:text-indigo-600 ml-1"
                aria-label="Unlink purchase order"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Add item / Load from PO buttons */}
          <div className="flex gap-2">
            <Button onClick={() => setShowPicker(true)} variant="secondary">
              <Plus className="w-4 h-4 mr-2" /> Add Item
            </Button>
            {openPOs.length > 0 && (
              <Button onClick={() => setShowPOPicker(true)} variant="secondary">
                <ClipboardList className="w-4 h-4 mr-2" /> Load from PO
              </Button>
            )}
          </div>

          {/* PO picker dropdown */}
          {showPOPicker && (
            <div className="bg-white border border-gray-200 rounded-xl shadow-lg p-4">
              <div className="relative mb-3">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  value={poSearch}
                  onChange={(e) => setPoSearch(e.target.value)}
                  placeholder="Search PO number or supplier..."
                  className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
                  autoFocus
                />
              </div>
              <div className="max-h-60 overflow-y-auto space-y-1">
                {openPOs
                  .filter((po) => {
                    const q = poSearch.toLowerCase();
                    return !q || po.po_number.toLowerCase().includes(q) || (po.supplier || "").toLowerCase().includes(q);
                  })
                  .map((po) => (
                    <button
                      key={po.id}
                      onClick={() => loadPurchaseOrder(po)}
                      disabled={loadingPO}
                      className="w-full text-left px-3 py-2 rounded-lg hover:bg-indigo-50 text-sm flex items-center justify-between disabled:opacity-50"
                    >
                      <span>
                        <span className="font-medium">{po.po_number}</span>
                        {po.supplier && <span className="text-gray-500 ml-2">{po.supplier}</span>}
                      </span>
                      <span className="text-xs text-gray-400">{formatZAR(po.total_cost)}</span>
                    </button>
                  ))}
              </div>
              <div className="mt-3 pt-3 border-t">
                <Button variant="ghost" size="sm" onClick={() => { setShowPOPicker(false); setPoSearch(""); }}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {/* Item picker dropdown */}
          {showPicker && (
            <div className="bg-white border border-gray-200 rounded-xl shadow-lg p-4">
              <div className="relative mb-3">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search products or ingredients..."
                  className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
                  autoFocus
                />
              </div>
              <div className="max-h-60 overflow-y-auto space-y-1">
                {filteredProducts.length > 0 && (
                  <>
                    <p className="text-xs font-semibold text-gray-500 uppercase px-2 py-1">Products</p>
                    {filteredProducts.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => addLine("product", p)}
                        className="w-full text-left px-3 py-2 rounded-lg hover:bg-green-50 text-sm flex items-center justify-between"
                      >
                        <span>
                          <span className="text-xs font-mono text-gray-400 mr-2">{p.inventory_id}</span>
                          {p.name}
                        </span>
                        <span className="text-xs text-gray-400">Stock: {p.opening_stock}</span>
                      </button>
                    ))}
                  </>
                )}
                {filteredPrepared.length > 0 && (
                  <>
                    <p className="text-xs font-semibold text-gray-500 uppercase px-2 py-1 mt-2">Prepared Items (no cost)</p>
                    {filteredPrepared.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => addLine("product", p)}
                        className="w-full text-left px-3 py-2 rounded-lg hover:bg-amber-50 text-sm flex items-center justify-between"
                      >
                        <span>
                          <span className="text-xs font-mono text-gray-400 mr-2">{p.inventory_id}</span>
                          {p.name}
                          <span className="ml-2 text-xs text-amber-600">Prepared</span>
                        </span>
                        <span className="text-xs text-gray-400">Stock: {p.opening_stock}</span>
                      </button>
                    ))}
                  </>
                )}
                {filteredIngredients.length > 0 && (
                  <>
                    <p className="text-xs font-semibold text-gray-500 uppercase px-2 py-1 mt-2">Ingredients</p>
                    {filteredIngredients.map((i) => (
                      <button
                        key={i.id}
                        onClick={() => addLine("ingredient", i)}
                        className="w-full text-left px-3 py-2 rounded-lg hover:bg-blue-50 text-sm flex items-center justify-between"
                      >
                        <span>{i.name}</span>
                        <span className="text-xs text-gray-400">Stock: {i.current_stock} {i.unit}</span>
                      </button>
                    ))}
                  </>
                )}
                {filteredProducts.length === 0 && filteredPrepared.length === 0 && filteredIngredients.length === 0 && (
                  <p className="text-sm text-gray-400 text-center py-4">No items found</p>
                )}
              </div>
              <div className="mt-3 pt-3 border-t">
                <Button variant="ghost" size="sm" onClick={() => { setShowPicker(false); setSearch(""); }}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {/* Lines table */}
          {lines.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-gray-700">Item</th>
                    <th className="text-center px-4 py-3 font-medium text-gray-700 w-28">Qty</th>
                    <th className="text-center px-4 py-3 font-medium text-gray-700 w-32">Unit Cost (R)</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-700 w-28">Line Total</th>
                    <th className="w-12" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {lines.map((l) => (
                    <tr key={l.id}>
                      <td className="px-4 py-3">
                        <span className="font-medium">{l.itemName}</span>
                        {l.inventoryId && (
                          <span className="text-xs text-gray-400 ml-2 font-mono">{l.inventoryId}</span>
                        )}
                        <span className={`ml-2 text-xs px-1.5 py-0.5 rounded ${l.type === "product" ? "bg-green-50 text-green-700" : "bg-blue-50 text-blue-700"}`}>
                          {l.type}
                        </span>
                        {l.type === "product" && l.qtyInPack > 1 && (
                          <span className="block text-xs text-gray-400 mt-0.5">
                            {l.quantity || 0} pack{l.quantity !== 1 ? "s" : ""} × {l.qtyInPack} = {Math.round((typeof l.quantity === "number" ? l.quantity : 0) * l.qtyInPack)} units
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <input
                          type="number"
                          min="0"
                          step={l.type === "ingredient" ? "0.01" : "1"}
                          value={l.quantity}
                          placeholder="0"
                          onChange={(e) => {
                            const raw = e.target.value;
                            if (raw === "") { updateLine(l.id, "quantity", ""); return; }
                            updateLine(l.id, "quantity", parseFloat(raw) || 0);
                          }}
                          className="w-full text-center border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={l.unitCost}
                          onChange={(e) => updateLine(l.id, "unitCost", parseFloat(e.target.value) || 0)}
                          className="w-full text-center border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500"
                        />
                      </td>
                      <td className="px-4 py-3 text-right font-medium">{formatZAR((typeof l.quantity === "number" ? l.quantity : 0) * l.unitCost)}</td>
                      <td className="px-2 py-3">
                        <Tooltip label="Remove item">
                          <button
                            onClick={() => removeLine(l.id)}
                            aria-label="Remove item"
                            className="p-1.5 text-gray-400 hover:text-red-600 rounded"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </Tooltip>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-gray-50">
                  <tr>
                    <td colSpan={3} className="px-4 py-3 text-right font-semibold text-gray-700">Total</td>
                    <td className="px-4 py-3 text-right font-bold text-lg text-gray-900">{formatZAR(totalCost)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {/* Options */}
          {lines.length > 0 && (
            <div className="space-y-4">
              {!preparedFood && (
                <>
                  <div>
                    <p className="text-sm font-medium text-gray-700 mb-2">How was this paid?</p>
                    <div className="flex flex-wrap gap-2">
                      {([
                        { key: "cash", label: "Cash" },
                        { key: "account", label: "On account" },
                        { key: "electronic", label: "EFT / card" },
                      ] as const).map((opt) => (
                        <button
                          key={opt.key}
                          type="button"
                          onClick={() => setPaidBy(opt.key)}
                          className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                            paidBy === opt.key
                              ? "border-green-500 bg-green-50 text-green-700"
                              : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                    <p className="text-xs text-gray-500 mt-2">
                      {paidBy === "account"
                        ? "Counted as cash spent on the day you pay the supplier, not today."
                        : "Counted as money out today on the Cash spent report."}
                    </p>
                  </div>

                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={createExpense}
                      onChange={(e) => setCreateExpense(e.target.checked)}
                      className="rounded border-gray-300 text-green-600 focus:ring-green-500"
                    />
                    Also record as &quot;Stock Purchases&quot; expense
                  </label>
                </>
              )}

              <div className="flex items-center justify-end gap-3">
                <Button onClick={handleSave} loading={saving} disabled={lines.length === 0}>
                  <Save className="w-4 h-4 mr-2" />
                  Save Receipt{preparedFood ? "" : ` — ${formatZAR(totalCost)}`}
                </Button>
              </div>
            </div>
          )}

          {success && (
            <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm">
              Stock receipt saved successfully. Product and ingredient stock levels have been updated.
            </div>
          )}
        </div>
      )}

      {tab === "history" && (
        <div className="space-y-3">
          {history.length === 0 ? (
            <div className="text-center py-12 text-gray-400">
              <PackagePlus className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p>No stock receipts recorded yet.</p>
            </div>
          ) : (
            history.map((r) => {
              const isExpanded = expandedReceipt === r.id;
              const items = receiptItems[r.id] || [];
              const isEditing = editingReceipt === r.id;
              const isAdmin = role === "admin";
              return (
                <div key={r.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                  <button
                    onClick={() => toggleExpand(r.id)}
                    className="w-full px-5 py-4 flex items-center justify-between text-left hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      {isExpanded
                        ? <ChevronDown className="w-4 h-4 text-gray-400 shrink-0" />
                        : <ChevronRight className="w-4 h-4 text-gray-400 shrink-0" />}
                      <div>
                        <p className="font-medium text-gray-900">{r.supplier || "No supplier"}</p>
                        <p className="text-sm text-gray-500">
                          {formatDate(r.receipt_date)} · {r.recorded_by || "Unknown"}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <p className="text-lg font-bold text-gray-900">{formatZAR(r.total_cost)}</p>
                      {r.receipt_path && (
                        <Tooltip label="View receipt">
                          <span
                            onClick={(e) => { e.stopPropagation(); setViewingReceipt(r.receipt_path); }}
                            className="p-1.5 text-gray-400 hover:text-green-600 rounded"
                          >
                            <Paperclip className="w-4 h-4" />
                          </span>
                        </Tooltip>
                      )}
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="border-t border-gray-100 px-5 py-3">
                      {items.length === 0 ? (
                        <p className="text-sm text-gray-400 py-2">Loading items...</p>
                      ) : (
                        <>
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="text-left text-gray-500 text-xs uppercase tracking-wide">
                                <th className="pb-2 font-medium">Item</th>
                                <th className="pb-2 font-medium text-center">Qty</th>
                                <th className="pb-2 font-medium text-right">Unit Cost</th>
                                <th className="pb-2 font-medium text-right">Total</th>
                              </tr>
                            </thead>
                            <tbody>
                              {items.map((it) => (
                                <tr key={it.id} className="border-t border-gray-50">
                                  <td className="py-2 text-gray-900">
                                    {it.item_name}
                                    <span className="ml-1.5 text-xs text-gray-400">
                                      ({it.item_type === "product" ? "Product" : "Ingredient"})
                                    </span>
                                  </td>
                                  <td className="py-2 text-center">
                                    {isEditing ? (
                                      <input
                                        type="number"
                                        min="0.01"
                                        step="0.01"
                                        value={editDraft[it.id]?.quantity ?? it.quantity}
                                        onChange={(e) => setEditDraft((prev) => ({
                                          ...prev,
                                          [it.id]: { ...prev[it.id], quantity: parseFloat(e.target.value) || 0 },
                                        }))}
                                        className="w-20 text-center border border-gray-300 rounded px-1 py-0.5 text-sm"
                                      />
                                    ) : it.quantity}
                                  </td>
                                  <td className="py-2 text-right">
                                    {isEditing ? (
                                      <input
                                        type="number"
                                        min="0"
                                        step="0.01"
                                        value={editDraft[it.id]?.unit_cost ?? it.unit_cost}
                                        onChange={(e) => setEditDraft((prev) => ({
                                          ...prev,
                                          [it.id]: { ...prev[it.id], unit_cost: parseFloat(e.target.value) || 0 },
                                        }))}
                                        className="w-24 text-right border border-gray-300 rounded px-1 py-0.5 text-sm"
                                      />
                                    ) : formatZAR(it.unit_cost)}
                                  </td>
                                  <td className="py-2 text-right font-medium">
                                    {isEditing
                                      ? formatZAR((editDraft[it.id]?.quantity ?? it.quantity) * (editDraft[it.id]?.unit_cost ?? it.unit_cost))
                                      : formatZAR(it.line_total)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>

                          <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-100">
                            <button
                              onClick={() => shareReceiptWhatsApp(r, items)}
                              className="text-sm text-green-600 hover:text-green-700 flex items-center gap-1"
                            >
                              <Send className="w-3.5 h-3.5" /> WhatsApp
                            </button>
                            <button
                              onClick={() => exportReceiptPDF(r, items)}
                              className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1"
                            >
                              <FileDown className="w-3.5 h-3.5" /> PDF
                            </button>
                            <button
                              onClick={() => copyReceiptText(r, items)}
                              className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1"
                            >
                              {copiedReceiptId === r.id ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
                              {copiedReceiptId === r.id ? "Copied" : "Copy"}
                            </button>
                          </div>

                          {isAdmin && (
                            <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-100">
                              {isEditing ? (
                                <>
                                  <Button size="sm" onClick={() => saveEdit(r.id)} loading={savingEdit}>
                                    <Check className="w-3.5 h-3.5 mr-1" /> Save
                                  </Button>
                                  <button
                                    onClick={() => setEditingReceipt(null)}
                                    className="text-sm text-gray-500 hover:text-gray-700 px-2 py-1"
                                  >
                                    Cancel
                                  </button>
                                </>
                              ) : (
                                <button
                                  onClick={() => startEdit(r.id, items)}
                                  className="text-sm text-gray-500 hover:text-green-600 flex items-center gap-1"
                                >
                                  <Pencil className="w-3.5 h-3.5" /> Edit
                                </button>
                              )}
                              {!r.receipt_path && !isEditing && (
                                <>
                                  {attachingReceipt === r.id ? (
                                    <div className="flex items-center gap-2 ml-auto">
                                      <ReceiptUpload orgId={orgId!} onUploaded={(path) => handleAttachReceipt(r.id, path)} />
                                      <button
                                        onClick={() => setAttachingReceipt(null)}
                                        className="text-sm text-gray-400 hover:text-gray-600"
                                      >
                                        <X className="w-4 h-4" />
                                      </button>
                                    </div>
                                  ) : (
                                    <button
                                      onClick={() => setAttachingReceipt(r.id)}
                                      className="text-sm text-gray-500 hover:text-green-600 flex items-center gap-1 ml-auto"
                                    >
                                      <Paperclip className="w-3.5 h-3.5" /> Attach receipt
                                    </button>
                                  )}
                                </>
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      <ReceiptViewer path={viewingReceipt} onClose={() => setViewingReceipt(null)} />
    </div>
  );
}
