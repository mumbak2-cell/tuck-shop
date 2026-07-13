"use client";
import { useState } from "react";

export interface SparkPoint {
  /** ISO date (yyyy-mm-dd) — used as the tooltip label and the x ordering. */
  date: string;
  value: number;
}

/**
 * Inline SVG bar rollup for a table's time dimension — lets an operator see
 * the shape of a period (a spike, a dead week) without reading timestamps
 * row by row.
 *
 * Deliberately unlabelled on the x-axis: it summarises, the table below is
 * the source of truth. Hovering a bar reveals its date and value.
 */
export function Sparkline({
  points,
  format = (v) => String(v),
  height = 40,
  className = "",
  /** Tailwind bg-* class for the bars. Neutral by default — pass a semantic
   *  colour only when the series itself carries meaning (e.g. money owed). */
  barClass = "bg-gray-300",
  emphasisClass,
}: {
  points: SparkPoint[];
  format?: (value: number) => string;
  height?: number;
  className?: string;
  barClass?: string;
  /** Applied to the tallest bar, to mark the peak. */
  emphasisClass?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length === 0) return null;

  const max = Math.max(...points.map((p) => p.value), 0);
  const peak = points.reduce((best, p, i) => (p.value > points[best].value ? i : best), 0);

  return (
    <div className={`relative ${className}`}>
      <div className="flex items-end gap-px" style={{ height }}>
        {points.map((p, i) => {
          const pct = max > 0 ? (p.value / max) * 100 : 0;
          const isPeak = emphasisClass && i === peak && p.value > 0;
          return (
            <div
              key={p.date}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              className="group flex flex-1 items-end self-stretch"
            >
              <div
                className={`w-full rounded-sm transition-opacity ${
                  isPeak ? emphasisClass : barClass
                } ${hover !== null && hover !== i ? "opacity-40" : ""}`}
                // A zero-value day still gets a 2px stub so gaps in the series
                // read as "nothing happened" rather than "no data".
                style={{ height: `${Math.max(pct, 2)}%` }}
              />
            </div>
          );
        })}
      </div>
      {hover !== null && (
        <div className="pointer-events-none absolute -top-1 left-0 right-0 text-center">
          <span className="inline-block rounded-md bg-gray-900 px-2 py-1 text-xs font-medium text-white shadow-sm">
            {new Date(points[hover].date).toLocaleDateString("en-ZA", { day: "numeric", month: "short" })}
            {" · "}
            {format(points[hover].value)}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Buckets dated rows into one point per calendar day across [from, to], so
 * days with no activity still render (as gaps) instead of being collapsed.
 */
export function bucketByDay<T>(
  rows: T[],
  getDate: (row: T) => string,
  getValue: (row: T) => number,
  from: string,
  to: string
): SparkPoint[] {
  const totals = new Map<string, number>();
  const start = new Date(from);
  const end = new Date(to);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    totals.set(d.toISOString().split("T")[0], 0);
  }
  rows.forEach((r) => {
    const key = getDate(r).split("T")[0];
    if (totals.has(key)) totals.set(key, (totals.get(key) || 0) + getValue(r));
  });
  return [...totals.entries()].map(([date, value]) => ({ date, value }));
}
