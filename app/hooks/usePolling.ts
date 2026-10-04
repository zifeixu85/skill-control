"use client";

import { useEffect, useEffectEvent } from "react";

/** Calls `tick` every `intervalMs` while `active`, skipping ticks while the window is hidden. */
export function usePolling(active: boolean, tick: () => void, intervalMs = 3_000) {
  const onTick = useEffectEvent(tick);
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") onTick();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
}
