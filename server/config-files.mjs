import { homedir } from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import JSON5 from "json5";
import { readBoundedText } from "./fs-safe.mjs";

/**
 * Bounded readers for agent configuration formats (YAML for Hermes, JSON5 for OpenClaw,
 * XML plists for app bundles). Parse failures return a status, never parser messages.
 */

export const CONFIG_LIMIT = 2_000_000;

export async function readYamlFile(filePath, limit = CONFIG_LIMIT) {
  const read = await readBoundedText(filePath, limit);
  if (read.status !== "ok") return read;
  try {
    // js-yaml 4 `load` uses the safe default schema (no functions or custom types).
    const value = yaml.load(read.text, { json: true });
    return { status: "ok", value: value ?? {}, mtimeMs: read.mtimeMs };
  } catch {
    return { status: "invalid" };
  }
}

export async function readJson5File(filePath, limit = CONFIG_LIMIT) {
  const read = await readBoundedText(filePath, limit);
  if (read.status !== "ok") return read;
  try {
    return { status: "ok", value: JSON5.parse(read.text), mtimeMs: read.mtimeMs };
  } catch {
    return { status: "invalid" };
  }
}

/** Parses a YAML string (e.g. a SKILL.md frontmatter block); null when invalid. */
export function parseYamlSafe(text) {
  try {
    return yaml.load(String(text).slice(0, 65_536), { json: true }) ?? null;
  } catch {
    return null;
  }
}

/** Serializes a (masked) value as YAML for display. */
export function dumpYaml(value) {
  return yaml.dump(value, { lineWidth: 120, noRefs: true, sortKeys: false });
}

/**
 * Expands `~`, `${VAR}` and `$VAR` like the products do. Environment variables are only
 * honoured for the real home directory, so tests with a fake home never pick up the
 * developer's environment.
 */
export function expandUserPath(value, { homeDirectory = homedir(), base = homeDirectory, env = null } = {}) {
  if (typeof value !== "string" || !value.trim()) return null;
  const variables = env ?? (homeDirectory === homedir() ? process.env : {});
  let expanded = value
    .trim()
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]{0,127})\}|\$([A-Za-z_][A-Za-z0-9_]{0,127})/gu, (match, braced, bare) => {
      const name = braced || bare;
      return name === "HOME" ? homeDirectory : (variables[name] ?? match);
    });
  if (expanded === "~") expanded = homeDirectory;
  else if (expanded.startsWith("~/")) expanded = path.join(homeDirectory, expanded.slice(2));
  if (expanded.includes("$") || expanded.includes("\0")) return null;
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(base, expanded);
}

/**
 * Where app bundles are looked up: SKILL_MANAGER_APPLICATION_DIRS when set (tests, sandboxes),
 * else /Applications and ~/Applications for the real home, and only ~/Applications for any
 * other home directory (so a fake home never reads the machine's real apps).
 */
export function applicationDirectoriesFor(homeDirectory = homedir(), env = process.env) {
  const configured = String(env.SKILL_MANAGER_APPLICATION_DIRS || "")
    .split(path.delimiter)
    .filter((entry) => entry && path.isAbsolute(entry));
  if (configured.length) return configured;
  return homeDirectory === homedir() ? ["/Applications", path.join(homeDirectory, "Applications")] : [path.join(homeDirectory, "Applications")];
}

/** Environment variable for the real home only (tests use a fake home). */
export function envFor(homeDirectory, name) {
  if (homeDirectory !== homedir()) return undefined;
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** CFBundleIdentifier / CFBundleShortVersionString / CFBundleIconFile / SUFeedURL from an XML Info.plist. */
export async function readAppBundle(appPath) {
  const read = await readBoundedText(path.join(appPath, "Contents", "Info.plist"), 512_000);
  if (read.status !== "ok" || !read.text.startsWith("<?xml")) return null;
  const value = (key) => {
    const index = read.text.indexOf(`<key>${key}</key>`);
    if (index < 0) return null;
    const match = read.text.slice(index, index + 400).match(/<string>([^<]{1,128})<\/string>/u);
    return match ? match[1].trim() : null;
  };
  const feedIndex = read.text.indexOf("<key>SUFeedURL</key>");
  const feedUrl = feedIndex < 0 ? null : read.text.slice(feedIndex, feedIndex + 700).match(/<string>(https:\/\/[^<\s]{1,600})<\/string>/u)?.[1] || null;
  return {
    bundleId: value("CFBundleIdentifier"),
    version: value("CFBundleShortVersionString"),
    iconFile: value("CFBundleIconFile"),
    ...(feedUrl ? { feedUrl } : {}),
  };
}
