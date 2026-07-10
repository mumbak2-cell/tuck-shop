"use client";
// Minimal layout for platform-admin pages at /admin/*.
// Standalone (no shop sidebar) — admin tools are MK Global staff territory.
//
// Guards the session before rendering. Without this, a signed-out visitor
// reached the page and the child's fetch failed with a bare "Not signed in",
// with no way to sign in from there. Note the Supabase session lives in
// localStorage, which is per-origin: a session on one hostname is invisible
// on another.
//
// Platform-admin *authorisation* is enforced server-side by requireAdmin()
// on every /api/admin/* route. This is only an authentication check, so a
// signed-in non-admin still reaches the page and sees the API's 403.

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { supabase } from "@/lib/supabase";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      if (!data.session) {
        router.replace(`/login?next=${encodeURIComponent(pathname)}`);
        return;
      }
      setChecked(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [router, pathname]);

  if (!checked) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-gray-400">
        Checking your session...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-4 py-3 border-b border-gray-200 bg-white flex items-center gap-4 text-sm">
        <Link href="/admin/customers" className="font-semibold text-gray-900">Tilify Admin</Link>
        <span className="text-gray-300">|</span>
        <Link href="/admin/customers" className="text-gray-600 hover:text-gray-900">Customers</Link>
        <Link href="/admin/partners" className="text-gray-600 hover:text-gray-900">Partners</Link>
        <div className="flex-1" />
        <Link href="/dashboard" className="text-gray-500 hover:text-gray-900">Back to shop →</Link>
      </div>
      <div className="max-w-6xl mx-auto px-4 py-6">{children}</div>
    </div>
  );
}
