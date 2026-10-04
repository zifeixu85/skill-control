"use client";

import { useCallback } from "react";

const positions = new Map<string, number>();

/**
 * Ref callback for a scroll container that remembers its position under `key`.
 * Selecting rows or opening panels never remounts the container, so it keeps its place;
 * coming back to a page restores where the list was.
 */
export function useScrollMemory<T extends HTMLElement>(key: string) {
  return useCallback(
    (element: T | null) => {
      if (!element) return undefined;
      const saved = positions.get(key);
      if (saved) element.scrollTop = saved;
      const remember = () => positions.set(key, element.scrollTop);
      element.addEventListener("scroll", remember, { passive: true });
      return () => element.removeEventListener("scroll", remember);
    },
    [key],
  );
}
