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
}

interface Entry {
  state: ResourceState<unknown>;
  promise: Promise<void> | null;
  fetcher: (() => Promise<unknown>) | null;
}

const IDLE: ResourceState<never> = { status: "idle", data: undefined, error: null, refreshing: false };
const LOADING: ResourceState<never> = { status: "loading", data: undefined, error: null, refreshing: false };

const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();

function notify(key: string) {
  listeners.get(key)?.forEach((listener) => listener());
}

function setState(key: string, state: ResourceState<unknown>) {
  const entry = entries.get(key) || { state, promise: null, fetcher: null };
  entries.set(key, { ...entry, state });
  notify(key);
}

/** Starts (or joins) a load. `force` refetches while keeping the previous data visible. */
export function loadResource(key: string, fetcher?: () => Promise<unknown>, force = false): Promise<void> {
  const existing = entries.get(key);
  const run = fetcher || existing?.fetcher;
  if (!run) return Promise.resolve();
  if (existing?.promise) return existing.promise;
  if (existing && existing.state.status === "ready" && !force) return Promise.resolve();
  const previous = existing?.state;
  const promise = run().then(
    (data) => setState(key, { status: "ready", data, error: null, refreshing: false }),
    (error: unknown) =>
      setState(key, {
        status: previous?.data !== undefined ? "ready" : "error",
        data: previous?.data,
        error: error instanceof Error ? error : new Error("读取失败。"),
        refreshing: false,
      }),
  );
  entries.set(key, {
    fetcher: run,
    promise: promise.finally(() => {
      const current = entries.get(key);
      if (current) entries.set(key, { ...current, promise: null });
    }),
    state: previous?.data !== undefined ? { ...previous, refreshing: true } : LOADING,
  });
  notify(key);
  return entries.get(key)?.promise || promise;
}

/** Reloads every cached resource whose key starts with one of the prefixes. */
export function reloadResources(...prefixes: string[]): Promise<void[]> {
  const keys = [...entries.keys()].filter((key) => prefixes.some((prefix) => key.startsWith(prefix)));
  return Promise.all(keys.map((key) => loadResource(key, undefined, true)));
}

export function dropResources(...prefixes: string[]): void {
  for (const key of [...entries.keys()]) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      entries.delete(key);
      notify(key);
    }
  }
}

function subscribeTo(key: string | null) {
  return (listener: () => void) => {
    if (!key) return () => undefined;
    const set = listeners.get(key) || new Set();
    set.add(listener);
    listeners.set(key, set);
    return () => set.delete(listener);
  };
}

/**
 * Cached GET keyed by `key`. Components sharing a key share one request and one result,
 * so remounting a page never refetches or flashes a loading state.
 */
export function useResource<T>(key: string | null, fetcher: () => Promise<T>) {
  const subscribe = useCallback((listener: () => void) => subscribeTo(key)(listener), [key]);
  const state = useSyncExternalStore(
    subscribe,
    () => (key ? (entries.get(key)?.state ?? LOADING) : IDLE),
    () => (key ? LOADING : IDLE),
  ) as ResourceState<T>;
  const start = useEffectEvent((resourceKey: string) => {
    void loadResource(resourceKey, fetcher);
  });
  useEffect(() => {
    if (key) start(key);
  }, [key]);
  const reload = useCallback(() => (key ? loadResource(key, undefined, true) : Promise.resolve()), [key]);
  return useMemo(() => ({ ...state, reload }), [state, reload]);
}

/** True when the service is older and does not have this route at all. */
export function isUnsupported(error: Error | null): boolean {
  return error instanceof ApiError && error.unsupported;
}
