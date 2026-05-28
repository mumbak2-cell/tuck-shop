"use client";
import { useState, useRef } from "react";
import { db } from "@/lib/supabase";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Upload, Download, Check } from "lucide-react";

interface CsvRow {
  inventory_id?: string;
  category?: string;
  name: string;
  opening_stock?: string;
  package_price?: string;
  qty_in_pack?: string;
  selling_price?: string;
}

interface MatchResult {
  csvRow: CsvRow;
  productId: string | null;
  productName: string | null;
  inventoryId: string | null;
  changes: string[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  onComplete: () => void;
}

export function CsvUploadModal({ open, onClose, onComplete }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<"upload" | "preview" | "done">("upload");
  const [matches, setMatches] = useState<MatchResult[]>([]);
  const [saving, setSaving] = useState(false);
  const [results, setResults] = useState({ updated: 0, skipped: 0 });

  function reset() {
    setStep("upload");
    setMatches([]);
    setResults({ updated: 0, skipped: 0 });
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
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) {
      alert("CSV must have a header row and at least one data row.");
      return;
    }

    // Detect delimiter: semicolon or comma
    const firstLine = lines[0];
    const delimiter = firstLine.includes(";") ? ";" : ",";

    // Parse header
    const header = firstLine.split(delimiter).map((h) =>
      h.trim().toLowerCase().replace(/['"]/g, "").replace(/\s+/g, "_")
    );

    // Find key columns
    const idIdx = header.findIndex((h) => h === "inventory_id" || h === "id");
    const nameIdx = header.findIndex((h) => h === "name" || h === "description" || h === "product" || h === "product_name");

    if (idIdx === -1 && nameIdx === -1) {
      alert('CSV must have an "inventory_id" or "name" column.');
      return;
    }

    // Parse rows
    const csvRows: CsvRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = parseLine(lines[i], delimiter);
      const id = idIdx >= 0 ? cols[idIdx]?.trim() : undefined;
      const name = nameIdx >= 0 ? cols[nameIdx]?.trim() : "";
      if (!id && !name) continue;

      const row: CsvRow = { name: name || id || "" };
      if (id) row.inventory_id = id;

      header.forEach((h: string, idx: number) => {
        const val = cols[idx]?.trim();
        if (!val) return;
        if (h === "category") row.category = val;
        if (h === "opening_stock" || h === "stock" || h === "opening_units") row.opening_stock = val;
        if (h === "package_price" || h === "cost_price" || h === "cost" || h === "package_price_(r)") row.package_price = val;
        if (h === "qty_in_pack" || h === "pack_qty" || h === "quantity_in_pack") row.qty_in_pack = val;
        if (h === "selling_price" || h === "sale_price" || h === "price" || h === "sales_price") row.selling_price = val;
      });
      csvRows.push(row);
    }

    // Fetch all products
    const { data: products } = await db
      .from("products")
      .select("id, inventory_id, name, category, opening_stock, package_price, qty_in_pack, selling_price");

    const matchResults: MatchResult[] = csvRows.map((csvRow) => {
      // Match by inventory_id first, then fall back to name
      let match = csvRow.inventory_id
        ? ((products || []) as any[]).find((p: any) => p.inventory_id === csvRow.inventory_id)
        : null;
      if (!match) {
        match = ((products || []) as any[]).find(
          (p: any) => p.name.toLowerCase() === csvRow.name.toLowerCase()
        ) || null;
      }

      const changes: string[] = [];
      if (match) {
        if (csvRow.opening_stock !== undefined && csvRow.opening_stock !== "" && parseInt(csvRow.opening_stock) !== match.opening_stock) {
          changes.push(`Stock: ${match.opening_stock} → ${csvRow.opening_stock}`);
        }
        if (csvRow.package_price && parseFloat(csvRow.package_price) !== (match.package_price || 0)) {
          changes.push(`Cost: R${match.package_price || 0} → R${csvRow.package_price}`);
        }
        if (csvRow.qty_in_pack && parseInt(csvRow.qty_in_pack) !== (match.qty_in_pack || 0)) {
          changes.push(`Pack Qty: ${match.qty_in_pack || 0} → ${csvRow.qty_in_pack}`);
        }
        if (csvRow.selling_price && parseFloat(csvRow.selling_price) !== match.selling_price) {
          changes.push(`Price: R${match.selling_price} → R${csvRow.selling_price}`);
        }
      }

      return {
        csvRow,
        productId: match?.id || null,
        productName: match?.name || null,
        inventoryId: match?.inventory_id || csvRow.inventory_id || null,
        changes,
      };
    });

    setMatches(matchResults);
    setStep("preview");
  }

  async function applyUpdates() {
    setSaving(true);
    let updated = 0;
    let skipped = 0;

    for (const m of matches) {
      if (!m.productId || m.changes.length === 0) {
        skipped++;
        continue;
      }

      const update: Record<string, number> = {};
      if (m.csvRow.opening_stock !== undefined && m.csvRow.opening_stock !== "") update.opening_stock = parseInt(m.csvRow.opening_stock) || 0;
      if (m.csvRow.package_price) update.package_price = parseFloat(m.csvRow.package_price) || 0;
      if (m.csvRow.qty_in_pack) update.qty_in_pack = parseInt(m.csvRow.qty_in_pack) || 0;
      if (m.csvRow.selling_price) update.selling_price = parseFloat(m.csvRow.selling_price) || 0;

      const { error } = await db
        .from("products")
        .update(update)
        .eq("id", m.productId);

      if (error) skipped++;
      else updated++;
    }

    setResults({ updated, skipped });
    setStep("done");
    setSaving(false);
  }

  async function downloadTemplate() {
    const { data: products } = await db
      .from("products")
      .select("inventory_id, category, name, opening_stock, package_price, qty_in_pack, selling_price")
      .eq("discontinued", false)
      .order("inventory_id");

    const header = "inventory_id,category,name,package_price,qty_in_pack,selling_price,opening_stock";
    const rows = ((products || []) as any[]).map(
      (p: any) => `${p.inventory_id},"${p.category}","${p.name}",${p.package_price || 0},${p.qty_in_pack || 0},${p.selling_price},${p.opening_stock}`
    );
    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "tuckshop_stock_template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const matched = matches.filter((m) => m.productId);
  const unmatched = matches.filter((m) => !m.productId);
  const withChanges = matches.filter((m) => m.productId && m.changes.length > 0);

  return (
    <Modal open={open} onClose={handleClose} title="CSV Import" wide>
      {step === "upload" && (
        <div className="space-y-6">
          <p className="text-sm text-gray-600">
            Upload a CSV to bulk-update stock, cost prices, and selling prices.
            Match is by <strong>inventory_id</strong> first (e.g. IN0001), then by product name as fallback.
            Supports both comma and semicolon delimiters.
          </p>

          <div className="bg-gray-50 rounded-lg p-4">
            <p className="text-xs font-medium text-gray-700 mb-2">Supported columns:</p>
            <div className="grid grid-cols-2 gap-1 text-xs text-gray-600">
              <span><strong>inventory_id</strong> — e.g. IN0001 (primary match)</span>
              <span><strong>name</strong> — product name (fallback match)</span>
              <span><strong>category</strong> — product category</span>
              <span><strong>opening_stock</strong> — current stock count</span>
              <span><strong>package_price</strong> — cost price per pack</span>
              <span><strong>qty_in_pack</strong> — units per pack</span>
              <span><strong>selling_price</strong> — selling price per unit</span>
            </div>
          </div>

          <div className="flex gap-3">
            <Button onClick={downloadTemplate} variant="secondary" className="flex-1">
              <Download className="w-4 h-4 mr-2" />
              Download Template
            </Button>
            <label className="flex-1">
              <div className="flex items-center justify-center gap-2 px-4 py-2.5 bg-green-600 text-white rounded-lg text-sm font-medium cursor-pointer hover:bg-green-700 transition-colors">
                <Upload className="w-4 h-4" />
                Choose CSV File
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".csv"
                onChange={handleFile}
                className="hidden"
              />
            </label>
          </div>
        </div>
      )}

      {step === "preview" && (
        <div className="space-y-4">
          <div className="flex gap-3">
            <div className="flex-1 bg-green-50 rounded-lg px-3 py-2 text-sm">
              <span className="font-semibold text-green-700">{matched.length}</span>{" "}
              <span className="text-green-600">matched</span>
            </div>
            <div className="flex-1 bg-blue-50 rounded-lg px-3 py-2 text-sm">
              <span className="font-semibold text-blue-700">{withChanges.length}</span>{" "}
              <span className="text-blue-600">to update</span>
            </div>
            {unmatched.length > 0 && (
              <div className="flex-1 bg-red-50 rounded-lg px-3 py-2 text-sm">
                <span className="font-semibold text-red-700">{unmatched.length}</span>{" "}
                <span className="text-red-600">not found</span>
              </div>
            )}
          </div>

          <div className="max-h-72 overflow-y-auto space-y-2">
            {matches.map((m, idx) => (
              <div
                key={idx}
                className={`rounded-lg px-4 py-3 text-sm ${
                  !m.productId
                    ? "bg-red-50 border border-red-100"
                    : m.changes.length > 0
                    ? "bg-white border border-gray-200"
                    : "bg-gray-50 border border-gray-100"
                }`}
              >
                <div className="flex items-center gap-2">
                  {m.inventoryId && (
                    <span className="text-xs font-mono text-gray-400">{m.inventoryId}</span>
                  )}
                  <span className="font-medium text-gray-900">{m.productName || m.csvRow.name}</span>
                  {!m.productId && <Badge color="red">Not found</Badge>}
                  {m.productId && m.changes.length === 0 && <Badge color="gray">No changes</Badge>}
                </div>
                {m.changes.length > 0 && (
                  <div className="mt-1 text-xs text-gray-600">
                    {m.changes.join(" · ")}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="flex gap-3">
            <Button variant="secondary" onClick={reset} className="flex-1">
              Cancel
            </Button>
            <Button
              onClick={applyUpdates}
              loading={saving}
              disabled={withChanges.length === 0}
              className="flex-1"
            >
              Apply {withChanges.length} Update{withChanges.length !== 1 ? "s" : ""}
            </Button>
          </div>
        </div>
      )}

      {step === "done" && (
        <div className="flex flex-col items-center py-8">
          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mb-4">
            <Check className="w-8 h-8 text-green-600" />
          </div>
          <p className="text-xl font-bold text-gray-900">{results.updated} products updated</p>
          {results.skipped > 0 && (
            <p className="text-sm text-gray-500 mt-1">{results.skipped} skipped (no match or no changes)</p>
          )}
          <Button
            onClick={() => {
              handleClose();
              onComplete();
            }}
            className="mt-6"
          >
            Done
          </Button>
        </div>
      )}
    </Modal>
  );
}

/** Parse a CSV/semicolon-delimited line respecting quoted fields */
function parseLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}
