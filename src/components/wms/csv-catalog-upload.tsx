"use client";
import { useState, useRef } from "react";
import { db } from "@/lib/supabase";
import { fetchAllPaged } from "@/lib/fetch-all";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Upload, Download, Check } from "lucide-react";

interface CsvRow {
  sku: string;
  item_name: string;
  category?: string;
  pack_size?: string;
  reorder_level?: string;
  reorder_qty?: string;
}

interface ParsedItem {
  csvRow: CsvRow;
  existing: boolean;
  existingId: number | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onComplete: () => void;
}

export function WmsCsvUploadModal({ open, onClose, onComplete }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<"upload" | "preview" | "done">("upload");
  const [items, setItems] = useState<ParsedItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [results, setResults] = useState<{
    added: number; updated: number; skipped: number; failures: string[];
  }>({ added: 0, updated: 0, skipped: 0, failures: [] });

  function reset() {
    setStep("upload");
    setItems([]);
    setResults({ added: 0, updated: 0, skipped: 0, failures: [] });
    if (fileRef.current) fileRef.current.value = "";
  }

  function handleClose() {
    reset();
    onClose();
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const text = await file.text();
    const lines = text.split(/\r?\n/).filter((l: string) => l.trim());
    if (lines.length < 2) {
      alert("CSV must have a header row and at least one data row.");
      return;
    }

    // Parse header
    const header = lines[0].split(",").map((h: string) => h.trim().toLowerCase().replace(/\s+/g, "_"));
    const skuIdx = header.indexOf("sku");
    const nameIdx = header.findIndex((h: string) => h === "item_name" || h === "name" || h === "product_name");

    if (skuIdx === -1 || nameIdx === -1) {
      alert("CSV must have 'sku' and 'item_name' (or 'name') columns.");
      return;
    }

    const catIdx = header.indexOf("category");
    const packIdx = header.findIndex((h: string) => h === "pack_size" || h === "pack");
    const reorderLvlIdx = header.findIndex((h: string) => h === "reorder_level" || h === "min_stock");
    const reorderQtyIdx = header.findIndex((h: string) => h === "reorder_qty" || h === "order_qty");

    // Parse rows
    const rows: CsvRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",").map((c: string) => c.trim());
      const sku = cols[skuIdx];
      const name = cols[nameIdx];
      if (!sku || !name) continue;

      rows.push({
        sku,
        item_name: name,
        category: catIdx >= 0 ? cols[catIdx] : undefined,
        pack_size: packIdx >= 0 ? cols[packIdx] : undefined,
        reorder_level: reorderLvlIdx >= 0 ? cols[reorderLvlIdx] : undefined,
        reorder_qty: reorderQtyIdx >= 0 ? cols[reorderQtyIdx] : undefined,
      });
    }

    if (rows.length === 0) {
      alert("No valid data rows found.");
      return;
    }

    // Check which SKUs already exist.
    //
    // Paginated: a plain select is capped at Supabase's max_rows (default 1000),
    // so on a catalogue bigger than that every SKU past row 1000 looked "new".
    // The importer would then INSERT it, hit the UNIQUE (org_id, sku)
    // constraint, and silently bump `skipped` — so re-importing a 1,300-item
    // catalogue quietly did nothing for the tail of the file.
    const existing = await fetchAllPaged<{ id: number; sku: string }>(() =>
      db.from("wms_catalog").select("id, sku").order("id")
    );

    const existingMap = new Map<string, number>();
    existing.forEach((row) => {
      existingMap.set(row.sku, row.id);
    });

    const parsed: ParsedItem[] = rows.map((row: CsvRow) => ({
      csvRow: row,
      existing: existingMap.has(row.sku),
      existingId: existingMap.get(row.sku) ?? null,
    }));

    setItems(parsed);
    setStep("preview");
  }

  async function handleImport() {
    setSaving(true);
    let added = 0;
    let updated = 0;
    let skipped = 0;
    // A skipped row used to vanish into a bare count. Keep the SKU and the
    // reason so the operator can see what did not land and fix the file.
    const failures: string[] = [];

    try {
      for (const item of items) {
        const row = item.csvRow;
        const packSize = parseInt(row.pack_size || "1") || 1;
        const reorderLevel = parseInt(row.reorder_level || "10") || 10;
        const reorderQty = parseInt(row.reorder_qty || "50") || 50;

        if (item.existing && item.existingId) {
          // Update existing
          await db
            .from("wms_catalog")
            .update({
              item_name: row.item_name,
              category: row.category || null,
              pack_size: packSize,
            })
            .eq("id", item.existingId);

          await db
            .from("wms_inventory")
            .update({
              reorder_level: reorderLevel,
              reorder_qty: reorderQty,
            })
            .eq("wms_item_id", item.existingId);

          updated++;
        } else {
          // Insert new
          const { data: newItem, error: err } = await db
            .from("wms_catalog")
            .insert({
              sku: row.sku,
              item_name: row.item_name,
              category: row.category || null,
              pack_size: packSize,
            })
            .select("id")
            .single();

          if (err) {
            console.error("Failed to insert", row.sku, err);
            failures.push(`${row.sku}: ${err.message}`);
            skipped++;
            continue;
          }

          // The trg_wms_catalog_inventory trigger already created the
          // inventory row; apply this row's reorder levels to it.
          await db
            .from("wms_inventory")
            .update({
              reorder_level: reorderLevel,
              reorder_qty: reorderQty,
            })
            .eq("wms_item_id", (newItem as any).id);

          added++;
        }
      }

      setResults({ added, updated, skipped, failures });
      setStep("done");
    } catch (err: any) {
      console.error("Import error:", err);
      alert("Import failed: " + (err.message || "Unknown error"));
    } finally {
      setSaving(false);
    }
  }

  function downloadTemplate() {
    const csv = "sku,item_name,category,pack_size,reorder_level,reorder_qty\nCHIPS-LAY-36,Lays Original 36-pack,Snacks,36,10,50\nCOKE-330-24,Coca-Cola 330ml x24,Soft Drinks,24,5,20\n";
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "wms_catalog_template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const newCount = items.filter((i: ParsedItem) => !i.existing).length;
  const existCount = items.filter((i: ParsedItem) => i.existing).length;

  return (
    <Modal open={open} onClose={handleClose} title="Import WMS Catalog (CSV)" wide>
      {step === "upload" && (
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Upload a CSV file with warehouse catalog items. Required columns: <strong>sku</strong> and{" "}
            <strong>item_name</strong>. Optional: category, pack_size, reorder_level, reorder_qty.
          </p>
          <div className="flex gap-3">
            <Button
              variant="secondary"
              size="sm"
              onClick={downloadTemplate}
            >
              <Download className="w-4 h-4 mr-1" />
              Download Template
            </Button>
          </div>
          <div className="border-2 border-dashed border-gray-300 rounded-xl p-8 text-center">
            <Upload className="w-8 h-8 mx-auto text-gray-400 mb-2" />
            <p className="text-sm text-gray-500 mb-3">Select a CSV file</p>
            <input
              ref={fileRef}
              type="file"
              accept=".csv"
              onChange={handleFile}
              className="text-sm"
            />
          </div>
        </div>
      )}

      {step === "preview" && (
        <div className="space-y-4">
          <div className="flex gap-3">
            <Badge variant="green">{newCount} new</Badge>
            <Badge variant="blue">{existCount} updates</Badge>
          </div>
          <div className="max-h-64 overflow-y-auto border border-gray-200 rounded-lg">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-gray-50">
                <tr className="border-b border-gray-200">
                  <th className="text-left px-3 py-2 font-medium text-gray-600">SKU</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-600">Item Name</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-600">Category</th>
                  <th className="text-right px-3 py-2 font-medium text-gray-600">Pack</th>
                  <th className="text-center px-3 py-2 font-medium text-gray-600">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.map((item: ParsedItem, i: number) => (
                  <tr key={i}>
                    <td className="px-3 py-2 font-mono text-xs">{item.csvRow.sku}</td>
                    <td className="px-3 py-2">{item.csvRow.item_name}</td>
                    <td className="px-3 py-2 text-gray-500">{item.csvRow.category || "—"}</td>
                    <td className="px-3 py-2 text-right">{item.csvRow.pack_size || "1"}</td>
                    <td className="px-3 py-2 text-center">
                      <Badge variant={item.existing ? "blue" : "green"}>
                        {item.existing ? "Update" : "New"}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={reset}>
              Back
            </Button>
            <Button onClick={handleImport} disabled={saving}>
              {saving ? "Importing..." : `Import ${items.length} items`}
            </Button>
          </div>
        </div>
      )}

      {step === "done" && (
        <div className="text-center py-4 space-y-3">
          <Check className="w-10 h-10 mx-auto text-green-500" />
          <p className="text-lg font-semibold text-gray-900">Import Complete</p>
          <div className="flex justify-center gap-3">
            <Badge variant="green">{results.added} added</Badge>
            <Badge variant="blue">{results.updated} updated</Badge>
            {results.skipped > 0 && (
              <Badge variant="amber">{results.skipped} skipped</Badge>
            )}
          </div>
          {results.failures.length > 0 && (
            <div className="mx-auto max-w-md text-left">
              <p className="text-xs font-medium text-amber-800 mb-1">
                These rows did not import:
              </p>
              <ul className="max-h-32 overflow-y-auto rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 space-y-0.5">
                {results.failures.slice(0, 20).map((msg) => (
                  <li key={msg} className="font-mono">{msg}</li>
                ))}
                {results.failures.length > 20 && (
                  <li className="text-amber-700">
                    …and {results.failures.length - 20} more (see the browser console)
                  </li>
                )}
              </ul>
            </div>
          )}
          <Button
            onClick={() => {
              handleClose();
              onComplete();
            }}
          >
            Done
          </Button>
        </div>
      )}
    </Modal>
  );
}
