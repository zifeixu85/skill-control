"use client";

import { useId, type ReactNode } from "react";
import { useEscape } from "../../hooks/useEscape";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { CloseIcon } from "../icons";
import { Scrim } from "./Scrim";

/** A plain modal dialog: focus stays inside, Esc and a backdrop click close it. */
export function Modal({ title, onClose, children, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const id = useId();
  const ref = useFocusTrap<HTMLDivElement>();
  useEscape(true, onClose);
  return (
    <Scrim onDismiss={onClose}>
      <div className={`sheet modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={id} ref={ref} tabIndex={-1}>
        <div className="modal-head">
          <h2 id={id}>{title}</h2>
          <button type="button" className="btn ghost sm" onClick={onClose} aria-label="关闭">
            <CloseIcon />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </Scrim>
  );
}
