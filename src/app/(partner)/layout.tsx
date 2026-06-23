// Minimal shell for the Partner area — no sidebar, no shop context.
// The partner UI is intentionally standalone because partners may have
// no shop of their own (they're agents who refer others).

export default function PartnerLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 py-6">{children}</div>
    </div>
  );
}
