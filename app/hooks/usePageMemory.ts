"use client";

import { useCallback, useEffect, useEffectEvent, useSyncExternalStore } from "react";
import { openedKey, readMemory, subscribeMemory, takeArrival, writeMemory, type MemoryValue } from "../lib/page-memory";
import { revealInPage } from "../lib/reveal";

/** useState that outlives the page: leaving and coming back keeps the value (this session). */
export function usePageMemory<T extends MemoryValue>(key: string, fallback: T): [T, (value: T) => void] {
  const subscribe = useCallback((listener: () => void) => subscribeMemory(key, listener), [key]);
  const value = useSyncExternalStore(
    subscribe,
    () => readMemory(key, fallback),
    () => fallback,
  );
  const set = useCallback((next: T) => writeMemory(key, next), [key]);
  return [value, set];
}

/** The id of the item last opened from `page`, for a quiet "上次查看" marker. */
export function useOpenedItem(page: string): string | null {
  return usePageMemory<string | null>(openedKey(page), null)[0];
}

/**
 * Once the page's content is there, flash the item opened before leaving — once per
 * 查看详情, scrolling only if the remembered position doesn't already show it. Rows carry
 * data-memory-id.
 */
export function useReturnHighlight(page: string, ready: boolean): void {
  const reveal = useEffectEvent(() => {
    const id = takeArrival(page);
    if (!id) return;
    const target = [...document.querySelectorAll<HTMLElement>("[data-memory-id]")].find((element) => element.dataset.memoryId === id);
    revealInPage(target || null, { ifNeeded: true });
  });
  useEffect(() => {
    if (!ready) return undefined;
    const frame = window.requestAnimationFrame(() => reveal());
    return () => window.cancelAnimationFrame(frame);
  }, [ready]);
}
