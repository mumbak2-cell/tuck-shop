"use client";
import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { Modal } from "@/components/ui/modal";
import { ExternalLink } from "lucide-react";

interface ReceiptViewerProps {
  /** Storage path of the receipt to show; null keeps the dialog closed. */
  path: string | null;
  onClose: () => void;
}

export function ReceiptViewer({ path, onClose }: ReceiptViewerProps) {
  // Both results carry the path they belong to, so switching receipts shows
  // "Loading…" until the new signed URL lands rather than briefly showing the
  // previous one — and no state has to be cleared synchronously in the effect.
  const [loaded, setLoaded] = useState<{ path: string; url: string } | null>(null);
  const [failed, setFailed] = useState<{ path: string; message: string } | null>(null);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;

    // The bucket is private, so the object has no public URL — mint a
    // short-lived signed one each time the dialog opens.
    supabase.storage
      .from("receipts")
      .createSignedUrl(path, 300)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error || !data) {
          setFailed({ path, message: error?.message || "Could not load this receipt." });
        } else {
          setLoaded({ path, url: data.signedUrl });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [path]);

  const url = loaded && loaded.path === path ? loaded.url : null;
  const message = failed && failed.path === path ? failed.message : null;
  const isPdf = !!path && path.toLowerCase().endsWith(".pdf");

  return (
    <Modal open={!!path} onClose={onClose} title="Receipt" wide>
      {message ? (
        <p className="text-sm text-red-600 py-8 text-center">{message}</p>
      ) : !url ? (
        <p className="text-sm text-gray-400 py-8 text-center">Loading…</p>
      ) : (
        <div className="space-y-3">
          {isPdf ? (
            <iframe src={url} title="Receipt" className="w-full h-[60vh] rounded-lg border border-gray-200" />
          ) : (
            // A signed URL on a per-project Supabase host, shown only inside this
            // dialog — next/image would need remotePatterns config and buys
            // nothing for a one-off preview that is never an LCP candidate.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={url} alt="Receipt" className="w-full max-h-[60vh] object-contain rounded-lg border border-gray-200" />
          )}
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-green-700 hover:text-green-800"
          >
            <ExternalLink className="w-4 h-4" /> Open in new tab
          </a>
        </div>
      )}
    </Modal>
  );
}
