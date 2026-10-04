"use client";

import type { ReactNode } from "react";
import { useEscape } from "../../hooks/useEscape";
import { useFocusTrap } from "../../hooks/useFocusTrap";

/** Small modal for a planned write: what will happen, then an explicit confirm. */
export function ConfirmSheet({
  title,
  children,
  error,
  busy,
  confirmLabel,
  canConfirm,
  onConfirm,
  onClose,
  footnote,
}: {
  title: string;
  children: ReactNode;
  error?: string;
  busy: boolean;
  confirmLabel: string;
  canConfirm: boolean;
  onConfirm: () => void;
  onClose: () => void;
  footnote?: string;
}) {
  const ref = useFocusTrap<HTMLDivElement>();
  useEscape(!busy, onClose);
  return (
    <div className="scrim">
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="confirm-title" ref={ref} tabIndex={-1}>
        <h2 id="confirm-title">{title}</h2>
        {children}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="acts">
          <small>{footnote || "执行前会先备份，所有改动都记在历史里"}</small>
          <span className="acts-right">
            <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button type="button" className="btn primary" onClick={onConfirm} disabled={busy || !canConfirm}>
              {busy ? "正在执行…" : confirmLabel}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
