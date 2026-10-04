"use client";

import { useSyncExternalStore } from "react";

let now = 0;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      listeners.forEach((item) => item());
    }, 30_000);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function snapshot() {
  if (!now) now = Date.now();
  return now;
}

/** Wall-clock time that ticks every 30 s, for "3 分钟前" labels. Zero during SSR. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, snapshot, () => 0);
}
