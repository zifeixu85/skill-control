"use client";

import { useSyncExternalStore } from "react";
import type { PersistentStore } from "../lib/storage";

export function usePersistent<T extends string>(store: PersistentStore<T>): [T, (value: T) => void] {
  const value = useSyncExternalStore(store.subscribe, store.get, store.getServer);
  return [value, store.set];
}
