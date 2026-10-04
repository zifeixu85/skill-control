"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export interface ToastAction {
  label: string;
  run: () => void | Promise<void>;
}

interface ToastItem {
  id: number;
  message: string;
  action: ToastAction | null;
  tone: "default" | "error";
}

interface ToastApi {
  show: (message: string, options?: { action?: ToastAction; tone?: "default" | "error" }) => void;
  dismiss: () => void;
}

const ToastContext = createContext<ToastApi | null>(null);
const VISIBLE_MS = 5200;
/** Toasts with an action (撤销) stay long enough to reach; hovering or focusing pauses them. */
const ACTION_VISIBLE_MS = 12_000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastItem | null>(null);
  const [paused, setPaused] = useState(false);
  const counter = useRef(0);

  const show = useCallback<ToastApi["show"]>((message, options = {}) => {
    counter.current += 1;
    setPaused(false);
    setToast({ id: counter.current, message, action: options.action || null, tone: options.tone || "default" });
  }, []);
  const dismiss = useCallback(() => {
    setToast(null);
    setPaused(false);
  }, []);

  useEffect(() => {
    if (!toast || paused) return undefined;
    const timer = window.setTimeout(
      () => setToast((current) => (current?.id === toast.id ? null : current)),
      toast.action ? ACTION_VISIBLE_MS : VISIBLE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [toast, paused]);

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {toast ? (
          <div
            className={`toast ${toast.tone === "error" ? "error" : ""}`}
            key={toast.id}
            onMouseEnter={() => setPaused(true)}
            onMouseLeave={() => setPaused(false)}
            onFocus={() => setPaused(true)}
            onBlur={() => setPaused(false)}
          >
            <span>{toast.message}</span>
            {toast.action ? (
              <button
                type="button"
                onClick={() => {
                  const action = toast.action;
                  setToast(null);
                  setPaused(false);
                  if (!action) return;
                  Promise.resolve()
                    .then(() => action.run())
                    .catch((error: unknown) =>
                      show(error instanceof Error && error.message ? error.message : "操作失败。", { tone: "error" }),
                    );
                }}
              >
                {toast.action.label}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToast must be used inside ToastProvider");
  return value;
}
