/** localStorage wrappers: storage can be missing, full or blocked, so every access is guarded. */

const PREFIX = "skill-control:";

export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(PREFIX + key);
    else window.localStorage.setItem(PREFIX + key, value);
  } catch {
    // Preferences are a convenience; failing to persist them is harmless.
  }
}

export function readSession(key: string): string | null {
  try {
    return window.sessionStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export function writeSession(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(PREFIX + key, value);
  } catch {
    // Same as above.
  }
}

type Listener = () => void;

export interface PersistentStore<T> {
  get(): T;
  getServer(): T;
  set(value: T): void;
  subscribe(listener: Listener): () => void;
}

/**
 * A tiny external store for one remembered preference. The server snapshot is always
 * the fallback so hydration matches; the stored value applies right after.
 */
export function persistentStore<T extends string>(
  key: string,
  fallback: T,
  validate: (value: string) => boolean = () => true,
): PersistentStore<T> {
  const listeners = new Set<Listener>();
  let loaded = false;
  let value = fallback;
  const load = () => {
    if (loaded || typeof window === "undefined") return;
    loaded = true;
    const stored = readStored(key);
    if (stored !== null && validate(stored)) value = stored as T;
  };
  return {
    get() {
      load();
      return value;
    },
    getServer: () => fallback,
    set(next) {
      load();
      if (next === value) return;
      value = next;
      writeStored(key, next);
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
