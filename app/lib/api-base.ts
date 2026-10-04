export const DEFAULT_API_BASE = "http://127.0.0.1:43110";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Accepts only a bare loopback http origin (no path, credentials or query). */
export function loopbackOrigin(candidate: unknown): string | null {
  if (typeof candidate !== "string" || !candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:") return null;
    if (!LOOPBACK_HOSTS.has(url.hostname)) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Desktop (preload) wins, then a development-only build variable, then the default.
 * Production web builds ignore the variable so their behavior never changes.
 */
export function resolveApiBase({
  desktopBase,
  envBase,
  development,
}: {
  desktopBase?: unknown;
  envBase?: unknown;
  development: boolean;
}): string {
  return (
    loopbackOrigin(desktopBase) ||
    (development ? loopbackOrigin(envBase) : null) ||
    DEFAULT_API_BASE
  );
}
