import Link from "next/link";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-green-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {children}
        <nav className="mt-6 flex justify-center gap-4 text-xs text-gray-500">
          <Link href="/pricing" className="hover:text-gray-700 hover:underline">Pricing</Link>
          <Link href="/terms" className="hover:text-gray-700 hover:underline">Terms</Link>
          <Link href="/refund-policy" className="hover:text-gray-700 hover:underline">Refunds</Link>
        </nav>
      </div>
    </div>
  );
}
