"use client";
// Lightweight online-status hook used by UI surfaces that need to distinguish
// "we are offline" from "Supabase returned nothing" so the operator gets
// honest messaging rather than a misleading "no data configured" empty state.
//
// SSR-safe: defaults to true on the server so the first paint never renders
// the offline path before the browser has had a chance to report its state.

import { useEffect, useState } from "react";

export function useOnline(): boolean {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === "undefined" ? true : navigator.onLine
  );

  useEffect(() => {
    function up() { setOnline(true); }
    function down() { setOnline(false); }
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    // In case navigator.onLine changed between render and effect run.
    setOnline(navigator.onLine);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  return online;
}
