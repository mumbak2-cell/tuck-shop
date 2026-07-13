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
