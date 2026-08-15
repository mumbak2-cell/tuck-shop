"use client";
import { createContext, ReactElement, useCallback, useContext, useEffect, useRef, useState } from "react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";

export type ToastKind = "success" | "error" | "info";

export interface ToastApi {
  success: (message: string, opts?: { hint?: string; durationMs?: number }) => void;
  error: (message: string, opts?: { hint?: string; durationMs?: number }) => void;
  info: (message: string, opts?: { hint?: string; durationMs?: number }) => void;
}

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  hint?: string;
  durationMs: number;
}

const DEFAULT_DURATIONS: Record<ToastKind, number> = {
  success: 3000,
  error: 6000,
  info: 4000,
};

const KIND_STYLES: Record<ToastKind, { rail: string; icon: ReactElement }> = {
  success: { rail: "border-l-green-500", icon: <CheckCircle2 className="w-5 h-5 text-green-500" /> },
  error: { rail: "border-l-red-500", icon: <AlertCircle className="w-5 h-5 text-red-500" /> },
  info: { rail: "border-l-blue-500", icon: <Info className="w-5 h-5 text-blue-500" /> },
};

const ToastContext = createContext<ToastApi | null>(null);

const MAX_TOASTS = 5;
let nextId = 1;

function ToastItemView({
  toast,
  onDismiss,
}: {
  toast: ToastItem;
  onDismiss: (id: number) => void;
}) {
  const [entered, setEntered] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remainingRef = useRef(toast.durationMs);
  const startedAtRef = useRef<number>(Date.now());

  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const startTimer = useCallback(() => {
    startedAtRef.current = Date.now();
    timerRef.current = setTimeout(() => onDismiss(toast.id), remainingRef.current);
  }, [onDismiss, toast.id]);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAtRef.current));
    }
  }, []);

  useEffect(() => {
    startTimer();
    return clearTimer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      onMouseEnter={clearTimer}
      onMouseLeave={startTimer}
      className={`transition-all duration-200 motion-reduce:transition-none motion-reduce:transform-none ${
        entered ? "opacity-100 translate-x-0" : "opacity-0 translate-x-4"
      } min-w-[280px] max-w-[420px] w-full sm:w-auto bg-white rounded-lg shadow-lg border border-gray-200 border-l-4 ${KIND_STYLES[toast.kind].rail} px-4 py-3 flex gap-3 items-start`}
      role="status"
    >
      <div className="flex-shrink-0 mt-0.5">{KIND_STYLES[toast.kind].icon}</div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900">{toast.message}</p>
        {toast.hint && <p className="text-xs text-gray-500 mt-0.5">{toast.hint}</p>}
      </div>
      <button
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss"
        className="flex-shrink-0 p-1 rounded hover:bg-gray-100"
      >
        <X className="w-4 h-4 text-gray-400" />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string, opts?: { hint?: string; durationMs?: number }) => {
      const item: ToastItem = {
        id: nextId++,
        kind,
        message,
        hint: opts?.hint,
        durationMs: opts?.durationMs ?? DEFAULT_DURATIONS[kind],
      };
      setToasts((prev) => {
        const next = [...prev, item];
        return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
      });
    },
    []
  );

  const api: ToastApi = {
    success: (message, opts) => push("success", message, opts),
    error: (message, opts) => push("error", message, opts),
    info: (message, opts) => push("info", message, opts),
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 items-end px-4 sm:px-0">
        {toasts.map((toast) => (
          <ToastItemView key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used inside <ToastProvider>");
  }
  return ctx;
}
