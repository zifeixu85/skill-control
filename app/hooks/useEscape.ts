"use client";

import { useEffect, useEffectEvent } from "react";
import { createEscapeStack, noop } from "../lib/escape-stack";

const stack = createEscapeStack();
let installed = false;

function onKeyDown(event: KeyboardEvent) {
  if (event.key !== "Escape" || event.defaultPrevented || !stack.size()) return;
  event.preventDefault();
  stack.escape();
}

/**
 * Registers a layer for Esc while `active`. To block Esc during a write, keep the layer
 * active and pass a no-op: `useEscape(true, busy ? noop : onClose)`.
 */
export function useEscape(active: boolean, close: () => void) {
  const onClose = useEffectEvent(close);
  useEffect(() => {
    if (!active) return undefined;
    if (!installed) {
      window.addEventListener("keydown", onKeyDown);
      installed = true;
    }
    return stack.push(() => onClose());
  }, [active]);
}

/** Swallows Esc while `busy`, so a write in progress is not dismissed from underneath. */
export function useBlockEscape(busy: boolean) {
  useEscape(busy, noop);
}

export { noop };
