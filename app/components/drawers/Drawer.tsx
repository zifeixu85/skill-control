"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useEscape } from "../../hooks/useEscape";
import { CloseIcon } from "../icons";

/**
 * Side panel over the page. It is not modal: the list behind it keeps its scroll and
 * stays usable. A new target remounts the panel (fresh scroll); tab changes do not.
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
  useEscape(true, onClose);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div className={`drawer ${wide ? "wide" : ""}`} role="dialog" aria-label={label} ref={ref} tabIndex={-1}>
      <div className="insp">
        <div className="insp-head">
          {icon}
          <div className="insp-title">
            <h2>{title}</h2>
            {subtitle ? <div className="tech">{subtitle}</div> : null}
          </div>
          <button type="button" className="btn ghost sm x" onClick={onClose} aria-label="关闭">
            <CloseIcon />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
