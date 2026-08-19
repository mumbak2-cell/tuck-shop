"use client";
import { ReactNode, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}

export function Modal({ open, onClose, title, children, wide }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Size the dialog to the *visible* viewport rather than the layout viewport.
  // On iOS Safari the on-screen keyboard shrinks the visual viewport but leaves
  // vh units untouched, so a vh-sized dialog kept its full-screen height and
  // pushed the field being typed into behind the keyboard — the cash-tendered
  // box on the POS, most of all. Undefined until measured, and on browsers with
  // no VisualViewport support, which falls back to the CSS height below.
  const [visual, setVisual] = useState<{ height?: number; top?: number }>({});

  useEffect(() => {
    if (!open) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const sync = () => setVisual({ height: vv.height, top: vv.offsetTop });
    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
    };
  }, [open]);

  // The dialog now sits fully above the keyboard, but a long form can still
  // hide the focused field further down its own scroll area. Bring it into view.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target || typeof target.scrollIntoView !== "function") return;
      // Wait for the keyboard animation to settle, or we measure the old box.
      setTimeout(() => target.scrollIntoView({ block: "center", behavior: "smooth" }), 300);
    };
    panel.addEventListener("focusin", onFocusIn);
    return () => panel.removeEventListener("focusin", onFocusIn);
  }, [open]);

  useEffect(() => {
    if (open) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  // L4: close on Escape key
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-x-0 top-0 z-50 h-dvh flex items-center justify-center p-4"
      style={{ height: visual.height, top: visual.top }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      <div className="fixed inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className={`relative bg-white rounded-xl shadow-xl w-full ${wide ? "max-w-2xl" : "max-w-md"} max-h-full overflow-y-auto`}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 id="modal-title" className="text-lg font-semibold text-gray-900">{title}</h2>
          <button onClick={onClose} aria-label="Close dialog" className="p-1 rounded-lg hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>
        <div className="px-6 py-4">{children}</div>
      </div>
    </div>
  );
}
