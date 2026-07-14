/**
 * Shared status → colour mapping for WMS dispatches.
 *
 * The Warehouse Dashboard and the Dispatch page each had their own copy and
 * they disagreed: "Dispatched" was green on one screen and blue on the other,
 * so the same status meant different things depending on where you looked.
 *
 * The scale is a lifecycle, not decoration: Pending needs someone to act,
 * Dispatched is in flight, Received is done.
 */
export type DispatchStatusColor = "amber" | "blue" | "green" | "gray";

export function dispatchStatusColor(status: string): DispatchStatusColor {
  if (status === "Received") return "green";
  if (status === "Dispatched") return "blue";
  if (status === "Pending") return "amber";
  return "gray";
}

/**
 * ABC value class → colour, shared for the same reason as the status map above.
 * The three screens that show this label each had their own mapping and the
 * Warehouse Dashboard rendered Class B yellow while the stock table rendered it
 * amber — one scale, drawn two ways.
 *
 * A = highest-value stock, C = lowest.
 */
export type AbcClassColor = "red" | "amber" | "blue" | "gray";

export function abcClassColor(abcClass: string): AbcClassColor {
  if (abcClass === "A") return "red";
  if (abcClass === "B") return "amber";
  if (abcClass === "C") return "blue";
  return "gray";
}

/** A bare "A" / "B" / "C" means nothing until someone says what it ranks. */
export const ABC_LABELS: Record<string, string> = {
  A: "Class A — highest-value stock, count most often",
  B: "Class B — mid-value stock",
  C: "Class C — low-value stock, count least often",
};
