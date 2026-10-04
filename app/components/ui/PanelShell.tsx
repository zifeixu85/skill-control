"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { BusyContext, useBusyOwner } from "../../hooks/useBusy";
import { noop, useEscape } from "../../hooks/useEscape";
import { useLightDismiss } from "../../hooks/useLightDismiss";
import { CloseIcon } from "../icons";

/**
 * One shell for every right-side detail panel (skill inspector and all drawers).
 *
 * The panel is its own scroll area. Its header (icon, title, subtitle, actions, ×, tabs)
 * sticks to the top and gets a hairline once the body has scrolled; an optional footer
 * sticks to the bottom. A press outside closes it (light dismiss), Esc too; both wait while
 * content marks the panel busy (useMarkBusy). A new `resetKey` scrolls the body back up.
 */
export function PanelShell({
  title,
  titleId,
  subtitle,
  icon,
  tabs,
  actions,
  footer,
  onClose,
  closeLabel = "关闭",
  resetKey,
  children,
}: {
  title: ReactNode;
  titleId?: string;
  subtitle?: ReactNode;
  icon?: ReactNode;
  tabs?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  closeLabel?: string;
  resetKey?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const { store, busy } = useBusyOwner();
  const close = busy ? noop : onClose;
  useEscape(true, close);
  useLightDismiss(ref, onClose, busy);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = 0;
  }, [resetKey]);

  const busyLabel = "正在执行，完成后才能关闭";
  return (
    <div
      className="panel insp"
      ref={ref}
      aria-busy={busy}
      data-panel=""
      onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 2)}
    >
      <header className={`panel-head ${scrolled ? "scrolled" : ""} ${tabs ? "with-tabs" : ""}`}>
        <div className="panel-head-row">
          {icon ? <div className="panel-icon">{icon}</div> : null}
          <div className="panel-title">
            <h2 id={titleId}>{title}</h2>
            {subtitle ? <div className="panel-sub">{subtitle}</div> : null}
          </div>
          {actions ? <div className="panel-actions">{actions}</div> : null}
          <button
            type="button"
            className="btn ghost sm panel-x"
            onClick={onClose}
            disabled={busy}
            aria-label={busy ? busyLabel : closeLabel}
            title={busy ? busyLabel : `${closeLabel}（Esc）`}
          >
            <CloseIcon />
          </button>
        </div>
        {tabs ? <div className="panel-tabs">{tabs}</div> : null}
      </header>
      <BusyContext.Provider value={store}>
        <div className="panel-body">{children}</div>
        {footer ? <footer className="panel-foot">{footer}</footer> : null}
      </BusyContext.Provider>
    </div>
  );
}
