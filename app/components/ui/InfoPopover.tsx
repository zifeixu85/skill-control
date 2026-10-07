"use client";

import { useId, useState, type ReactNode } from "react";
import { noop, useEscape } from "../../hooks/useEscape";
import { InfoIcon } from "../icons";

/**
 * A small ⓘ next to a title. Hover or keyboard focus shows the content; a click pins it open
 * (touch, or to read longer), Esc or a second click closes it.
 */
export function InfoPopover({ label, children, align = "start" }: { label: string; children: ReactNode; align?: "start" | "end" }) {
  const id = useId();
  const [pinned, setPinned] = useState(false);
  useEscape(pinned, pinned ? () => setPinned(false) : noop);
  return (
    <span className={`info-pop ${pinned ? "pinned" : ""} ${align}`} data-popover="">
      <button
        type="button"
        className="info-pop-btn"
        aria-label={label}
        aria-describedby={id}
        aria-expanded={pinned}
        onClick={() => setPinned((value) => !value)}
        onBlur={(event) => {
          if (!event.currentTarget.parentElement?.contains(event.relatedTarget as Node | null)) setPinned(false);
        }}
      >
        <InfoIcon />
      </button>
      <span className="info-pop-body" role="tooltip" id={id}>
        {children}
      </span>
    </span>
  );
}
