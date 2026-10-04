"use client";

import { useEffect, useEffectEvent } from "react";

/**
 * Esc closes the top-most open layer only (sheet → dialog → drawer → pending install →
 * inspector). Layers register while active; the latest registration wins.
 */
const stack: { id: number; close: () => void }[] = [];
let sequence = 0;
let installed = false;

function onKeyDown(event: KeyboardEvent) {
  if (event.key !== "Escape" || event.defaultPrevented || !stack.length) return;
  event.preventDefault();
  stack[stack.length - 1].close();
}

export function useEscape(active: boolean, close: () => void) {
  const onClose = useEffectEvent(close);
  useEffect(() => {
    if (!active) return undefined;
    if (!installed) {
      window.addEventListener("keydown", onKeyDown);
      installed = true;
    }
    sequence += 1;
    const entry = { id: sequence, close: () => onClose() };
    stack.push(entry);
    return () => {
      const index = stack.findIndex((item) => item.id === entry.id);
      if (index >= 0) stack.splice(index, 1);
    };
  }, [active]);
}
