"use client";
import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { Tooltip } from "./tooltip";

/**
 * Overflow menu for actions that are used rarely (export, import, secondary
 * settings) and shouldn't hold permanent screen space next to the primary CTA.
 *
 * Closes on outside click and on Escape, and returns focus to the trigger so
 * keyboard users don't get stranded.
 */
export function ActionMenu({
  label = "More actions",
  align = "right",
  children,
}: {
  label?: string;
  align?: "left" | "right";
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={wrapRef}>
      <Tooltip label={label}>
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={label}
          className="inline-flex items-center justify-center rounded-lg border border-gray-300 bg-gray-100 px-3 py-2 text-gray-700 transition-colors hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-gray-400 focus:ring-offset-2"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </Tooltip>
      {open && (
        <div
          role="menu"
          className={`absolute z-40 mt-1 min-w-[11rem] rounded-lg border border-gray-200 bg-white py-1 shadow-lg ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  onClick,
  icon: Icon,
  children,
}: {
  onClick: () => void;
  icon?: React.ElementType;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none"
    >
      {Icon && <Icon className="h-4 w-4 text-gray-400" />}
      {children}
    </button>
  );
}
