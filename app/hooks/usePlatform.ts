"use client";

import { useSyncExternalStore } from "react";
import { platformFrom, REVEAL_LABELS, type Platform } from "../lib/platform";

type Bridge = { getRuntimeInfo?: () => Promise<{ platform?: string } | null | undefined> };

let current: Platform | null = null;
const listeners = new Set<() => void>();

function guess(): Platform {
  if (typeof navigator === "undefined") return "mac";
  const hinted = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform;
  return platformFrom(hinted || navigator.platform || navigator.userAgent);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (current === null) {
    current = guess();
    // The desktop app knows for sure; ask once.
    const bridge = (window as unknown as { skillManagerDesktop?: Bridge }).skillManagerDesktop;
    bridge?.getRuntimeInfo?.()
      .then((info) => {
        const next = info?.platform ? platformFrom(info.platform) : current;
        if (next && next !== current) {
          current = next;
          listeners.forEach((item) => item());
        }
      })
      .catch(() => {});
  }
  return () => listeners.delete(listener);
}

const snapshot = (): Platform => current ?? guess();

export function usePlatform(): Platform {
  return useSyncExternalStore(subscribe, snapshot, () => "mac");
}

/** "在访达中显示" / "在资源管理器中显示" / "在文件管理器中显示". */
export function useRevealLabel(): string {
  return REVEAL_LABELS[usePlatform()];
}
