"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Package } from "lucide-react";
import { Modal } from "@/components/ui/modal";

export interface WmsCatalogPickerItem {
  id: number;
  sku: string;
  item_name: string;
  category: string | null;
  barcode?: string | null;
  reorder_level?: number | null;
  physical_qty?: number | null; // caller-supplied, optional
}

export interface ItemPickerModalProps {
  open: boolean;
  onClose: () => void;
  onPick: (item: WmsCatalogPickerItem) => void;
  items: WmsCatalogPickerItem[];
  title?: string;
  filter?: (item: WmsCatalogPickerItem) => boolean;
  excludeIds?: number[];
  emptyLabel?: string;
}

export function ItemPickerModal({
  open,
  onClose,
  onPick,
  items,
  title,
  filter,
  excludeIds,
  emptyLabel,
}: ItemPickerModalProps) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlight(0);
      // Focus after the modal mounts.
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const results = useMemo(() => {
    let list = items;
    if (filter) list = list.filter(filter);
    if (excludeIds && excludeIds.length > 0) {
      const excluded = new Set(excludeIds);
      list = list.filter((item) => !excluded.has(item.id));
    }
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter((item) => {
        return (
          item.item_name.toLowerCase().includes(q) ||
          item.sku.toLowerCase().includes(q) ||
          (item.barcode?.toLowerCase().includes(q) ?? false)
        );
      });
    }
    return list;
  }, [items, filter, excludeIds, query]);

  useEffect(() => {
    setHighlight(0);
  }, [query]);

  function handlePick(item: WmsCatalogPickerItem) {
    onPick(item);
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = results[highlight] ?? results[0];
      if (item) handlePick(item);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={title ?? "Select item"} wide>
      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search by name, SKU, or barcode..."
          className="block w-full rounded-lg border border-gray-300 pl-9 pr-3 py-2 text-sm shadow-sm placeholder:text-gray-400 focus:border-green-500 focus:ring-1 focus:ring-green-500"
        />
      </div>

      {results.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 text-center text-gray-400">
          <Package className="w-8 h-8 mb-2" />
          <p className="text-sm">{emptyLabel ?? "No items match"}</p>
        </div>
      ) : (
        <ul className="max-h-96 overflow-y-auto -mx-2">
          {results.map((item, i) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => handlePick(item)}
                onMouseEnter={() => setHighlight(i)}
                className={`w-full flex items-center justify-between gap-3 min-h-[44px] px-2 py-2 rounded-lg text-left focus:outline-none focus:ring-2 focus:ring-green-500 ${
                  i === highlight ? "bg-green-50" : "hover:bg-gray-50"
                }`}
              >
                <div className="min-w-0">
                  <div className="font-medium text-gray-900 truncate">{item.item_name}</div>
                  <div className="text-xs text-gray-500 truncate">
                    {item.sku}
                    {item.category ? ` · ${item.category}` : ""}
                    {item.barcode ? ` · ${item.barcode}` : ""}
                  </div>
                </div>
                {item.physical_qty != null && (
                  <span className="flex-shrink-0 text-xs text-gray-500">
                    In stock: {item.physical_qty}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
