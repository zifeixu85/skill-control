"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api } from "../lib/api";

/**
 * Small, reused images (agent icons, plugin logos, avatars) fetched once from the local
 * service and kept as blob URLs. A plain <img src> to another loopback port can be
 * refused by Chromium's cross-origin resource policy; a CORS fetch is always allowed.
 */
export type ImageBlobState = { status: "loading" } | { status: "ready"; url: string } | { status: "failed" };

interface Entry {
  state: ImageBlobState;
  failedAt: number;
}

const LOADING: ImageBlobState = { status: "loading" };
const FAILED: ImageBlobState = { status: "failed" };
/** A failed icon (e.g. app not installed) is retried after this long. */
const RETRY_FAILED_MS = 5 * 60_000;
const LIMIT = 300;

const cache = new Map<string, Entry>();
const subscribers = new Map<string, number>();
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((listener) => listener());
}

/** Drops (and revokes) the oldest images nobody is showing. */
function evict() {
  if (cache.size <= LIMIT) return;
  for (const [src, entry] of cache) {
    if (cache.size <= LIMIT * 0.75) break;
    if ((subscribers.get(src) || 0) > 0 || entry.state.status === "loading") continue;
    if (entry.state.status === "ready") URL.revokeObjectURL(entry.state.url);
    cache.delete(src);
  }
}

function ensure(src: string) {
  const existing = cache.get(src);
  if (existing && !(existing.state.status === "failed" && Date.now() - existing.failedAt > RETRY_FAILED_MS)) return;
  cache.set(src, { state: LOADING, failedAt: 0 });
  evict();
  api.fetchBlob(src).then(
    (blob) => {
      cache.set(
        src,
        blob.type.startsWith("image/")
          ? { state: { status: "ready", url: URL.createObjectURL(blob) }, failedAt: 0 }
          : { state: FAILED, failedAt: Date.now() },
      );
      notify();
    },
    () => {
      cache.set(src, { state: FAILED, failedAt: Date.now() });
      notify();
    },
  );
}

export function useImageBlob(src: string | null): ImageBlobState {
  const subscribe = useCallback(
    (listener: () => void) => {
      listeners.add(listener);
      if (src) subscribers.set(src, (subscribers.get(src) || 0) + 1);
      return () => {
        listeners.delete(listener);
        if (src) subscribers.set(src, Math.max(0, (subscribers.get(src) || 1) - 1));
      };
    },
    [src],
  );
  const state = useSyncExternalStore(
    subscribe,
    () => (src ? (cache.get(src)?.state ?? LOADING) : FAILED),
    () => (src ? LOADING : FAILED),
  );
  // Also re-requests when the entry was evicted or a failure has aged out.
  const missing = Boolean(src) && state === LOADING && !cache.has(src || "");
  useEffect(() => {
    if (src) ensure(src);
  }, [src, missing]);
  return state;
}
