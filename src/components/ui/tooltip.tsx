"use client";
import { useId, useState } from "react";

type Side = "top" | "bottom" | "left" | "right";

const sideStyles: Record<Side, string> = {
  top: "bottom-full left-1/2 -translate-x-1/2 mb-1.5",
  bottom: "top-full left-1/2 -translate-x-1/2 mt-1.5",
  left: "right-full top-1/2 -translate-y-1/2 mr-1.5",
  right: "left-full top-1/2 -translate-y-1/2 ml-1.5",
};

/**
 * Hover/focus tooltip for icon-only buttons and truncated cells.
 *
 * Shown on focus as well as hover so keyboard users get the same label, and
 * wired via aria-describedby rather than `title` — a native title attribute
 * never appears on touch and cannot be read alongside an aria-label.
 */
export function Tooltip({
  label,
  side = "top",
  children,
}: {
  label: string;
  side?: Side;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <span aria-describedby={open ? id : undefined} className="inline-flex">
        {children}
      </span>
      {open && (
        <span
          role="tooltip"
          id={id}
          className={`absolute z-50 whitespace-nowrap rounded-md bg-gray-900 px-2 py-1 text-xs font-medium text-white shadow-sm pointer-events-none ${sideStyles[side]}`}
        >
          {label}
        </span>
      )}
    </span>
  );
}
