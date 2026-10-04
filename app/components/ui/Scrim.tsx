"use client";

import { useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Backdrop of a modal sheet, rendered into <body> so it always covers the window (a sheet
 * opened from inside an animated panel would otherwise be confined to that panel). A click
 * on the backdrop itself closes the sheet unless it is busy; a press that starts inside the
 * sheet (e.g. selecting text) and ends outside doesn't.
 */
export function Scrim({ onDismiss, busy = false, children }: { onDismiss?: () => void; busy?: boolean; children: ReactNode }) {
  const pressedBackdrop = useRef(false);
  const scrim = (
    <div
      className="scrim"
      onPointerDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget && event.button === 0;
      }}
      onClick={(event) => {
        const fromBackdrop = pressedBackdrop.current && event.target === event.currentTarget;
        pressedBackdrop.current = false;
        if (fromBackdrop && !busy) onDismiss?.();
      }}
    >
      {children}
    </div>
  );
  return typeof document === "undefined" ? scrim : createPortal(scrim, document.body);
}
