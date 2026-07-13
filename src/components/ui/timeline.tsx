"use client";

/**
 * Vertical timeline for time-sequenced data (activity logs, event streams).
 *
 * Events are grouped under a sticky day heading and joined by a rail, so the
 * reader gets the sequence and the gaps for free — a sorted table makes you
 * reconstruct both from timestamps.
 */
export function Timeline({ children }: { children: React.ReactNode }) {
  return <div className="space-y-6">{children}</div>;
}

export function TimelineGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="sticky top-0 z-10 -mx-1 bg-gray-50/95 px-1 py-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 backdrop-blur">
        {label}
      </h2>
      <ol className="mt-2 space-y-px">{children}</ol>
    </section>
  );
}

export function TimelineItem({
  marker,
  children,
  last = false,
}: {
  /** Small node rendered on the rail — an icon or an avatar. */
  marker: React.ReactNode;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <li className="relative flex gap-3 rounded-lg px-2 py-3 transition-colors hover:bg-white">
      {/* Rail: drawn behind the marker, stopping at the last item so the line
          doesn't dangle past the final event. */}
      {!last && <span aria-hidden className="absolute left-[1.4rem] top-11 bottom-0 w-px bg-gray-200" />}
      <span className="relative z-[1] shrink-0">{marker}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

/** Initials avatar — communicates "who did this" faster than re-reading a name. */
export function Avatar({ name, className = "" }: { name: string | null; className?: string }) {
  const initials = (name || "?")
    .split(" ")
    .map((n) => n[0])
    .filter(Boolean)
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <span
      className={`inline-flex h-8 w-8 items-center justify-center rounded-full bg-gray-200 text-xs font-semibold text-gray-600 ${className}`}
    >
      {initials || "?"}
    </span>
  );
}
