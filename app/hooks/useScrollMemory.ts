"use client";

import { useCallback } from "react";

const positions = new Map<string, number>();
const elements = new Map<string, HTMLElement>();

/** Give up waiting for content to grow tall enough after this long. */
const RESTORE_WINDOW_MS = 3_000;

/**
 * Ref callback for a scroll container that remembers its position under `key`.
 * Selecting rows or opening panels never remounts the container, so it keeps its place;
 * coming back to a page restores where the list was — also when the content arrives a
 * moment later (the position is re-applied as the page grows, until the user scrolls).
 */
export function useScrollMemory<T extends HTMLElement>(key: string) {
  return useCallback(
    (element: T | null) => {
      if (!element) return undefined;
      elements.set(key, element);
      const saved = positions.get(key) || 0;
      let restoring = saved > 0;
      const apply = () => {
        if (!restoring) return;
        element.scrollTop = saved;
        if (Math.abs(element.scrollTop - saved) < 2) restoring = false;
      };
      apply();
      const observer = restoring ? new MutationObserver(apply) : null;
      observer?.observe(element, { childList: true, subtree: true });
      const stop = () => {
        restoring = false;
        observer?.disconnect();
      };
      const timer = restoring ? window.setTimeout(stop, RESTORE_WINDOW_MS) : 0;
      // A real scroll by the user ends restoring; clamped scrolls while content loads don't count.
      const remember = () => {
        if (!restoring) positions.set(key, element.scrollTop);
      };
      const takeOver = () => stop();
      element.addEventListener("scroll", remember, { passive: true });
      element.addEventListener("wheel", takeOver, { passive: true });
      element.addEventListener("touchstart", takeOver, { passive: true });
      element.addEventListener("keydown", takeOver);
      element.addEventListener("pointerdown", takeOver);
      return () => {
        stop();
        window.clearTimeout(timer);
        element.removeEventListener("scroll", remember);
        element.removeEventListener("wheel", takeOver);
        element.removeEventListener("touchstart", takeOver);
        element.removeEventListener("keydown", takeOver);
        element.removeEventListener("pointerdown", takeOver);
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
