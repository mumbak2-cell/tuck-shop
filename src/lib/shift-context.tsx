"use client";
import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react";
import { db } from "@/lib/supabase";
import { useOrg } from "@/lib/org-context";

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
  const { currentLocationId } = useOrg();
  const [shift, setShift] = useState<Shift | null>(null);
  const [loading, setLoading] = useState(true);

  const today = new Date().toISOString().split("T")[0];

  // Shifts are per-location. Each shop opens and closes its own shift independently.
  const fetchShift = useCallback(async () => {
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

    const { data, error } = await db
      .from("shifts")
      .insert({
        shift_date: today,
        opened_by: openedBy,
        opening_float: openingFloat,
        status: "open",
        location_id: currentLocationId,
      })
      .select()
      .single();

    if (error) {
      alert("Error opening shift: " + error.message);
      return false;
    }

    setShift(data as Shift);
    return true;
  }

  async function closeShift(closedBy: string, closingCash: number): Promise<boolean> {
    if (!shift) return false;

    const { error } = await db
      .from("shifts")
      .update({
        closed_at: new Date().toISOString(),
        closed_by: closedBy,
        closing_cash: closingCash,
        status: "closed",
      })
      .eq("id", shift.id);

    if (error) {
      alert("Error closing shift: " + error.message);
      return false;
    }

    await fetchShift();
    return true;
  }

  async function markStockCountDone() {
    if (!shift) return;
    await db
      .from("shifts")
      .update({ stock_count_done: true })
      .eq("id", shift.id);
    await fetchShift();
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
