import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import "./globals.css";
import { AuthProvider } from "@/lib/auth-context";
import { ShiftProvider } from "@/lib/shift-context";
import { CurrencyProvider } from "@/lib/currency-context";
import { OrgProvider } from "@/lib/org-context";
import { SwRegister } from "@/components/sw-register";
import { ToastProvider } from "@/components/ui/toast";

export const metadata: Metadata = {
  title: "Tilify",
  description: "Tilify — Inventory, POS and Revenue Assurance for small retail",
  manifest: "/manifest.json",
  icons: {
    apple: "/icon-192.png",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Tilify",
  },
};

export const viewport: Viewport = {
  themeColor: "#16a34a",
  width: "device-width",
  initialScale: 1,
  // No maximumScale: pinch-zoom stays available. Locking it meant an operator
  // on a tablet could not zoom out to reach a control that ran off-screen, and
  // could not zoom in on a small figure.
  //
  // Android/Chrome shrinks the layout viewport when the on-screen keyboard
  // opens, so dvh-based heights account for it. iOS Safari ignores this — the
  // Modal handles that case via the VisualViewport API.
  interactiveWidget: "resizes-content",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Forces every route to render dynamically instead of being statically
  // prerendered at build time. Required by proxy.ts's per-request CSP
  // nonce: a statically-generated page's script tags are fixed at build
  // time, when no nonce exists yet, so they'd never match the fresh nonce
  // the proxy sets on the real response and every script on that page
  // would be blocked (this is what a 'strict-dynamic' script-src needs —
  // see proxy.ts's header comment). connection() reads nothing; it exists
  // purely to opt out of static generation.
  await connection();

  return (
    <html lang="en">
      <body className="antialiased bg-gray-50 text-gray-900" suppressHydrationWarning>
        <ToastProvider>
          <SwRegister />
        </ToastProvider>
        <OrgProvider><CurrencyProvider><AuthProvider><ShiftProvider>{children}</ShiftProvider></AuthProvider></CurrencyProvider></OrgProvider>
      </body>
    </html>
  );
}
