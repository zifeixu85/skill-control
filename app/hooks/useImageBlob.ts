"use client";

import { useEffect, useSyncExternalStore } from "react";
import { api } from "../lib/api";

/**
 * Small, reused images (agent icons, plugin logos, avatars) fetched once from the local
 * service and kept as blob URLs. A plain <img src> to another loopback port can be
 * refused by Chromium's cross-origin resource policy; a CORS fetch is always allowed.
 */
export type ImageBlobState = { status: "loading" } | { status: "ready"; url: string } | { status: "failed" };

const LOADING: ImageBlobState = { status: "loading" };
const FAILED: ImageBlobState = { status: "failed" };
const cache = new Map<string, ImageBlobState>();
const listeners = new Set<() => void>();
const LIMIT = 300;

function notify() {
  listeners.forEach((listener) => listener());
}

function ensure(src: string) {
  if (cache.has(src)) return;
  if (cache.size >= LIMIT) {
    for (const [key, value] of cache) {
      if (value.status === "ready") URL.revokeObjectURL(value.url);
      cache.delete(key);
      if (cache.size < LIMIT / 2) break;
    }
  }
  cache.set(src, LOADING);
  api.fetchBlob(src).then(
    (blob) => {
      cache.set(src, blob.type.startsWith("image/") ? { status: "ready", url: URL.createObjectURL(blob) } : FAILED);
      notify();
    },
    () => {
      cache.set(src, FAILED);
      notify();
    },
  );
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useImageBlob(src: string | null): ImageBlobState {
  const state = useSyncExternalStore(
    subscribe,
    () => (src ? (cache.get(src) ?? LOADING) : FAILED),
    () => (src ? LOADING : FAILED),
  );
  useEffect(() => {
    if (src) ensure(src);
  }, [src]);
  return state;
}
