"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { BusyContext, useBusyOwner } from "../../hooks/useBusy";
import { noop, useEscape } from "../../hooks/useEscape";
import { CloseIcon } from "../icons";

/**
 * Side panel over the page. It is not modal: the list behind it keeps its scroll and
 * stays usable. A new target remounts the panel (fresh scroll); tab changes do not.
 * Content marks it busy (useMarkBusy) during a write; then 关闭 and Esc wait.
 */
export function Drawer({
  label,
  icon,
  title,
  subtitle,
  onClose,
  children,
  wide,
}: {
  label: string;
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { store, busy } = useBusyOwner();
  useEscape(true, busy ? noop : onClose);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div className={`drawer ${wide ? "wide" : ""}`} role="dialog" aria-label={label} aria-busy={busy} ref={ref} tabIndex={-1}>
      <div className="insp">
        <div className="insp-head">
          {icon}
          <div className="insp-title">
            <h2>{title}</h2>
            {subtitle ? <div className="tech">{subtitle}</div> : null}
          </div>
          <button
            type="button"
            className="btn ghost sm x"
            onClick={onClose}
            disabled={busy}
            aria-label={busy ? "正在执行，完成后才能关闭" : "关闭"}
            title={busy ? "正在执行，完成后才能关闭" : undefined}
          >
            <CloseIcon />
          </button>
        </div>
        <BusyContext.Provider value={store}>{children}</BusyContext.Provider>
      </div>
    </div>
  );
}
