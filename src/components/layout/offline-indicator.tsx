"use client";
// Small status pill that shows the user whether they are online and how many
// operations are queued waiting to sync. Renders nothing when fully synced and
// online — it only appears when there is something the cashier should know.

import { Wifi, WifiOff, Loader2 } from "lucide-react";
import { useOnline } from "@/lib/use-online";
import { usePendingCount } from "@/lib/use-offline-sync";

export function OfflineIndicator({ orgId }: { orgId: string | null }) {
  const online = useOnline();
  const pending = usePendingCount(orgId);

  if (online && pending === 0) return null;

  if (!online) {
    return (
      <div className="mx-4 mb-3 inline-flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs">
        <WifiOff className="w-4 h-4 text-amber-600 flex-shrink-0" />
        <div className="min-w-0">
          <p className="font-semibold text-amber-900">Offline</p>
          {pending > 0 && (
            <p className="text-amber-700">
              {pending} pending sync — will replay when back online
            </p>
          )}
          {pending === 0 && (
            <p className="text-amber-700">
              Sales work — they will sync when back online
            </p>
          )}
        </div>
      </div>
    );
  }

  // Online with queued ops still in flight — show syncing state
  return (
    <div className="mx-4 mb-3 inline-flex items-center gap-2 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-xs">
      <Loader2 className="w-4 h-4 text-blue-600 animate-spin flex-shrink-0" />
      <div className="min-w-0">
        <p className="font-semibold text-blue-900">
          Syncing {pending} {pending === 1 ? "operation" : "operations"}
        </p>
        <p className="text-blue-700">Hold on — almost there.</p>
      </div>
    </div>
  );
}

/** A compact dot you can put next to the user name in the sidebar footer. */
export function OfflineDot({ orgId }: { orgId: string | null }) {
  const online = useOnline();
  const pending = usePendingCount(orgId);

  let color = "bg-green-500";
  let title = "Online — all synced";
  if (!online) {
    color = "bg-amber-500";
    title = pending > 0 ? `Offline — ${pending} pending` : "Offline";
  } else if (pending > 0) {
    color = "bg-blue-500";
    title = `Syncing ${pending}`;
  }

  return (
    <span title={title} className="inline-flex items-center gap-1">
      <span className={`inline-block w-2 h-2 rounded-full ${color}`} />
      {pending > 0 && (
        <span className="text-xs font-medium text-gray-600">{pending}</span>
      )}
      {online && pending === 0 && (
        <Wifi className="w-3 h-3 text-green-500" />
      )}
    </span>
  );
}
