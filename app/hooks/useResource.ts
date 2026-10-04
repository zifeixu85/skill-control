"use client";

import { useCallback, useEffect, useEffectEvent, useMemo, useSyncExternalStore } from "react";
import { ApiError } from "../lib/api";

export type ResourceStatus = "idle" | "loading" | "ready" | "error";

export interface ResourceState<T> {
  status: ResourceStatus;
  data: T | undefined;
  error: Error | null;
  /** A reload is running while older data is still shown. */
  refreshing: boolean;
  /** When the data (or error) arrived; 0 while loading. */
  updatedAt: number;
}

interface Entry {
  state: ResourceState<unknown>;
  promise: Promise<void> | null;
  fetcher: (() => Promise<unknown>) | null;
  /** Bumped by every load; results of older loads are ignored. */
  generation: number;
  lastUsed: number;
}

const IDLE: ResourceState<never> = { status: "idle", data: undefined, error: null, refreshing: false, updatedAt: 0 };
const LOADING: ResourceState<never> = { status: "loading", data: undefined, error: null, refreshing: false, updatedAt: 0 };
/** Data older than this is revalidated in the background when a component mounts. */
const STALE_AFTER_MS = 2 * 60_000;
/** Unsubscribed entries beyond this are evicted, oldest first. */
const CACHE_LIMIT = 250;

const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();

const isSubscribed = (key: string) => (listeners.get(key)?.size || 0) > 0;

function notify(key: string) {
  listeners.get(key)?.forEach((listener) => listener());
}

function evict() {
  if (entries.size <= CACHE_LIMIT) return;
  const idle = [...entries.entries()]
    .filter(([key, entry]) => !isSubscribed(key) && !entry.promise)
    .sort((left, right) => left[1].lastUsed - right[1].lastUsed);
  for (const [key] of idle.slice(0, entries.size - CACHE_LIMIT)) entries.delete(key);
}

/**
 * Starts a load, or joins the one in flight. `force` always starts a fresh request
 * (an in-flight one is superseded) and keeps the previous data visible meanwhile.
 */
export function loadResource(key: string, fetcher?: () => Promise<unknown>, force = false): Promise<void> {
  const existing = entries.get(key);
  const run = fetcher || existing?.fetcher;
  if (!run) return Promise.resolve();
  if (existing?.promise && !force) return existing.promise;
  if (existing && existing.state.status === "ready" && !force) return Promise.resolve();
  const previous = existing?.state;
  const generation = (existing?.generation || 0) + 1;
  const settle = (state: ResourceState<unknown>) => {
    const current = entries.get(key);
    if (!current || current.generation !== generation) return;
    entries.set(key, { ...current, state, promise: null });
    notify(key);
  };
  const promise = run().then(
    (data) => settle({ status: "ready", data, error: null, refreshing: false, updatedAt: Date.now() }),
    (error: unknown) =>
      settle({
        status: previous?.data !== undefined ? "ready" : "error",
        data: previous?.data,
        error: error instanceof Error ? error : new Error("读取失败。"),
        refreshing: false,
        updatedAt: Date.now(),
      }),
  );
  entries.set(key, {
    fetcher: run,
    promise,
    generation,
    lastUsed: Date.now(),
    state: previous?.data !== undefined ? { ...previous, refreshing: true } : LOADING,
  });
  notify(key);
  evict();
  return promise;
}

/** Stores data fetched elsewhere (e.g. a forced rescan) without another request. */
export function primeResource<T>(key: string, data: T): void {
  const existing = entries.get(key);
  entries.set(key, {
    fetcher: existing?.fetcher || null,
    promise: null,
    generation: (existing?.generation || 0) + 1,
    lastUsed: Date.now(),
    state: { status: "ready", data, error: null, refreshing: false, updatedAt: Date.now() },
  });
  notify(key);
}

/**
 * Marks every cached key under the prefixes as outdated: keys a component is showing
 * refetch now (keeping their data until the answer arrives); the rest are dropped and
 * load fresh the next time they are used.
 */
export function invalidateResources(...prefixes: string[]): Promise<void> {
  const matches = [...entries.keys()].filter((key) => prefixes.some((prefix) => key.startsWith(prefix)));
  const loads: Promise<void>[] = [];
  for (const key of matches) {
    if (isSubscribed(key)) loads.push(loadResource(key, undefined, true));
    else entries.delete(key);
  }
  return Promise.all(loads).then(() => undefined);
}

/** Every cached key, for a full refresh. */
export const ALL_RESOURCES = "";

function subscribeTo(key: string | null) {
  return (listener: () => void) => {
    if (!key) return () => undefined;
    const set = listeners.get(key) || new Set();
    set.add(listener);
    listeners.set(key, set);
    return () => {
      set.delete(listener);
      const entry = entries.get(key);
      if (entry) entries.set(key, { ...entry, lastUsed: Date.now() });
    };
  };
}

/**
 * Cached GET keyed by `key`. Components sharing a key share one request and one result,
 * so remounting a page never flashes a loading state; stale data revalidates quietly.
 */
export function useResource<T>(key: string | null, fetcher: () => Promise<T>) {
  const subscribe = useCallback((listener: () => void) => subscribeTo(key)(listener), [key]);
  const state = useSyncExternalStore(
    subscribe,
    () => (key ? (entries.get(key)?.state ?? LOADING) : IDLE),
    () => (key ? LOADING : IDLE),
  ) as ResourceState<T>;
  const start = useEffectEvent((resourceKey: string) => {
    const entry = entries.get(resourceKey);
    const stale = entry?.state.status === "ready" && Date.now() - entry.state.updatedAt > STALE_AFTER_MS;
    void loadResource(resourceKey, fetcher, stale);
  });
  useEffect(() => {
    if (key) start(key);
  }, [key]);
  // A key dropped from the cache while shown (state fell back to loading) loads again.
  const missing = key !== null && state === LOADING;
  useEffect(() => {
    if (key && missing && !entries.get(key)?.promise) start(key);
  }, [key, missing]);
  const reload = useCallback(() => (key ? loadResource(key, undefined, true) : Promise.resolve()), [key]);
  return useMemo(() => ({ ...state, reload }), [state, reload]);
}

/** True when the service is older and does not have this route at all. */
export function isUnsupported(error: Error | null): boolean {
  return error instanceof ApiError && error.unsupported;
}

/** Current cached data for a key (no subscription, no fetch). */
export function peekResource<T>(key: string): T | undefined {
  return entries.get(key)?.state.data as T | undefined;
}

/** Keys currently cached, for refreshes that handle some keys themselves. */
export function cachedResourceKeys(): string[] {
  return [...entries.keys()];
}
