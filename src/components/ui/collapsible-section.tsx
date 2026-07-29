"use client";
import { useState, type ReactNode } from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";

/**
 * A settings card whose body folds away behind its heading. The Settings page
 * had grown past a dozen cards, which made finding any one of them a scroll.
 *
 * The body is unmounted while collapsed. That is safe for every current caller
 * because each one keeps its form state in the component that renders this
 * wrapper, not inside the body — collapsing a half-edited section does not
 * discard the edit.
 */
export function CollapsibleSection({
  title,
  icon: Icon,
  badge,
  defaultOpen = false,
  children,
}: {
  title: string;
  icon: LucideIcon;
  /** Optional note beside the title, e.g. "(per branch)". */
  badge?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="bg-white border border-gray-200 rounded-xl">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-6 py-4 text-left rounded-xl hover:bg-gray-50 transition-colors"
      >
        <Icon className="w-5 h-5 text-gray-600 flex-shrink-0" />
        <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
        {badge}
        <ChevronDown
          className={`w-5 h-5 text-gray-400 ml-auto flex-shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && <div className="px-6 pb-6">{children}</div>}
    </div>
  );
}
