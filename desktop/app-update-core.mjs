import yaml from "js-yaml";

/**
 * Pure rules for Skill Control's own updates: versions, the GitHub release response, the
 * electron-builder update manifest (latest-mac.yml), allowed download hosts, Info.plist
 * reading and which installs can update themselves. No I/O here, so all of it is testable.
 */

export const REPOSITORY = Object.freeze({ owner: "zifeixu85", repo: "skill-control" });
export const RELEASES_URL = `https://github.com/${REPOSITORY.owner}/${REPOSITORY.repo}/releases`;
export const LATEST_RELEASE_API = `https://api.github.com/repos/${REPOSITORY.owner}/${REPOSITORY.repo}/releases/latest`;
export const BUNDLE_ID = "dev.skillcontrol.desktop";
export const MAC_MANIFEST_NAME = "latest-mac.yml";

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const MAX_NOTES_LENGTH = 20_000;
export const MAX_MANIFEST_BYTES = 256 * 1024;
export const MAX_RELEASE_JSON_BYTES = 2 * 1024 * 1024;
export const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;

const ASSET_PREFIX = `/${REPOSITORY.owner}/${REPOSITORY.repo}/releases/download/`;
const DOWNLOAD_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const SHA512_BASE64 = /^[A-Za-z0-9+/]{86}==$/u;
const VERSION_PATTERN =
  /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/u;

/** One sentence per reason an install cannot update itself (shown next to "打开下载页"). */
export const MANUAL_TEXT = Object.freeze({
  offline: "离线模式，不检查应用更新。",
  development: "从源码运行时不检查应用更新，请用 git pull 获取新版本。",
  platform: "这个平台不支持应用内更新，请从下载页获取新版本。",
  portable: "便携版不能自动更新，请从下载页下载新版本替换。",
  package: "这种安装方式不能自动更新，请从下载页下载新的安装包（AppImage 版可以自动更新）。",
  location: "应用所在的位置不可写，请从下载页下载新版本，或先把应用移到“应用程序”文件夹。",
});

/** Shown before installing on platforms whose installers are not signed. */
export const UNSIGNED_NOTICE = Object.freeze({
  win32: "Windows 安装包没有代码签名，安装时 SmartScreen 可能提示“未知发布者”，选择“更多信息 → 仍要运行”即可继续。",
  linux: "AppImage 没有签名，新版本会替换当前的 AppImage 文件。",
});

export class UpdateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "UpdateError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Versions

/** "v1.2.3-beta.1" → { major, minor, patch, prerelease: ["beta", "1"] }; null when invalid. */
export function parseVersion(value) {
  if (typeof value !== "string") return null;
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

/** "1.2.3-beta.1" without the leading v or build metadata; null when invalid. */
export function normalizeVersion(value) {
  const parsed = parseVersion(value);
  if (!parsed) return null;
  const core = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  return parsed.prerelease.length ? `${core}-${parsed.prerelease.join(".")}` : core;
}

function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right));
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Semantic-version precedence: -1, 0 or 1; null when either side is not a version. */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    const result = compareIdentifiers(a.prerelease[index], b.prerelease[index]);
    if (result) return result;
  }
  return 0;
}

export const isNewerVersion = (candidate, current) => compareVersions(candidate, current) === 1;

// ---------------------------------------------------------------------------
// URLs

function parseUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

/** A release asset of this repository on github.com. */
export function isAllowedAssetUrl(value) {
  const url = parseUrl(value);
  return Boolean(url && url.hostname === "github.com" && !url.port && url.pathname.startsWith(ASSET_PREFIX));
}

/** Where a download may end up after GitHub's redirects. */
export function isAllowedDownloadUrl(value) {
  const url = parseUrl(value);
  return Boolean(url && !url.port && DOWNLOAD_HOSTS.has(url.hostname));
}

/** The release page on github.com for this repository, else the releases list. */
export function releasePageUrl(value) {
  const url = parseUrl(value);
  return url && url.hostname === "github.com" && url.pathname.startsWith(`/${REPOSITORY.owner}/${REPOSITORY.repo}/releases/`)
    ? url.toString()
    : RELEASES_URL;
}

// ---------------------------------------------------------------------------
// GitHub release

/** Trims release notes to MAX_NOTES_LENGTH characters; null when empty. */
export function sanitizeNotes(value) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\r\n?/gu, "\n").trim();
  if (!text) return null;
  return text.length > MAX_NOTES_LENGTH ? `${text.slice(0, MAX_NOTES_LENGTH).trimEnd()}\n…` : text;
}

/**
 * GET /repos/{owner}/{repo}/releases/latest → { version, tag, url, notes, publishedAt, assets }.
 * Drafts and pre-releases give null, like "no release" (that endpoint never returns them
 * anyway). Assets keep only safe file names that download from this repository.
 */
