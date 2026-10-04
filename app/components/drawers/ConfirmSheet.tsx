"use client";

import type { ReactNode } from "react";
import { noop, useEscape } from "../../hooks/useEscape";
import { useFocusTrap } from "../../hooks/useFocusTrap";

/** Small modal for a planned write: what will happen, then an explicit confirm. */
export function ConfirmSheet({
  title,
  children,
  error,
  notice,
  busy,
  confirmLabel,
  canConfirm,
  onConfirm,
  onClose,
  onRetry,
  footnote,
}: {
  title: string;
  children: ReactNode;
  error?: string;
  /** Informational, e.g. why the plan was regenerated. */
  notice?: string;
  busy: boolean;
  confirmLabel: string;
  canConfirm: boolean;
  onConfirm: () => void;
  onClose: () => void;
  /** Shown as 重新生成 when the plan failed or expired. */
  onRetry?: () => void;
  footnote?: string;
}) {
  const ref = useFocusTrap<HTMLDivElement>();
  // Stays registered while busy so Esc can't close this or anything underneath mid-write.
  useEscape(true, busy ? noop : onClose);
  return (
    <div className="scrim">
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="confirm-title" aria-busy={busy} ref={ref} tabIndex={-1}>
        <h2 id="confirm-title">{title}</h2>
        {notice ? (
          <p className="inline-note" role="status">
            {notice}
          </p>
        ) : null}
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
            {onRetry ? (
              <button type="button" className="btn" onClick={onRetry} disabled={busy}>
                重新生成
              </button>
            ) : null}
            <button type="button" className="btn primary" onClick={onConfirm} disabled={busy || !canConfirm}>
              {busy ? "正在执行…" : confirmLabel}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
