"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log to console so errors are still visible in dev tools / monitoring.
    console.error("[Tilify error boundary]", error);
  }, [error]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center bg-white rounded-2xl shadow-sm border border-red-100 p-8">
        <AlertTriangle className="w-10 h-10 text-red-500 mx-auto mb-4" />
        <h2 className="text-lg font-semibold text-gray-900">Something went wrong</h2>
        <p className="text-sm text-gray-500 mt-2">
          This page ran into an unexpected error. Your data is safe — try refreshing.
        </p>
        {process.env.NODE_ENV === "development" && (
          <pre className="mt-4 text-xs text-left text-red-600 bg-red-50 rounded-lg p-3 overflow-x-auto max-h-40">
            {error.message}
          </pre>
        )}
        <button
          onClick={reset}
          className="mt-6 inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-lg transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          Try again
        </button>
      </div>
    </div>
  );
}
