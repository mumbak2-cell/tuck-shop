"use client";
// React hooks on top of the offline store. Pages call these to render
// pending-count badges, decide whether to read from cache, and so on.

import { useEffect, useState, useCallback } from "react";
import { pendingCount, readQueue, type QueuedOp } from "@/lib/offline-store";

/**
 * Subscribes to queue changes for the given org. Returns the current pending
 * count and updates live as ops are enqueued / drained.
 */
export function usePendingCount(orgId: string | null): number {
  const [count, setCount] = useState<number>(0);

  useEffect(() => {
    if (!orgId) {
      setCount(0);
      return;
    }
    setCount(pendingCount(orgId));

    function onChange(e: Event) {
      const detail = (e as CustomEvent).detail as { orgId: string; count: number };
      if (detail.orgId === orgId) setCount(detail.count);
    }
    function onStorage(e: StorageEvent) {
      if (e.key && e.key.startsWith(`tilify_queue_${orgId}`)) {
        setCount(pendingCount(orgId));
      }
    }

    window.addEventListener("tilify:queue-changed", onChange as EventListener);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("tilify:queue-changed", onChange as EventListener);
      window.removeEventListener("storage", onStorage);
    };
  }, [orgId]);

  return count;
}

/**
 * Returns the full current queue. Use sparingly — most pages just need the
 * count for a badge.
 */
export function useQueue(orgId: string | null): QueuedOp[] {
  const [ops, setOps] = useState<QueuedOp[]>([]);

  const refresh = useCallback(() => {
    if (!orgId) {
      setOps([]);
      return;
    }
    setOps(readQueue(orgId));
  }, [orgId]);

  useEffect(() => {
    refresh();

    function onChange(e: Event) {
      const detail = (e as CustomEvent).detail as { orgId: string };
      if (detail.orgId === orgId) refresh();
    }
    function onStorage(e: StorageEvent) {
      if (e.key && e.key.includes(`tilify_queue_${orgId}`)) refresh();
    }

    window.addEventListener("tilify:queue-changed", onChange as EventListener);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("tilify:queue-changed", onChange as EventListener);
      window.removeEventListener("storage", onStorage);
    };
  }, [orgId, refresh]);

  return ops;
}
