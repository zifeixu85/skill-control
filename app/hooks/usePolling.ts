"use client";

import { useEffect, useEffectEvent } from "react";

/** Calls `tick` every `intervalMs` while `active` (e.g. while usage is still indexing). */
export function usePolling(active: boolean, tick: () => void, intervalMs = 3_000) {
  const onTick = useEffectEvent(tick);
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => onTick(), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
}
