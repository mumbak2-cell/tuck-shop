"use client";

import { useState, useRef, useEffect } from "react";
import { ChevronDown, Search } from "lucide-react";

export interface SearchableSelectOption {
  value: string;
  label: string;
  detail?: string;
}

interface SearchableSelectProps {
  options: SearchableSelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  emptyMessage?: string;
}

export function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = "Select...",
  disabled = false,
  emptyMessage = "No matches",
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedOption = options.find((o) => o.value === value);

  const filtered = query
    ? options.filter((o) => {
        const q = query.toLowerCase();
        return o.label.toLowerCase().includes(q) || (o.detail?.toLowerCase().includes(q) ?? false);
      })
    : options;

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

  function handleSelect(val: string) {
    onChange(val);
    setOpen(false);
    setQuery("");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
    }
  }

  if (disabled) {
    return (
      <div className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-gray-50 text-gray-400 flex items-center justify-between">
        <span className="truncate">{selectedOption?.label || placeholder}</span>
        <ChevronDown className="w-4 h-4 text-gray-300 flex-shrink-0 ml-2" />
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative w-full">
      {open ? (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type to search..."
            className="w-full border border-green-500 ring-1 ring-green-500 rounded-lg pl-9 pr-3 py-2 text-sm outline-none"
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-left flex items-center justify-between focus:border-green-500 focus:ring-1 focus:ring-green-500"
        >
          <span className={`truncate ${selectedOption ? "text-gray-900" : "text-gray-400"}`}>
            {selectedOption?.label || placeholder}
          </span>
          <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0 ml-2" />
        </button>
      )}

      {open && (
        <ul className="absolute z-50 w-full bg-white border border-gray-200 rounded-lg shadow-lg mt-1 max-h-60 overflow-y-auto">
          {filtered.length === 0 ? (
            <li className="px-3 py-3 text-sm text-gray-500 text-center">{emptyMessage}</li>
          ) : (
            filtered.map((o) => (
              <li
                key={o.value}
                onClick={() => handleSelect(o.value)}
                className={`px-3 py-2 cursor-pointer hover:bg-gray-50 ${o.value === value ? "bg-green-50" : ""}`}
              >
                <div className="text-sm text-gray-900">{o.label}</div>
                {o.detail && <div className="text-xs text-gray-500">{o.detail}</div>}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
