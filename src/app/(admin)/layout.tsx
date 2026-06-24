// Minimal layout for platform-admin pages at /admin/*.
// Standalone (no shop sidebar) — admin tools are MK Global staff territory.

import Link from "next/link";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-4 py-3 border-b border-gray-200 bg-white flex items-center gap-4 text-sm">
        <Link href="/admin/partners" className="font-semibold text-gray-900">Tilify Admin</Link>
        <span className="text-gray-300">|</span>
        <Link href="/admin/partners" className="text-gray-600 hover:text-gray-900">Partners</Link>
        <div className="flex-1" />
        <Link href="/dashboard" className="text-gray-500 hover:text-gray-900">Back to shop →</Link>
      </div>
      <div className="max-w-6xl mx-auto px-4 py-6">{children}</div>
    </div>
  );
}
