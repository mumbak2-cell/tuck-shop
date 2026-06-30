"use client";
// Shared dropdown for filtering reporting pages by location.
//
// Returns the selected location_id or "all" for chain-wide view.
// Owners and admins see every location plus "All locations" (default).
// Cashiers (role="member") are pinned to their assigned location and the
// dropdown is disabled.
//
// Usage:
//   const [locFilter, setLocFilter] = useState<string>("all");
//   <LocationFilter value={locFilter} onChange={setLocFilter} />
//   // Then in queries:
//   let q = db.from("sales").select("...");
//   if (locFilter !== "all") q = q.eq("location_id", locFilter);

import { MapPin } from "lucide-react";
import { useOrg } from "@/lib/org-context";

export const LOCATION_FILTER_ALL = "all";

export function LocationFilter({
  value,
  onChange,
  className = "",
}: {
  value: string;
  onChange: (next: string) => void;
  className?: string;
}) {
  const { locations, role, assignedLocationId, currentLocationId } = useOrg();

  // Single-location org: hide the picker entirely.
  if (locations.length <= 1) return null;

  // Cashiers are pinned to their assigned location.
  const isCashier = role === "member";
  const cashierLocId = assignedLocationId || currentLocationId;
  const cashierLocName = locations.find((l) => l.id === cashierLocId)?.name || "Your location";

  if (isCashier) {
    return (
      <div className={`inline-flex items-center gap-2 text-sm text-gray-600 ${className}`}>
        <MapPin className="w-4 h-4 text-gray-400" />
        <span>{cashierLocName}</span>
      </div>
    );
  }

  return (
    <div className={`inline-flex items-center gap-2 ${className}`}>
      <MapPin className="w-4 h-4 text-gray-400" />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:border-green-500 focus:ring-1 focus:ring-green-500"
      >
        <option value={LOCATION_FILTER_ALL}>All locations</option>
        {locations.map((l) => (
          <option key={l.id} value={l.id}>{l.name}</option>
        ))}
      </select>
    </div>
  );
}

/**
 * Helper for cashiers: collapse "all" to their assigned location so queries
 * still filter correctly even when a parent component sets value="all".
 */
export function effectiveLocationFilter(
  value: string,
  role: string | null,
  assignedLocationId: string | null,
  currentLocationId: string | null
): string {
  if (role === "member") {
    return assignedLocationId || currentLocationId || value;
  }
  return value;
}
