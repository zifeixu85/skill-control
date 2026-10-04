"use client";

import { useCallback, useState } from "react";

/** Width of an element, tracked with ResizeObserver (ref callback + cleanup). */
export function useElementWidth<T extends HTMLElement>(fallback: number): [(element: T | null) => (() => void) | undefined, number] {
  const [width, setWidth] = useState(fallback);
  const ref = useCallback((element: T | null) => {
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width || 0);
      if (next > 0) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}
