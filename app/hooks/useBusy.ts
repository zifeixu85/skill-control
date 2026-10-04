"use client";

import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";

/**
 * Lets content inside a drawer mark it busy (a write in flight), so the drawer's close
 * button and Esc wait until the write finishes.
 */
export interface BusyStore {
  add: () => () => void;
  subscribe: (listener: () => void) => () => void;
  busy: () => boolean;
}

function createBusyStore(): BusyStore {
  let count = 0;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  return {
    add() {
      count += 1;
      emit();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        count -= 1;
        emit();
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    busy: () => count > 0,
  };
}

export const BusyContext = createContext<BusyStore | null>(null);

/** Owner side: a store for the subtree plus whether anything in it is busy. */
export function useBusyOwner(): { store: BusyStore; busy: boolean } {
  const [store] = useState(createBusyStore);
  const busy = useSyncExternalStore(store.subscribe, store.busy, () => false);
  return { store, busy };
}

/** Content side: marks the nearest owner busy while `busy` is true. */
export function useMarkBusy(busy: boolean) {
  const store = useContext(BusyContext);
  useEffect(() => {
    if (!busy || !store) return undefined;
    return store.add();
  }, [busy, store]);
}
