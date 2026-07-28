"use client";
import { useState, useEffect } from "react";
import { db } from "@/lib/supabase";

export function usePeriodLock() {
  const [lockedThrough, setLockedThrough] = useState<string | null>(null);

  useEffect(() => {
    db.from("period_locks")
      .select("locked_through")
      .maybeSingle()
      .then(({ data }: { data: { locked_through: string } | null }) => {
        if (data) setLockedThrough(data.locked_through);
      });
  }, []);

  function isLocked(date: string): boolean {
    return lockedThrough != null && date <= lockedThrough;
  }

  return { lockedThrough, isLocked };
}