export function parseReleaseResponse(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new UpdateError("manifest", "GitHub 返回的发布信息格式不对。");
  }
  if (json.draft === true || json.prerelease === true) return null;
  const version = normalizeVersion(json.tag_name);
  if (!version) throw new UpdateError("manifest", "最新发布的版本号无法识别。");
  const assets = new Map();
  for (const asset of Array.isArray(json.assets) ? json.assets.slice(0, 200) : []) {
    if (!asset || typeof asset.name !== "string" || !SAFE_FILE_NAME.test(asset.name)) continue;
    if (!isAllowedAssetUrl(asset.browser_download_url)) continue;
    const size = Number.isSafeInteger(asset.size) && asset.size > 0 ? asset.size : null;
    assets.set(asset.name, { url: asset.browser_download_url, size });
  }
  const published = typeof json.published_at === "string" ? Date.parse(json.published_at) : Number.NaN;
  return {
    version,
    tag: String(json.tag_name),
    url: releasePageUrl(json.html_url),
    notes: sanitizeNotes(json.body),
    publishedAt: Number.isFinite(published) ? new Date(published).toISOString() : null,
    assets,
  };
}

// ---------------------------------------------------------------------------
// latest-mac.yml

/** Every scalar stays a string (FAILSAFE), so "1.10" is never read as a number. */
export function parseMacManifest(text) {
  if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text, "utf8") > MAX_MANIFEST_BYTES) {
    throw new UpdateError("manifest", "更新清单为空或过大。");
  }
  let raw;
  try {
    raw = yaml.load(text, { schema: yaml.FAILSAFE_SCHEMA });
  } catch {
    throw new UpdateError("manifest", "更新清单无法解析。");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new UpdateError("manifest", "更新清单格式不对。");
  const version = normalizeVersion(raw.version);
  if (!version) throw new UpdateError("manifest", "更新清单里的版本号无法识别。");
  if (!Array.isArray(raw.files) || !raw.files.length || raw.files.length > 50) {
    throw new UpdateError("manifest", "更新清单里没有文件列表。");
  }
  const files = raw.files.map((file) => {
    const size = typeof file?.size === "string" && /^\d{1,12}$/u.test(file.size) ? Number(file.size) : Number.NaN;
    if (
      typeof file?.url !== "string" ||
      !SAFE_FILE_NAME.test(file.url) ||
      typeof file.sha512 !== "string" ||
      !SHA512_BASE64.test(file.sha512) ||
      !(size > 0 && size <= MAX_DOWNLOAD_BYTES)
    ) {
      throw new UpdateError("manifest", "更新清单里有无效的文件条目。");
    }
    return { url: file.url, sha512: file.sha512, size };
  });
  return { version, files, releaseDate: typeof raw.releaseDate === "string" ? raw.releaseDate : null };
}

/** The zip for this Mac's architecture ("arm64" or "x64") and the manifest's version. */
export function pickMacZip(manifest, arch) {
  if (arch !== "arm64" && arch !== "x64") {
    throw new UpdateError("platform", `不支持在 ${arch} 架构上自动更新。`);
  }
  const suffix = `-mac-${arch}.zip`;
  const matches = manifest.files.filter(
    (file) => file.url.endsWith(suffix) && file.url.includes(`-${manifest.version}-`),
  );
  if (matches.length !== 1) {
    throw new UpdateError("manifest", `这个版本没有适合本机（${arch}）的更新包。`);
  }
  return matches[0];
}

/**
 * Release CI: one latest-mac.yml from the arm64 and x64 builds (each build writes its own).
 * Inputs are the loaded YAML objects; files are merged by url, the top-level legacy
 * path/sha512 point at the x64 zip, and releaseDate is the latest one.
 */
