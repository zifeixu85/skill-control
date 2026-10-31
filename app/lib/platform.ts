/**
 * Which desktop the app runs on, for wording only (the service picks the right program:
 * open -R, explorer.exe or xdg-open). The desktop bridge says process.platform; a browser
 * falls back to navigator.
 */

export type Platform = "mac" | "windows" | "linux";

export function platformFrom(value: string | null | undefined): Platform {
  const text = String(value || "").toLowerCase();
  if (text.startsWith("win")) return "windows";
  if (text.includes("linux") || text.includes("x11") || text.includes("cros") || text.includes("freebsd")) return "linux";
  return "mac";
}

/** "在访达中显示" on macOS, the File Explorer / file manager elsewhere. */
export const REVEAL_LABELS: Record<Platform, string> = {
  mac: "在访达中显示",
  windows: "在资源管理器中显示",
  linux: "在文件管理器中显示",
};

export const FILE_MANAGER_NAMES: Record<Platform, string> = {
  mac: "访达",
  windows: "资源管理器",
  linux: "文件管理器",
};
