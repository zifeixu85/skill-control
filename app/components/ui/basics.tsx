"use client";

import { useId, type KeyboardEvent, type ReactNode } from "react";
import { WarnIcon } from "../icons";

export function TopBar({
  title,
  sub,
  leading,
  children,
}: {
  title: ReactNode;
  sub?: ReactNode;
  leading?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="top">
      {leading}
      <div className="top-title">
        <h1>{title}</h1>
        {sub ? <div className="sub">{sub}</div> : null}
      </div>
      <div className="grow" />
      {children ? <div className="top-actions">{children}</div> : null}
    </header>
  );
}

export function SectionHeading({ title, note, id, action }: { title: ReactNode; note?: ReactNode; id?: string; action?: ReactNode }) {
  return (
    <div className="section-h">
      <h2 id={id}>{title}</h2>
      {note ? <span>{note}</span> : null}
      {action ? <div className="section-act">{action}</div> : null}
    </div>
  );
}

export function KvTable({ rows, label }: { rows: { label: string; value: ReactNode }[]; label?: string }) {
  const visible = rows.filter((row) => row.value !== null && row.value !== undefined && row.value !== "");
  if (!visible.length) return null;
  return (
    <dl className="kv" aria-label={label}>
      {visible.map((row, index) => (
        <div className="kv-row" key={`${row.label}-${index}`}>
          <dt className="k">{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface TabItem<T extends string> {
  id: T;
  label: string;
}

/** Roving tablist: arrow keys move between tabs, Enter/Space or click selects. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  idBase,
}: {
  tabs: TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  idBase?: string;
}) {
  const generated = useId();
  const base = idBase || generated;
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const next = tabs[(index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    onChange(next.id);
    document.getElementById(`${base}-tab-${next.id}`)?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          id={`${base}-tab-${tab.id}`}
          type="button"
          role="tab"
          aria-selected={tab.id === value}
          tabIndex={tab.id === value ? 0 : -1}
          className={tab.id === value ? "on" : ""}
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: { id: T; label: ReactNode; count?: number }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="radio"
          aria-checked={item.id === value}
          className={item.id === value ? "on" : ""}
          onClick={() => onChange(item.id)}
        >
          {item.label}
          {item.count !== undefined ? <em>{item.count}</em> : null}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  tone = "plain",
  action,
}: {
  title: ReactNode;
  children?: ReactNode;
  tone?: "plain" | "error" | "pending";
  action?: ReactNode;
}) {
  return (
    <div className={`empty ${tone}`} role={tone === "error" ? "alert" : undefined}>
      {tone === "error" ? <WarnIcon className="empty-icon" /> : null}
      <b>{title}</b>
      {children ? <p>{children}</p> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function Loading({ label = "正在读取…", rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <i key={index} style={{ width: `${92 - index * 14}%` }} />
      ))}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`switch ${checked ? "on" : ""}`}
      onClick={onChange}
    />
  );
}

export function Tag({ children, tone = "ok", title }: { children: ReactNode; tone?: "ok" | "warn" | "mute" | "info" | "danger"; title?: string }) {
  return (
    <span className={`tag ${tone === "ok" ? "" : tone}`} title={title}>
      {children}
    </span>
  );
}
