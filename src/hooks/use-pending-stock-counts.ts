"use client";
import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { db } from "@/lib/supabase";
import { useOrg } from "@/lib/org-context";
import { toLocalDateStr } from "@/lib/date-utils";

// Count of distinct unconfirmed stock-count sessions across every location the
// current user can see. Only owners are shown the badge, since only owners can
// approve a count. RLS on stock_counts already scopes reads to the caller's
// locations, so the query needs no explicit location filter. Bounded to the
// last 30 days to match the Stock Count page's session picker window — a badge
// pointing at a session the page won't show is a dead-end.
export function usePendingStockCounts() {
  const { role, orgId } = useOrg();
  const pathname = usePathname();
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    if (role !== "owner" || !orgId) {
      setCount(0);
      return;
    }
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 30);
    const cutoff = toLocalDateStr(cutoffDate);
    const { data, error } = await db
      .from("stock_counts")
      .select("session_id")
      .eq("org_id", orgId)
      .is("confirmed_at", null)
      .gte("count_date", cutoff);
    if (error || !data) {
      setCount(0);
      return;
    }
    const distinct = new Set((data as { session_id: string }[]).map((r) => r.session_id));
    setCount(distinct.size);
  }, [role, orgId]);

  useEffect(() => {
    refresh();
  }, [refresh, pathname]);

  return { count, refresh };
}
