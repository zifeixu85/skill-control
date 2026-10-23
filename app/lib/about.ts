import { version as packageVersion } from "../../package.json";

/**
 * 设置 → 关于. Author details confirmed by A梦 (2026-10-24): name and website only, no email
 * or other contact. The version is never hardcoded: the desktop app's runtime answer wins,
 * else package.json at build time.
 */

export const APP_NAME = "Skill Control";

export const AUTHOR = {
  name: "A梦",
  website: { url: "https://ameng.blog", label: "ameng.blog" },
} as const;

export const LINKS = {
  repository: "https://github.com/zifeixu85/skill-control",
  issues: "https://github.com/zifeixu85/skill-control/issues",
  releases: "https://github.com/zifeixu85/skill-control/releases",
  license: "https://github.com/zifeixu85/skill-control/blob/main/LICENSE",
  thirdParty: "https://github.com/zifeixu85/skill-control/blob/main/THIRD_PARTY_NOTICES.md",
} as const;

export const LICENSE_NAME = "MIT";

/** The bundled version, e.g. "0.2.0". */
export const BUILD_VERSION: string = typeof packageVersion === "string" ? packageVersion : "";

/** Runtime version from the desktop app when known, else the bundled one. */
export function appVersion(runtime?: string | null): string {
  const value = (runtime || BUILD_VERSION || "").trim();
  return value.replace(/^v/iu, "");
}
