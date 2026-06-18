import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AuthProvider } from "@/lib/auth-context";
import { ShiftProvider } from "@/lib/shift-context";
import { CurrencyProvider } from "@/lib/currency-context";

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
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased bg-gray-50 text-gray-900">
        <CurrencyProvider><AuthProvider><ShiftProvider>{children}</ShiftProvider></AuthProvider></CurrencyProvider>
      </body>
    </html>
  );
}
