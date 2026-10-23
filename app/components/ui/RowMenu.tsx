"use client";

import { useEffect, useId, useRef, useState } from "react";
import { noop, useEscape } from "../../hooks/useEscape";

export interface RowMenuItem {
  label: string;
  onSelect: () => void;
  title?: string;
}

/** A quiet ⋯ button with a small menu. Esc, a click outside or choosing an item closes it. */
export function RowMenu({ label, items }: { label: string; items: RowMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEscape(open, open ? () => {
    setOpen(false);
    button.current?.focus();
  } : noop);
  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    // Focus the first item so the keyboard can use it right away.
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);
  return (
    <span className={`row-menu ${open ? "open" : ""}`} ref={root} data-popover="">
      <button
        type="button"
        ref={button}
        className="row-menu-btn"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open ? (
        <span className="row-menu-list" role="menu" id={id} aria-label={label}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              title={item.title}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}
