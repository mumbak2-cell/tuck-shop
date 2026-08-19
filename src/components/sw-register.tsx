"use client";

import { useEffect } from "react";
import { useToast } from "@/components/ui/toast";

export function SwRegister() {
  const toast = useToast();

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    navigator.serviceWorker.register("/sw.js").then((reg) => {
      reg.addEventListener("updatefound", () => {
        const newSw = reg.installing;
        if (!newSw) return;
        newSw.addEventListener("statechange", () => {
          // A controller already existing means this is an update, not the
          // first-ever install — only then is there a stale page to warn about.
          if (newSw.state === "installed" && navigator.serviceWorker.controller) {
            toast.info("App updated — refresh to apply", { durationMs: 15000 });
          }
        });
      });
    });
  }, [toast]);

  return null;
}
