import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AuthProvider } from "@/lib/auth-context";
import { ShiftProvider } from "@/lib/shift-context";
import { CurrencyProvider } from "@/lib/currency-context";
import { OrgProvider } from "@/lib/org-context";

export const metadata: Metadata = {
  title: "Tilify",
  description: "Tilify — Inventory, POS and Revenue Assurance for small retail",
  manifest: "/manifest.json",
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased bg-gray-50 text-gray-900" suppressHydrationWarning>
        <OrgProvider><CurrencyProvider><AuthProvider><ShiftProvider>{children}</ShiftProvider></AuthProvider></CurrencyProvider></OrgProvider>
      </body>
    </html>
  );
}
