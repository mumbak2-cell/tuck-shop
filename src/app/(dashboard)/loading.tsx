export default function DashboardLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      {/* Page title skeleton */}
      <div className="h-8 w-48 bg-gray-200 rounded" />

      {/* Stat cards skeleton */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-white rounded-xl border border-gray-100 p-4">
            <div className="h-3 w-20 bg-gray-200 rounded mb-3" />
            <div className="h-6 w-24 bg-gray-200 rounded" />
          </div>
        ))}
      </div>

      {/* Content skeleton */}
      <div className="bg-white rounded-xl border border-gray-100 p-6">
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-4 bg-gray-200 rounded" style={{ width: `${85 - i * 10}%` }} />
          ))}
        </div>
      </div>
    </div>
  );
}
