/**
 * Opens an https link outside the app: through the desktop bridge when present (the packaged
 * app must not navigate itself), else in a new browser tab. Anything but https is ignored.
 */
export const isHttpsUrl = (url: string | null | undefined): url is string => /^https:\/\/[^\s]+$/iu.test(String(url || ""));

export function openExternal(url: string): boolean {
  if (!isHttpsUrl(url) || typeof window === "undefined") return false;
  const bridge = (window as { skillManagerDesktop?: { openExternal?: (url: string) => unknown } }).skillManagerDesktop;
  if (typeof bridge?.openExternal === "function") {
    void Promise.resolve(bridge.openExternal(url)).catch(() => window.open(url, "_blank", "noopener,noreferrer"));
    return true;
  }
  window.open(url, "_blank", "noopener,noreferrer");
  return true;
}
