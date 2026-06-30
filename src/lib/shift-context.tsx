"use client";
import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react";
import { db } from "@/lib/supabase";
import { useOrg } from "@/lib/org-context";
import { insertOrQueue } from "@/lib/offline-ops";
import { enqueueOp } from "@/lib/offline-store";

interface Shift {
  id: string;
  shift_date: string;
  opened_at: string;
  opened_by: string;
  opening_float: number;
  closed_at: string | null;
  closed_by: string | null;
  closing_cash: number | null;
  stock_count_done: boolean;
  status: string;
  location_id: string | null;
}

interface ShiftState {
  shift: Shift | null;
  loading: boolean;
  isOpen: boolean;
  openShift: (openedBy: string, openingFloat: number) => Promise<boolean>;
  closeShift: (closedBy: string, closingCash: number) => Promise<boolean>;
  markStockCountDone: () => Promise<void>;
  refresh: () => Promise<void>;
}

const ShiftContext = createContext<ShiftState>({
  shift: null,
  loading: true,
  isOpen: false,
  openShift: async () => false,
  closeShift: async () => false,
  markStockCountDone: async () => {},
  refresh: async () => {},
});

export function useShift() {
  return useContext(ShiftContext);
}

export function ShiftProvider({ children }: { children: ReactNode }) {
  const { currentLocationId, orgId } = useOrg();
  const [shift, setShift] = useState<Shift | null>(null);
  const [loading, setLoading] = useState(true);

  const today = new Date().toISOString().split("T")[0];

  // Shifts are per-location. Each shop opens and closes its own shift independently.
  const fetchShift = useCallback(async () => {
    // When offline, skip the network call entirely. In-memory shift state
    // (set by openShift / closeShift while the user has been live) persists
    // through navigation. If the page is hard-reloaded offline, shift state
    // is lost until reconnect — acceptable v1.
    if (!navigator.onLine) {
      setLoading(false);
      return;
    }
    setLoading(true);
    let query = db
      .from("shifts")
      .select("*")
      .eq("shift_date", today)
      .order("opened_at", { ascending: false })
      .limit(1);

    if (currentLocationId) {
      query = query.eq("location_id", currentLocationId);
    }

    const { data } = await query;

    if (data && data.length > 0) {
      setShift(data[0] as Shift);
    } else {
      setShift(null);
    }
    setLoading(false);
  }, [today, currentLocationId]);

  useEffect(() => {
    fetchShift();
  }, [fetchShift]);

  async function openShift(openedBy: string, openingFloat: number): Promise<boolean> {
    if (!currentLocationId) {
      alert("Cannot open a shift without a location selected.");
      return false;
    }
    if (!orgId) {
      alert("Shop not loaded yet.");
      return false;
    }

    // Generate a client-side ID so the open path can be queued idempotently.
    const newShift: Shift = {
      id: crypto.randomUUID(),
      shift_date: today,
      opened_at: new Date().toISOString(),
      opened_by: openedBy,
      opening_float: openingFloat,
      closed_at: null,
      closed_by: null,
      closing_cash: null,
      stock_count_done: false,
      status: "open",
      location_id: currentLocationId,
    };

    const result = await insertOrQueue({
      org_id: orgId,
      table: "shifts",
      queueKind: "open_shift",
      row: newShift as unknown as { id: string } & Record<string, unknown>,
    });

    if (!result.ok) {
      alert("Error opening shift: " + (result.error || "unknown"));
      return false;
    }

    setShift(newShift);
    return true;
  }

  async function closeShift(closedBy: string, closingCash: number): Promise<boolean> {
    if (!shift || !orgId) return false;

    // Optimistically update local state; the row to upsert (or queue) is the
    // full shift record with closing fields filled in.
    const closedShift: Shift = {
      ...shift,
      closed_at: new Date().toISOString(),
      closed_by: closedBy,
      closing_cash: closingCash,
      status: "closed",
    };
    setShift(closedShift);

    if (navigator.onLine) {
      const { error } = await db
        .from("shifts")
        .update({
          closed_at: closedShift.closed_at,
          closed_by: closedShift.closed_by,
          closing_cash: closedShift.closing_cash,
          status: closedShift.status,
        })
        .eq("id", shift.id);
      if (error) {
        alert("Error closing shift: " + error.message);
        return false;
      }
      await fetchShift();
      return true;
    }

    // Offline — queue the full row for upsert-on-id replay.
    enqueueOp(orgId, {
      id: `close-${shift.id}`,
      kind: "close_shift",
      payload: { table: "shifts", row: closedShift as unknown as Record<string, unknown> },
    });
    return true;
  }

  async function markStockCountDone() {
    if (!shift || !orgId) return;
    const updated: Shift = { ...shift, stock_count_done: true };
    setShift(updated);

    if (navigator.onLine) {
      await db
        .from("shifts")
        .update({ stock_count_done: true })
        .eq("id", shift.id);
      await fetchShift();
      return;
    }
    // Offline — queue the full row.
    enqueueOp(orgId, {
      id: `stockcount-${shift.id}`,
      kind: "close_shift",
      payload: { table: "shifts", row: updated as unknown as Record<string, unknown> },
    });
  }

  return (
    <ShiftContext.Provider
      value={{
        shift,
        loading,
        isOpen: shift?.status === "open",
        openShift,
        closeShift,
        markStockCountDone,
        refresh: fetchShift,
      }}
    >
      {children}
    </ShiftContext.Provider>
  );
}
