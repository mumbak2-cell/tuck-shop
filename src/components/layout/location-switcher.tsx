"use client";
import { useState, useRef, useEffect } from "react";
import { Store, ChevronDown, Check } from "lucide-react";
import { useOrg } from "@/lib/org-context";

export function LocationSwitcher() {
  const {
    locations,
    currentLocationId,
    currentLocationName,
    canSwitchLocation,
    switchLocation,
  } = useOrg();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  // Hide entirely if there are no locations to pick from yet.
  if (locations.length === 0 || !currentLocationName) return null;

  // For cashiers (or any org with only one location), show a static pill
  // instead of a clickable dropdown — there is nothing to switch to.
  if (!canSwitchLocation || locations.length === 1) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm">
        <Store className="w-4 h-4 text-gray-500 flex-shrink-0" />
        <span className="text-gray-700 font-medium truncate">{currentLocationName}</span>
      </div>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm hover:border-gray-300 transition-colors"
      >
        <span className="flex items-center gap-2 truncate">
          <Store className="w-4 h-4 text-gray-500 flex-shrink-0" />
          <span className="text-gray-700 font-medium truncate">{currentLocationName}</span>
        </span>
        <ChevronDown
          className={`w-4 h-4 text-gray-500 flex-shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="absolute z-50 left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-64 overflow-y-auto">
          {locations.map((loc) => {
            const isCurrent = loc.id === currentLocationId;
            return (
              <button
                key={loc.id}
                onClick={() => {
                  switchLocation(loc.id);
                  setOpen(false);
                }}
                className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-left transition-colors ${
                  isCurrent ? "bg-green-50 text-green-900" : "text-gray-700 hover:bg-gray-50"
                }`}
              >
                <span className="truncate">{loc.name}</span>
                {isCurrent && <Check className="w-4 h-4 text-green-600 flex-shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