export function mergeMacManifests(manifests) {
  if (!Array.isArray(manifests) || manifests.length === 0) throw new Error("没有可合并的 latest-mac.yml。");
  const versions = new Set(manifests.map((manifest) => String(manifest?.version)));
  if (versions.size !== 1) throw new Error(`latest-mac.yml 的版本不一致：${[...versions].join(", ")}`);
  const files = new Map();
  for (const manifest of manifests) {
    if (!Array.isArray(manifest.files)) throw new Error("latest-mac.yml 缺少 files。");
    for (const file of manifest.files) {
      const existing = files.get(file.url);
      if (existing && existing.sha512 !== file.sha512) throw new Error(`同名文件的 sha512 不一致：${file.url}`);
      files.set(file.url, { ...file });
    }
  }
  const merged = [...files.values()].sort((left, right) => String(left.url).localeCompare(String(right.url)));
  const primary =
    merged.find((file) => /-mac-x64\.zip$/u.test(file.url)) ||
    merged.find((file) => /\.zip$/u.test(file.url)) ||
    merged[0];
  const dates = manifests.map((manifest) => String(manifest.releaseDate || "")).filter(Boolean).sort();
  return {
    ...manifests[0],
    files: merged,
    path: primary.url,
    sha512: primary.sha512,
    ...(dates.length ? { releaseDate: dates.at(-1) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Info.plist (XML)

const XML_ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeXml(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (entity, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return XML_ENTITIES[body.toLowerCase()] ?? entity;
  });
}

/** Top-level string and boolean keys of an XML property list; nested dicts and arrays are skipped. */
export function readInfoPlistXml(text) {
  if (typeof text !== "string" || text.length > 1_000_000) throw new UpdateError("bundle", "Info.plist 无效。");
  const start = text.indexOf("<dict>");
  if (start < 0) throw new UpdateError("bundle", "Info.plist 里没有字典。");
  const tag = /<(\/?)(dict|array|key|string|integer|real|date|data|true|false)\s*(\/?)>/gu;
  tag.lastIndex = start;
  const result = Object.create(null);
  let depth = 0;
  let key = null;
  for (let match = tag.exec(text); match; match = tag.exec(text)) {
    const [, closing, name, selfClosing] = match;
    if (name === "dict" || name === "array") {
      if (closing) {
        depth -= 1;
        if (depth === 0) return result;
      } else {
        if (depth === 1) key = null;
        if (!selfClosing) depth += 1;
      }
      continue;
    }
    if (closing) continue;
    if (name === "true" || name === "false") {
      if (depth === 1 && key !== null) result[key] = name === "true";
      if (depth === 1) key = null;
      continue;
    }
    let content = "";
    if (!selfClosing) {
      const end = text.indexOf(`</${name}>`, tag.lastIndex);
      if (end < 0) throw new UpdateError("bundle", "Info.plist 格式不完整。");
      content = decodeXml(text.slice(tag.lastIndex, end));
      tag.lastIndex = end + name.length + 3;
    }
    if (depth !== 1) continue;
    if (name === "key") key = content;
    else if (key !== null) {
      result[key] = content;
      key = null;
    }
  }
  throw new UpdateError("bundle", "Info.plist 格式不完整。");
}

// ---------------------------------------------------------------------------
// Scheduling and support

/** True when the last check is missing, unreadable, older than the interval or in the future. */
export function shouldCheck({ checkedAt, now, intervalMs = CHECK_INTERVAL_MS }) {
  const last = typeof checkedAt === "string" ? Date.parse(checkedAt) : Number.NaN;
  if (!Number.isFinite(last)) return true;
  const age = now - last;
  return age >= intervalMs || age < -intervalMs;
}

/**
 * What this install can do: check (talk to GitHub) and install (replace itself).
 * backend "mac" is the custom updater; "electron-updater" covers NSIS and AppImage.
 */
export function updateSupport({ platform, arch, packaged, env = {} }) {
  if (env.SKILL_MANAGER_UPDATES_OFFLINE === "1") return { check: false, install: false, reason: "offline", backend: null };
  if (!packaged) return { check: false, install: false, reason: "development", backend: null };
  if (platform === "darwin") {
    return arch === "arm64" || arch === "x64"
      ? { check: true, install: true, reason: null, backend: "mac" }
      : { check: false, install: false, reason: "platform", backend: null };
  }
  if (platform === "win32") {
    return env.PORTABLE_EXECUTABLE_DIR || env.PORTABLE_EXECUTABLE_FILE
      ? { check: true, install: false, reason: "portable", backend: null }
      : { check: true, install: true, reason: null, backend: "electron-updater" };
  }
  if (platform === "linux") {
    return env.APPIMAGE
      ? { check: true, install: true, reason: null, backend: "electron-updater" }
      : { check: true, install: false, reason: "package", backend: null };
  }
  return { check: false, install: false, reason: "platform", backend: null };
}

/** "Skill Control 0.1.0 (replaced 20261024-101530).app": the name the old bundle gets in the Trash. */
export function backupNameFor(bundleName, version, date) {
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const safeVersion = normalizeVersion(version) || "old";
  return `${bundleName} ${safeVersion} (replaced ${stamp}).app`;
}

/** A user-facing message for any thrown value. */
export function messageOf(error) {
  if (error instanceof UpdateError) return error.message;
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "连接 GitHub 超时，请稍后再试。";
  if (error instanceof TypeError) return "网络不可用，没能连接 GitHub。";
  return "应用更新出错了，请稍后再试。";
}
