"use client";
import { useEffect, useRef, useState } from "react";

/**
 * A single-line cell that ellipsises overflowing text and reveals the full
 * value in a tooltip on hover/focus.
 *
 * The tooltip is only wired up when the text is actually clipped — measured
 * against scrollWidth — so short values don't sprout a pointless tooltip.
 * Needs a bounded parent (a table cell with `max-w-*`) to clip against.
 */
export function TruncatedText({
  children,
  className = "",
}: {
  children: string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setClipped(el.scrollWidth > el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [children]);

  return (
    <span className="relative block min-w-0">
      <span
        ref={ref}
        tabIndex={clipped ? 0 : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className={`block truncate ${className}`}
      >
        {children}
      </span>
      {clipped && open && (
        <span
          role="tooltip"
          className="absolute bottom-full left-0 z-50 mb-1.5 max-w-xs whitespace-normal break-words rounded-md bg-gray-900 px-2 py-1 text-xs font-medium text-white shadow-sm"
        >
          {children}
        </span>
      )}
    </span>
  );
}
