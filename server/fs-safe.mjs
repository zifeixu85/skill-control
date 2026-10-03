import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { scrubTokens } from "./redact.mjs";

/** Shared read-only helpers for integration scanners. Nothing here writes to disk. */

export { MASK, scrubTokens } from "./redact.mjs";

export const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

/**
 * Normalizes an outbound string: control characters become spaces, format characters
 * (bidi overrides, zero-width joiners — \p{Cf}) are removed, and the result is capped.
 */
export const text = (value, limit = 160) =>
  typeof value === "string"
    ? scrubTokens(
        value
          .slice(0, limit * 4)
          .replace(/\p{Cf}/gu, "")
          .replace(/[\u0000-\u001f\u007f]/gu, " ")
          .trim(),
      ).slice(0, limit)
    : "";

/** Like text(), but keeps line breaks for multi-line values. */
export const multilineText = (value, limit = 4_000) =>
  typeof value === "string"
    ? scrubTokens(
        value
          .slice(0, limit * 4)
          .replace(/\p{Cf}/gu, "")
          .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/gu, " ")
          .trim(),
      ).slice(0, limit)
    : "";

export const safeSegment = (value) =>
  typeof value === "string" &&
  /^[\p{L}\p{N}_][\p{L}\p{N}_.+-]{0,127}$/u.test(value) &&
  !value.includes("..");

export const identifier = (value, limit = 160) =>
  typeof value === "string" && /^[\p{L}\p{N}_.:@/ -]{1,160}$/u.test(value)
    ? value.slice(0, limit)
    : "";

/**
 * File names that may hold credentials and are never shown or followed from manifests:
 * .env*, *.pem, *.key, id_*, .npmrc, .netrc, auth*.json, credentials*, settings.json,
 * .mcp.json (shown only after parsing and masking by the dedicated readers).
 */
