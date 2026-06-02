"use client";
import { useState, useRef } from "react";
import { db } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TruckIcon, Upload, Check, AlertTriangle } from "lucide-react";
import type { Product } from "@/types/database";
import { useShift } from "@/lib/shift-context";

interface StockPilotRow {
  inventoryId: string;
  category: string;
  description: string;
  qtyInPack: number;
  qtyCounted: number;
  store: string;
  counter: string;
  sessionDate: string;
}

interface MatchedRow {
  row: StockPilotRow;
  product: Product | null;
  currentStock: number;
  difference: number;
}

export default function StockPilotImportPage() {
  const { markStockCountDone } = useShift();
  const fileRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<"upload" | "preview" | "done">("upload");
  const [matches, setMatches] = useState<MatchedRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [results, setResults] = useState({ updated: 0, skipped: 0, notFound: 0 });
  const [fileInfo, setFileInfo] = useState({ store: "", counter: "", date: "" });

  function reset() {
    setStep("upload");
    setMatches([]);
    setResults({ updated: 0, skipped: 0, notFound: 0 });
    setFileInfo({ store: "", counter: "", date: "" });
    if (fileRef.current) fileRef.current.value = "";
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

    // Detect delimiter
    const delimiter = lines[0].includes(";") ? ";" : ",";

    // Parse header — StockPilot format:
    // Inventory ID;Category;Description;Qty In Pack;Qty Counted;Store;Counter;Session Date
    const header = lines[0].split(delimiter).map((h) =>
      h.trim().toLowerCase().replace(/['"]/g, "").replace(/\s+/g, "_")
    );

    const idIdx = header.findIndex((h) => h === "inventory_id" || h === "id");
    const descIdx = header.findIndex((h) => h === "description" || h === "name" || h === "product");
    const countedIdx = header.findIndex((h) => h === "qty_counted" || h === "closing_units" || h === "counted");
    const storeIdx = header.findIndex((h) => h === "store");
    const counterIdx = header.findIndex((h) => h === "counter");
    const dateIdx = header.findIndex((h) => h === "session_date" || h === "date");
    const catIdx = header.findIndex((h) => h === "category");
    const packIdx = header.findIndex((h) => h === "qty_in_pack" || h === "pack_qty");

    if (idIdx === -1 && descIdx === -1) {
      alert('StockPilot CSV must have an "Inventory ID" or "Description" column.');
      return;
    }
    if (countedIdx === -1) {
      alert('StockPilot CSV must have a "Qty Counted" column.');
      return;
    }

    // Parse rows
    const rows: StockPilotRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = parseLine(lines[i], delimiter);
      const invId = idIdx >= 0 ? cols[idIdx]?.trim() : "";
      const desc = descIdx >= 0 ? cols[descIdx]?.trim() : "";
      const counted = countedIdx >= 0 ? parseInt(cols[countedIdx]?.trim()) || 0 : 0;

      if (!invId && !desc) continue;

      rows.push({
        inventoryId: invId,
        category: catIdx >= 0 ? cols[catIdx]?.trim() || "" : "",
        description: desc || invId,
        qtyInPack: packIdx >= 0 ? parseInt(cols[packIdx]?.trim()) || 0 : 0,
        qtyCounted: counted,
        store: storeIdx >= 0 ? cols[storeIdx]?.trim() || "" : "",
        counter: counterIdx >= 0 ? cols[counterIdx]?.trim() || "" : "",
        sessionDate: dateIdx >= 0 ? cols[dateIdx]?.trim() || "" : "",
      });
    }

    if (rows.length === 0) {
      alert("No valid data rows found in the CSV.");
      return;
    }

    // Extract file info from first row
    setFileInfo({
      store: rows[0].store,
      counter: rows[0].counter,
      date: rows[0].sessionDate,
    });

    // Fetch all products for matching
    const { data: products } = await db
      .from("products")
      .select("*")
      .eq("discontinued", false);

    // Match rows to products
    const matched: MatchedRow[] = rows.map((row) => {
      let product: Product | null = null;

      // Match by inventory_id first
      if (row.inventoryId) {
        product = ((products || []) as any[]).find((p: any) => p.inventory_id === row.inventoryId) || null;
      }
      // Fall back to name match
      if (!product && row.description) {
        product = ((products || []) as any[]).find(
          (p: any) => p.name.toLowerCase() === row.description.toLowerCase()
        ) || null;
      }

      const currentStock = product?.opening_stock || 0;
      return {
        row,
        product,
        currentStock,
        difference: row.qtyCounted - currentStock,
      };
    });

    setMatches(matched);
    setStep("preview");
  }

  async function applyImport() {
    setSaving(true);
    let updated = 0;
    let skipped = 0;
    let notFound = 0;

    for (const m of matches) {
      if (!m.product) {
        notFound++;
        continue;
      }

      // Update opening_stock to the counted value
      if (m.row.qtyCounted !== m.currentStock) {
        const { error } = await db
          .from("products")
          .update({ opening_stock: m.row.qtyCounted })
          .eq("id", m.product.id);

        if (error) {
          skipped++;
        } else {
          updated++;
        }

        // Also record as a stock count for the day
        const countDate = m.row.sessionDate || new Date().toISOString().split("T")[0];
        const counter = m.row.counter || "StockPilot";
        await db.from("stock_counts").upsert(
          {
            count_date: countDate,
            product_id: m.product.id,
            opening_units: m.currentStock,
            closing_units: m.row.qtyCounted,
            replenished_units: 0,
            counted_by: `StockPilot (${counter})`,
            counted_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            update_count: 1,
          },
          { onConflict: "count_date,product_id" }
        );
      } else {
        skipped++;
      }
    }

    // Mark shift stock count as done
    if (updated > 0) {
      await markStockCountDone();
    }

    setResults({ updated, skipped, notFound });
    setStep("done");
    setSaving(false);
  }

  const matchedRows = matches.filter((m) => m.product);
  const unmatchedRows = matches.filter((m) => !m.product);
  const changedRows = matches.filter((m) => m.product && m.row.qtyCounted !== m.currentStock);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <TruckIcon className="w-7 h-7 text-green-600" />
          StockPilot Import
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Import stock-take results from your StockPilot offline app
        </p>
      </div>

      {step === "upload" && (
        <div className="max-w-xl space-y-6">
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <p className="text-sm text-gray-600 mb-4">
              Upload the CSV file exported from StockPilot after a stock count session.
              The system will match products by <strong>Inventory ID</strong> (e.g. IN0001)
              and update stock levels to the counted quantities.
            </p>

            <div className="bg-gray-50 rounded-lg p-4 mb-4">
              <p className="text-xs font-medium text-gray-700 mb-2">Expected StockPilot CSV format:</p>
              <code className="text-xs text-gray-600 block">
                Inventory ID;Category;Description;Qty In Pack;Qty Counted;Store;Counter;Session Date
              </code>
            </div>

            <label className="block">
              <div className="flex items-center justify-center gap-2 px-4 py-3 bg-green-600 text-white rounded-lg text-sm font-medium cursor-pointer hover:bg-green-700 transition-colors">
                <Upload className="w-4 h-4" />
                Choose StockPilot CSV
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
          {/* File info */}
          {(fileInfo.store || fileInfo.counter || fileInfo.date) && (
            <div className="bg-blue-50 border border-blue-100 rounded-xl px-5 py-3 text-sm">
              <p className="font-medium text-blue-800">
                Stock Count: {fileInfo.store || "Unknown store"}
              </p>
              <p className="text-blue-600">
                Counted by {fileInfo.counter || "Unknown"} on {fileInfo.date || "Unknown date"}
              </p>
            </div>
          )}

          {/* Summary badges */}
          <div className="flex gap-3">
            <div className="flex-1 bg-green-50 rounded-lg px-3 py-2 text-sm">
              <span className="font-semibold text-green-700">{matchedRows.length}</span>{" "}
              <span className="text-green-600">matched</span>
            </div>
            <div className="flex-1 bg-blue-50 rounded-lg px-3 py-2 text-sm">
              <span className="font-semibold text-blue-700">{changedRows.length}</span>{" "}
              <span className="text-blue-600">to update</span>
            </div>
            {unmatchedRows.length > 0 && (
              <div className="flex-1 bg-amber-50 rounded-lg px-3 py-2 text-sm">
                <span className="font-semibold text-amber-700">{unmatchedRows.length}</span>{" "}
                <span className="text-amber-600">not found</span>
              </div>
            )}
          </div>

          {/* Items list */}
          <div className="max-h-96 overflow-y-auto space-y-2">
            {matches.map((m, idx) => (
              <div
                key={idx}
                className={`rounded-lg px-4 py-3 text-sm border ${
                  !m.product
                    ? "bg-amber-50 border-amber-100"
                    : m.difference !== 0
                    ? "bg-white border-gray-200"
                    : "bg-gray-50 border-gray-100"
                }`}
              >
                <div className="flex items-center gap-2">
                  {m.row.inventoryId && (
                    <span className="text-xs font-mono text-gray-400">{m.row.inventoryId}</span>
                  )}
                  <span className="font-medium text-gray-900">
                    {m.product?.name || m.row.description}
                  </span>
                  {!m.product && <Badge color="amber">Not found in system</Badge>}
                  {m.product && m.difference === 0 && <Badge color="gray">No change</Badge>}
                </div>
                {m.product && m.difference !== 0 && (
                  <div className="mt-1 text-xs text-gray-600 flex items-center gap-1">
                    <span>System: {m.currentStock}</span>
                    <span className="text-gray-400">→</span>
                    <span>Counted: {m.row.qtyCounted}</span>
                    <span className={`ml-2 font-medium ${m.difference > 0 ? "text-green-600" : "text-red-600"}`}>
                      ({m.difference > 0 ? "+" : ""}{m.difference})
                    </span>
                  </div>
                )}
              </div>
            ))}
          </div>

          {unmatchedRows.length > 0 && (
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <p>
                {unmatchedRows.length} item(s) in the StockPilot file could not be matched to products in your system.
                Check that Inventory IDs match (e.g. IN0001). Unmatched items will be skipped.
              </p>
            </div>
          )}

          <div className="flex gap-3">
            <Button variant="secondary" onClick={reset} className="flex-1">
              Cancel
            </Button>
            <Button
              onClick={applyImport}
              loading={saving}
              disabled={changedRows.length === 0}
              className="flex-1"
            >
              Apply {changedRows.length} Stock Update{changedRows.length !== 1 ? "s" : ""}
            </Button>
          </div>
        </div>
      )}

      {step === "done" && (
        <div className="flex flex-col items-center py-12">
          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mb-4">
            <Check className="w-8 h-8 text-green-600" />
          </div>
          <p className="text-xl font-bold text-gray-900">{results.updated} products updated</p>
          {results.skipped > 0 && (
            <p className="text-sm text-gray-500 mt-1">{results.skipped} skipped (no changes)</p>
          )}
          {results.notFound > 0 && (
            <p className="text-sm text-amber-600 mt-1">{results.notFound} not found in system</p>
          )}
          <Button onClick={reset} className="mt-6">
            Import Another File
          </Button>
        </div>
      )}
    </div>
  );
}

/** Parse a CSV line respecting quoted fields */
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
