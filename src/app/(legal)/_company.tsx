// Shared company details + footer/header for the public legal & pricing pages.
// These pages are intentionally OUTSIDE the (dashboard) route group so they are
// publicly reachable without authentication (needed for Paystack review).
import Link from "next/link";

export const COMPANY = {
  legalName: "MK Global SA (Pty) Ltd",
  regNo: "2025/522597/07",
  phone: "+27 83 680 2141",
  // Role-based addresses: general/billing enquiries vs refunds & returns.
  infoEmail: "info@mkglobal.co.za",
  supportEmail: "support@mkglobal.co.za",
  website: "https://www.mkglobal.co.za",
  address: "Unit 1 Shangri-La, Pierneef Road, Birchleigh, 1618, South Africa",
  product: "Tilify",
  effectiveDate: "30 July 2026",
};

export function PageShell({
  title,
  contactEmail,
  children,
}: {
  title: string;
  contactEmail: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-dvh bg-white text-gray-900">
      <header className="border-b border-gray-200">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Link href="/pricing" className="text-lg font-bold text-green-700">
            Tilify
          </Link>
          <nav className="flex gap-4 text-sm text-gray-600">
            <Link href="/pricing" className="hover:text-gray-900">Pricing</Link>
            <Link href="/terms" className="hover:text-gray-900">Terms</Link>
            <Link href="/refund-policy" className="hover:text-gray-900">Refunds</Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-3xl font-bold text-gray-900">{title}</h1>
        <p className="mt-1 text-sm text-gray-500">Effective {COMPANY.effectiveDate}</p>
        <div className="prose prose-gray mt-8 max-w-none prose-headings:font-semibold prose-h2:mt-8 prose-h2:text-xl prose-a:text-green-700">
          {children}
        </div>
      </main>

      <footer className="border-t border-gray-200 bg-gray-50">
        <div className="mx-auto max-w-3xl px-6 py-8 text-sm text-gray-600">
          <p className="font-semibold text-gray-900">{COMPANY.legalName}</p>
          <p>Registration no. {COMPANY.regNo}</p>
          <p>{COMPANY.address}</p>
          <p>
            <a href={`mailto:${contactEmail}`} className="text-green-700">{contactEmail}</a>
            {" · "}
            {COMPANY.phone}
            {" · "}
            <a href={COMPANY.website} className="text-green-700">www.mkglobal.co.za</a>
          </p>
          <p className="mt-3 text-xs text-gray-400">
            © {new Date().getFullYear()} {COMPANY.legalName}. Tilify is a product of {COMPANY.legalName}.
          </p>
        </div>
      </footer>
    </div>
  );
}
