"use client";
import { useState, useRef } from "react";
import { db } from "@/lib/supabase";
import { fetchAllPaged } from "@/lib/fetch-all";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
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

/**
 * Parse one CSV line into fields, honouring quoted values.
 *
 * A naive `line.split(",")` stored the raw CSV escaping verbatim: a value like
 * `10" High cake box`, which a spreadsheet exports as the escaped
 * `"10"" High cake box"`, landed in the database with its wrapping quotes and
 * doubled inner quote intact. This unwraps `"…"` fields and collapses `""` back
 * to a single `"`. Commas inside a quoted field are preserved too. Unquoted
 * fields are trimmed (matching the old behaviour); quoted content is kept as-is.
 *
 * Line-based: embedded newlines inside a quoted field are not supported, which
 * is fine for the SKU catalogues this importer handles.
 */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let field = "";
  let inQuotes = false;
  let quoted = false;
  const push = () => {
    result.push(quoted ? field : field.trim());
    field = "";
    quoted = false;
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
      quoted = true;
    } else if (ch === ",") {
      push();
    } else {
      field += ch;
    }
  }
  push();
  return result;
}

export function WmsCsvUploadModal({ open, onClose, onComplete }: Props) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<"upload" | "preview" | "done">("upload");
  const [items, setItems] = useState<ParsedItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState<{
    added: number; updated: number; skipped: number; failures: string[];
  }>({ added: 0, updated: 0, skipped: 0, failures: [] });

  function reset() {
    setStep("upload");
    setItems([]);
    setProgress({ done: 0, total: 0 });
    setResults({ added: 0, updated: 0, skipped: 0, failures: [] });
    if (fileRef.current) fileRef.current.value = "";
  }

  function handleClose() {
    reset();
    onClose();
  }

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }

  async function handleFile(file: File) {
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter((l: string) => l.trim());
    if (lines.length < 2) {
      toast.error("CSV must have a header row and at least one data row.");
      return;
    }

    // Parse header
    const header = parseCsvLine(lines[0]).map((h: string) => h.toLowerCase().replace(/\s+/g, "_"));
    const skuIdx = header.indexOf("sku");
    const nameIdx = header.findIndex((h: string) => h === "item_name" || h === "name" || h === "product_name");

    if (skuIdx === -1 || nameIdx === -1) {
      toast.error("CSV must have 'sku' and 'item_name' (or 'name') columns.");
      return;
    }

    const catIdx = header.indexOf("category");
    const packIdx = header.findIndex((h: string) => h === "pack_size" || h === "pack");
    const reorderLvlIdx = header.findIndex((h: string) => h === "reorder_level" || h === "min_stock");
    const reorderQtyIdx = header.findIndex((h: string) => h === "reorder_qty" || h === "order_qty");

    // Parse rows
    const rows: CsvRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCsvLine(lines[i]);
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
      toast.error("No valid data rows found.");
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

  /** Rows per request. A 1,300-item catalogue becomes ~3 catalog round-trips
   *  plus ~3 inventory ones, instead of the ~4,000 sequential requests the
   *  row-at-a-time loop used to make. */
  const CHUNK = 500;

  function chunked<T>(rows: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
    return out;
  }

  async function handleImport() {
    setSaving(true);
    setProgress({ done: 0, total: items.length });

    let added = 0;
    let updated = 0;
    let skipped = 0;
    // A skipped row used to vanish into a bare count. Keep the SKU and the
    // reason so the operator can see what did not land and fix the file.
    const failures: string[] = [];

    // Reorder levels are applied to wms_inventory, which is keyed by the
    // catalog id — an id we only learn after the write. Keep them by SKU and
    // join back to whatever the database hands us.
    const reorderBySku = new Map<string, { level: number; qty: number }>();
    items.forEach(({ csvRow: r }) => {
      reorderBySku.set(r.sku, {
        level: parseInt(r.reorder_level || "10") || 10,
        qty: parseInt(r.reorder_qty || "50") || 50,
      });
    });

    const catalogRow = (item: ParsedItem) => {
      const r = item.csvRow;
      return {
        // org_id is omitted deliberately: the column defaults to
        // default_user_org_id(), so the tenant is decided server-side and a
        // client can't write into someone else's org.
        ...(item.existingId ? { id: item.existingId } : {}),
        sku: r.sku,
        item_name: r.item_name,
        category: r.category || null,
        pack_size: parseInt(r.pack_size || "1") || 1,
      };
    };

    try {
      // Drop SKUs repeated *within the file* before writing anything.
      //
      // This matters more now that writes are batched: Postgres rejects an
      // INSERT ... ON CONFLICT that touches the same key twice ("cannot affect
      // row a second time"), so a single duplicated SKU would fail its whole
      // 500-row batch. Row-at-a-time only lost the duplicate itself. Last
      // occurrence wins, which matches how a person edits a spreadsheet.
      const bySku = new Map<string, ParsedItem>();
      const duplicates: string[] = [];
      for (const item of items) {
        if (bySku.has(item.csvRow.sku)) duplicates.push(item.csvRow.sku);
        bySku.set(item.csvRow.sku, item);
      }
      if (duplicates.length > 0) {
        skipped += duplicates.length;
        [...new Set(duplicates)].forEach((sku) =>
          failures.push(`${sku}: duplicated in the CSV — kept the last row`)
        );
      }
      const unique = [...bySku.values()];
      setProgress({ done: 0, total: unique.length });

      // New items and existing ones are written the same way — an upsert. New
      // rows insert (and the trg_wms_catalog_inventory trigger creates their
      // inventory row); existing rows carry their primary key and so resolve to
      // an update on conflict. `sku` is included on the update path too: the
      // proposed tuple is NOT NULL-checked before the conflict is resolved.
      const toInsert = unique.filter((i) => !i.existingId);
      const toUpdate = unique.filter((i) => i.existingId);

      // (catalog id, org_id) for every row we successfully wrote, so the
      // inventory pass can address the trigger-created rows.
      const written: { id: number; org_id: string; sku: string }[] = [];
      let done = 0;

      for (const [rows, isNew] of [
        [toInsert, true] as const,
        [toUpdate, false] as const,
      ]) {
        for (const batch of chunked(rows, CHUNK)) {
          const payload = batch.map(catalogRow);
          const { data, error } = isNew
            ? await db.from("wms_catalog").insert(payload).select("id, org_id, sku")
            : await db.from("wms_catalog").upsert(payload).select("id, org_id, sku");

          if (error) {
            // One bad row rejects its whole batch, so name the batch rather
            // than pretending we know which SKU was at fault.
            console.error("Batch failed", error, batch.map((b) => b.csvRow.sku));
            failures.push(
              `${batch.length} row${batch.length !== 1 ? "s" : ""} (${batch[0].csvRow.sku}…${batch[batch.length - 1].csvRow.sku}): ${error.message}`
            );
            skipped += batch.length;
          } else {
            const rowsBack = (data || []) as { id: number; org_id: string; sku: string }[];
            written.push(...rowsBack);
            if (isNew) added += rowsBack.length;
            else updated += rowsBack.length;
          }
          done += batch.length;
          setProgress((p) => ({ ...p, done }));
        }
      }

      // Apply reorder levels. An upsert on (org_id, wms_item_id): the row
      // already exists (trigger or prior import), so this resolves to an update
      // of just these two columns — physical_qty is not in the payload and is
      // therefore never clobbered.
      const inventoryPayload = written
        .map((w) => {
          const ro = reorderBySku.get(w.sku);
          if (!ro) return null;
          return {
            org_id: w.org_id,
            wms_item_id: w.id,
            reorder_level: ro.level,
            reorder_qty: ro.qty,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      for (const batch of chunked(inventoryPayload, CHUNK)) {
        const { error } = await db
          .from("wms_inventory")
          .upsert(batch, { onConflict: "org_id,wms_item_id" });
        if (error) {
          console.error("Inventory batch failed", error);
          failures.push(`Reorder levels for ${batch.length} items: ${error.message}`);
        }
      }

      setResults({ added, updated, skipped, failures });
      setStep("done");
    } catch (err) {
      console.error("Import error:", err);
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error("Import failed", { hint: message });
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
          <div
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragEnter={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              const f = e.dataTransfer.files[0];
              if (f && f.name.toLowerCase().endsWith(".csv")) handleFile(f);
            }}
            className={`border-2 border-dashed border-gray-300 rounded-xl p-8 text-center ${isDragging ? "ring-2 ring-green-500 bg-green-50" : ""}`}
          >
            <Upload className="w-8 h-8 mx-auto text-gray-400 mb-2" />
            <p className="text-sm text-gray-500 mb-3">Select a CSV file</p>
            <input
              ref={fileRef}
              type="file"
              accept=".csv"
              onChange={handleFileInputChange}
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
              {saving
                ? `Importing… ${progress.done} / ${progress.total}`
                : `Import ${items.length} items`}
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
