"use client";

import { useId, type ReactNode } from "react";
import { noop, useEscape } from "../../hooks/useEscape";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { CloseIcon } from "../icons";
import { Scrim } from "./Scrim";

/** A plain modal dialog: focus stays inside, Esc and a backdrop click close it. */
export function Modal({
  title,
  onClose,
  children,
  wide,
  busy,
  footer,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  /** While true (e.g. a command is running) Esc, the backdrop and × don't close it. */
  busy?: boolean;
  footer?: ReactNode;
}) {
  const id = useId();
  const ref = useFocusTrap<HTMLDivElement>();
  const close = busy ? noop : onClose;
  useEscape(true, close);
  return (
    <Scrim onDismiss={close}>
      <div className={`sheet modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={id} ref={ref} tabIndex={-1}>
        <div className="modal-head">
          <h2 id={id}>{title}</h2>
          <button type="button" className="btn ghost sm" onClick={close} disabled={busy} aria-label="关闭">
            <CloseIcon />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </Scrim>
  );
}
