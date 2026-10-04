"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { PanelShell } from "../ui/PanelShell";

/**
 * Side panel over the page. It is not modal and doesn't dim the page: the list behind it
 * keeps its scroll and stays usable, and pressing outside closes it. A new target
 * remounts the panel (fresh scroll); tab changes do not. See PanelShell for the header,
 * busy and dismiss rules.
 */
export function Drawer({
  label,
  icon,
  title,
  subtitle,
  tabs,
  actions,
  footer,
  onClose,
  children,
  wide,
}: {
  label: string;
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  tabs?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div className={`drawer ${wide ? "wide" : ""}`} role="dialog" aria-label={label} ref={ref} tabIndex={-1}>
      <PanelShell icon={icon} title={title} subtitle={subtitle} tabs={tabs} actions={actions} footer={footer} onClose={onClose}>
        {children}
      </PanelShell>
    </div>
  );
}
