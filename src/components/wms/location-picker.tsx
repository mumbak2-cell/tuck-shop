"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, MapPin, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export interface WmsLocationOption {
  id: string; // wms_locations.id (UUID)
  code: string; // e.g. "MAIN", "A-01-03"
  label: string;
  kind: "rack" | "bin" | "zone" | "staging";
  active: boolean;
}

export interface LocationPickerProps {
  value: string | null; // selected wms_locations.id
  onChange: (id: string) => void;
  locations: WmsLocationOption[]; // caller supplies; component is pure
  placeholder?: string; // default "Select bin…"
  disabled?: boolean;
  excludeIds?: string[]; // hide these ids (e.g. source when picking destination)
  showInactive?: boolean; // default false — active only
  size?: "sm" | "md"; // default "md" (44px touch)
}

const kindBadgeColor: Record<WmsLocationOption["kind"], "gray" | "blue" | "amber" | "green"> = {
  staging: "gray",
  rack: "blue",
  bin: "amber",
  zone: "green",
};

export function LocationPicker({
  value,
  onChange,
  locations,
  placeholder = "Select bin…",
  disabled = false,
  excludeIds,
  showInactive = false,
  size = "md",
}: LocationPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = locations.find((l) => l.id === value);

  const visible = useMemo(() => {
    let list = locations;
    if (!showInactive) list = list.filter((l) => l.active);
    if (excludeIds && excludeIds.length > 0) {
      const excluded = new Set(excludeIds);
      list = list.filter((l) => !excluded.has(l.id));
    }
    return list;
  }, [locations, showInactive, excludeIds]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return visible;
    return visible.filter(
      (l) => l.code.toLowerCase().includes(q) || l.label.toLowerCase().includes(q)
    );
  }, [visible, query]);

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [open]);

  function handleSelect(id: string) {
    onChange(id);
    setOpen(false);
    setQuery("");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
    }
  }

  const triggerHeight = size === "sm" ? "min-h-[36px]" : "min-h-[44px]";
  const rowHeight = size === "sm" ? "min-h-[36px]" : "min-h-[44px]";

  if (disabled) {
    return (
      <div
        className={`w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-gray-50 text-gray-400 flex items-center justify-between ${triggerHeight}`}
      >
        <span className="truncate">
          {selected ? `${selected.code} — ${selected.label}` : placeholder}
        </span>
        <ChevronDown className="w-4 h-4 text-gray-300 flex-shrink-0 ml-2" />
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative w-full">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-left flex items-center justify-between focus:border-green-500 focus:ring-1 focus:ring-green-500 ${triggerHeight}`}
      >
        <span className={`truncate ${selected ? "text-gray-900" : "text-gray-400"}`}>
          {selected ? `${selected.code} — ${selected.label}` : placeholder}
        </span>
        <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0 ml-2" />
      </button>

      {open && (
        <div className="absolute z-50 w-full bg-white border border-gray-200 rounded-lg shadow-lg mt-1">
          <div className="relative p-2 border-b border-gray-100">
            <Search className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search code or label..."
              className="w-full border border-gray-300 rounded-lg pl-9 pr-3 py-2 text-sm outline-none focus:border-green-500 focus:ring-1 focus:ring-green-500"
            />
          </div>
          <ul className="max-h-60 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <li className="flex flex-col items-center justify-center py-6 text-center text-gray-400">
                <MapPin className="w-6 h-6 mb-1" />
                <span className="text-sm">
                  {visible.length === 0 ? "No bins available" : "No bins match"}
                </span>
              </li>
            ) : (
              filtered.map((l) => (
                <li key={l.id}>
                  <button
                    type="button"
                    onClick={() => handleSelect(l.id)}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-green-500 ${rowHeight} ${
                      l.id === value ? "bg-green-50" : ""
                    }`}
                  >
                    <span className="font-mono text-xs bg-gray-100 text-gray-700 rounded px-1.5 py-0.5 flex-shrink-0">
                      {l.code}
                    </span>
                    <span className="text-sm text-gray-900 truncate flex-1">{l.label}</span>
                    <Badge variant={kindBadgeColor[l.kind]}>{l.kind}</Badge>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
