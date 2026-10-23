"use client";

import { useCallback, useSyncExternalStore } from "react";

/** True while the media query matches; false on the server and before hydration. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener("change", listener);
      return () => list.removeEventListener("change", listener);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false),
    () => false,
  );
}