export function isSensitiveFileName(relativePath, { allow = [] } = {}) {
  const normalized = String(relativePath || "").replaceAll("\\", "/").toLowerCase();
  if (allow.map((item) => item.toLowerCase()).includes(normalized.replace(/^\.\//u, ""))) return false;
  const segments = normalized.split("/");
  const name = segments.at(-1) || "";
  return (
    segments.includes(".git") ||
    segments.includes(".ssh") ||
    /^\.env(?:\.|$)/u.test(name) ||
    /\.(?:pem|key|p12|pfx|keystore|jks|kdbx)$/u.test(name) ||
    /^id_[a-z0-9]+/u.test(name) ||
    [".npmrc", ".netrc", ".pypirc", ".git-credentials", ".mcp.json", "settings.json", "settings.local.json"].includes(name) ||
    /^auth[^/]*\.json$/u.test(name) ||
    /^credentials?/u.test(name) ||
    /(?:^|[-_.])(?:api[-_.]?key|token|secret|credentials?|session|auth(?:entication)?|password)(?:[-_.]|$)/u.test(name)
  );
}

export function isWithin(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function isStrictlyWithin(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Splits `name@marketplace` plugin keys; both parts must be safe path segments. */
export function splitPluginKey(key) {
  if (typeof key !== "string") return null;
  const separator = key.lastIndexOf("@");
  if (separator < 1) return null;
  const name = key.slice(0, separator);
  const marketplace = key.slice(separator + 1);
  return safeSegment(name) && safeSegment(marketplace) ? { name, marketplace } : null;
}

export function compactHomePath(inputPath, homeDirectories, limit = 512) {
  if (typeof inputPath !== "string" || !inputPath) return "";
  for (const home of homeDirectories.filter(Boolean)) {
    if (inputPath === home) return "~";
    if (inputPath.startsWith(`${home}${path.sep}`)) {
      return text(`~/${inputPath.slice(home.length + 1).split(path.sep).join("/")}`, limit);
    }
  }
  return text(inputPath, limit);
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * Patterns that match one home directory inside free or serialized text: POSIX homes
 * exactly (and not as a prefix of a longer name), Windows homes with either separator,
 * JSON-escaped backslashes and any drive-letter case.
 */
// A home path ends at a separator, quote, whitespace or punctuation — never mid-name.
const HOME_END = String.raw`(?=[/\\"'\s:;,)\]}]|$)`;
// Windows separators: "\", "/" or a JSON-escaped "\\".
const WINDOWS_SEPARATOR = String.raw`(?:\\\\|\\|/)`;

function homePatterns(home) {
  const windows = home.match(/^([A-Za-z]):[\\/](.*)$/u);
  if (!windows) {
    return [new RegExp(`${escapeRegExp(home.replace(/\/+$/u, ""))}${HOME_END}`, "gu")];
  }
  const parts = windows[2].split(/[\\/]+/u).filter(Boolean).map(escapeRegExp);
  return [
    new RegExp(
      `${escapeRegExp(windows[1])}:${WINDOWS_SEPARATOR}${parts.join(WINDOWS_SEPARATOR)}${HOME_END}`,
      "giu",
    ),
  ];
}

/** Replaces every occurrence of a home directory inside free or serialized text with "~". */
export function compactHomeInText(value, homeDirectories) {
  let result = String(value);
  const homes = [...new Set([...homeDirectories].filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const home of homes) {
    for (const pattern of homePatterns(home)) result = result.replace(pattern, "~");
  }
  return result;
}

export async function homeVariants(homeDirectory) {
  const resolved = path.resolve(homeDirectory);
  try {
    const real = await realpath(resolved);
    return real === resolved ? [resolved] : [resolved, real];
  } catch {
    return [resolved];
  }
}

export async function exists(inputPath) {
  try {
    await lstat(inputPath);
    return true;
  } catch {
    return false;
  }
}

export async function realpathOrNull(inputPath) {
  try {
    return await realpath(inputPath);
  } catch {
    return null;
  }
}

/**
 * Resolves a manifest-relative path inside `root`, following symlinks only when
 * their real target stays inside the real root. Returns null otherwise.
 */
export async function resolveInside(root, relativePath) {
  if (
    typeof relativePath !== "string" ||
    !relativePath ||
    relativePath.length > 1_024 ||
    relativePath.includes("\0") ||
    path.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath)
  ) {
    return null;
  }
  const candidate = path.resolve(root, relativePath);
  if (!isWithin(path.resolve(root), candidate)) return null;
  const [realRoot, realCandidate] = await Promise.all([
    realpathOrNull(root),
    realpathOrNull(candidate),
  ]);
  if (!realRoot || !realCandidate || !isWithin(realRoot, realCandidate)) {
    return null;
  }
  return realCandidate;
}

// O_NONBLOCK keeps a FIFO planted at a config path from hanging the open() call.
const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

/** Reads a regular file of at most `limit` bytes. Status codes are generic on purpose. */
export async function readBoundedText(filePath, limit) {
  let handle;
  try {
    handle = await open(filePath, READ_FLAGS);
  } catch (error) {
    return { status: error?.code === "ENOENT" ? "missing" : "unreadable" };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { status: "unreadable" };
    if (info.size > limit) return { status: "too-large" };
    const buffer = Buffer.alloc(Math.min(info.size, limit) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > limit) return { status: "too-large" };
    return {
      status: "ok",
      text: buffer.toString("utf8", 0, offset),
      mtimeMs: info.mtimeMs,
    };
  } catch {
    return { status: "unreadable" };
  } finally {
    await handle.close();
  }
}

/** Reads at most `limit` bytes of a regular file for display; larger files are truncated. */
export async function readTextPrefix(filePath, limit) {
  let handle;
  try {
    handle = await open(filePath, READ_FLAGS);
  } catch (error) {
    return { status: error?.code === "ENOENT" ? "missing" : "unreadable" };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { status: "unreadable" };
    const length = Math.min(info.size, limit);
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return {
      status: "ok",
      text: buffer.toString("utf8", 0, offset),
      truncated: info.size > limit,
      size: info.size,
    };
  } catch {
    return { status: "unreadable" };
  } finally {
    await handle.close();
  }
}

export async function readBoundedJson(filePath, limit) {
  const result = await readBoundedText(filePath, limit);
  if (result.status !== "ok") return result;
  try {
    return { status: "ok", value: JSON.parse(result.text), mtimeMs: result.mtimeMs };
  } catch {
    return { status: "invalid" };
  }
}

export async function readBoundedToml(filePath, limit) {
  const result = await readBoundedText(filePath, limit);
  if (result.status !== "ok") return result;
  try {
    return { status: "ok", value: parseToml(result.text), mtimeMs: result.mtimeMs };
  } catch {
    return { status: "invalid" };
  }
}

export function readStatusMessage(label, status) {
  return {
    "too-large": `${label} 超过读取上限，已跳过。`,
    invalid: `${label} 格式无效，已跳过。`,
    unreadable: `${label} 无法安全读取，已跳过。`,
  }[status] || "";
}

const DIRECTORY_READ_LIMIT = 2_000;

/**
 * Lists child directory names (no dot entries). Entries are sorted before the limit is
 * applied so the result does not depend on readdir order. Symlinks are flagged.
 */
export async function listDirectories(directoryPath, limit = 200) {
  let entries;
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates = entries
    .filter((entry) => safeSegment(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, DIRECTORY_READ_LIMIT);
  const result = [];
  for (const entry of candidates) {
    if (entry.isDirectory()) {
      result.push({ name: entry.name, isSymlink: false });
    } else if (entry.isSymbolicLink()) {
      try {
        if ((await stat(path.join(directoryPath, entry.name))).isDirectory()) {
          result.push({ name: entry.name, isSymlink: true });
        }
      } catch {
        // Dangling links are not directories.
      }
    }
  }
  return result.slice(0, limit);
}

/**
 * Finds directories that directly contain SKILL.md below `root`, bounded by depth,
 * result count and a visit budget. Each real directory is visited once, and symlinked
 * directories are followed only when they stay inside `boundary`.
 */
export async function findSkillDirectoryNames(
  root,
  boundary,
  { maxDepth = 3, limit = 200, budget = 2_000 } = {},
) {
  const names = [];
  const visited = new Set();
  let remaining = budget;
  const realBoundary = await realpathOrNull(boundary);
  if (!realBoundary) return names;
  async function visit(current, depth) {
    if (names.length >= limit || depth > maxDepth || remaining <= 0) return;
    remaining -= 1;
    let entries;
    try {
      const realCurrent = await realpath(current);
      if (!isWithin(realBoundary, realCurrent) || visited.has(realCurrent)) return;
      visited.add(realCurrent);
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.name === "SKILL.md" && entry.isFile())) {
      names.push(text(path.basename(current), 128));
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (names.length >= limit || remaining <= 0) return;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        await visit(path.join(current, entry.name), depth + 1);
      }
    }
  }
  await visit(root, 0);
  return [...new Set(names)].sort((left, right) => left.localeCompare(right));
}

/** Classifies an MCP server definition without exposing any value. */
export function mcpTransport(config) {
  const value = object(config);
  const declared = typeof value.type === "string" ? value.type.toLowerCase() : "";
  if (declared === "stdio") return "stdio";
  if (declared === "sse") return "sse";
  if (["http", "streamable-http", "streamable_http", "streamablehttp"].includes(declared)) {
    return "http";
  }
  if (typeof value.httpUrl === "string") return "http";
  if (typeof value.url === "string" || typeof value.serverUrl === "string") return "http";
  if (typeof value.command === "string") return "stdio";
  return "unknown";
}

export function hostnameOf(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? text(url.hostname, 253) : null;
  } catch {
    return null;
  }
}
