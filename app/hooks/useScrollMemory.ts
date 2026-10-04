"use client";

import { useCallback } from "react";

const positions = new Map<string, number>();
const elements = new Map<string, HTMLElement>();

/**
 * Ref callback for a scroll container that remembers its position under `key`.
 * Selecting rows or opening panels never remounts the container, so it keeps its place;
 * coming back to a page restores where the list was.
 */
export function useScrollMemory<T extends HTMLElement>(key: string) {
  return useCallback(
    (element: T | null) => {
      if (!element) return undefined;
      elements.set(key, element);
      const saved = positions.get(key);
      if (saved) element.scrollTop = saved;
      const remember = () => positions.set(key, element.scrollTop);
      element.addEventListener("scroll", remember, { passive: true });
      return () => {
        element.removeEventListener("scroll", remember);
        if (elements.get(key) === element) elements.delete(key);
      };
    },
    [key],
  );
}

/** Back to the top, e.g. after the list's filter or search changed. */
export function resetScrollMemory(key: string): void {
  positions.set(key, 0);
  const element = elements.get(key);
  if (element) element.scrollTop = 0;
}
