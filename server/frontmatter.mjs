import {
  chineseIntroduction,
  containsChinese,
  firstHeadingTitle,
} from "./skill-metadata.mjs";
import { text as outboundText } from "./fs-safe.mjs";

/**
 * Minimal, bounded YAML/frontmatter readers shared by skill scanning, WorkBuddy experts
 * and Hermes profiles. They read scalars only; nothing here evaluates YAML.
 */

export function stripYamlValue(value = "") {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function readYamlScalar(block, key) {
  const lines = block.split("\n");
  const keyPattern = new RegExp(`^${key}:\\s*(.*)$`);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(keyPattern);
    if (!match) continue;
    const value = match[1].trim();
    if (!/^[>|][+-]?$/.test(value)) return stripYamlValue(value);
    const collected = [];
    for (let lineIndex = index + 1; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      if (line && !/^\s/.test(line)) break;
      collected.push(line.replace(/^\s{1,4}/, ""));
    }
    const separator = value.startsWith(">") ? " " : "\n";
    return collected.join(separator).replace(/\s+/g, " ").trim();
  }
  return "";
}

export function cleanMarkdownText(value = "", limit = 4_000) {
  // Clamped input and bounded quantifiers keep untrusted Markdown from causing ReDoS.
  return String(value)
    .slice(0, limit)
    .replace(/!\[[^\]\n]{0,200}\]\([^)\n]{1,300}\)/g, "")
    .replace(/\[([^\]\n]{1,200})\]\([^)\n]{1,300}\)/g, "$1")
    .replace(/[`*_~>#|]/g, "")
    .replace(/^[ \t]*[-+\d.)]+[ \t]*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function firstScalar(block, keys, predicate = Boolean) {
  for (const key of keys) {
    const value = readYamlScalar(block, key);
    if (predicate(value)) return value;
  }
  return "";
}

const DISPLAY_NAME_KEYS = [
  "display_name",
  "displayName",
  "name_zh",
  "name-zh",
  "title",
  "display_name_zh",
  "displayNameZh",
  "title_zh",
  "name_cn",
  "中文名称",
];
const LOCALIZED_DESCRIPTION_KEYS = [
  "description_zh",
  "description-zh",
  "description_cn",
  "summary_zh",
  "intro_zh",
  "中文描述",
  "中文介绍",
];

/**
 * Display name: explicit frontmatter display keys, else the first H1 that precedes any
 * deeper heading (≤ 40 chars, outside code fences), else the technical name.
 * `description` stays the frontmatter description; a Chinese first paragraph is only
 * offered separately as `descriptionZh` when that description is not Chinese.
 */
export function parseFrontmatter(source, fallbackName) {
  const normalized = source.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  const block = match?.[1] ?? "";
  const body = match ? normalized.slice(match[0].length).trim() : normalized.trim();
  const tagsMatch = block.match(/^tags:[ \t]*\[([^\]\n]{0,500})\]/m);
  const name =
    outboundText(readYamlScalar(block, "name"), 128) ||
    outboundText(fallbackName, 128) ||
    "unnamed-skill";
  const displayName =
    outboundText(firstScalar(block, DISPLAY_NAME_KEYS), 80) ||
    firstHeadingTitle(body) ||
    name;
  const rawDescription = outboundText(readYamlScalar(block, "description"), 2_000);
  const description =
    rawDescription ||
    outboundText(
      body
        .slice(0, 4_000)
        .replace(/^#+[ \t]+/gm, "")
        .replace(/\s+/g, " "),
      180,
    ) ||
    "暂无描述";
  const descriptionZh =
    outboundText(firstScalar(block, LOCALIZED_DESCRIPTION_KEYS, containsChinese), 2_000) ||
    (!containsChinese(rawDescription) ? chineseIntroduction(body) : "") ||
    null;
  const version = outboundText(
    readYamlScalar(block, "version") ||
      readNestedYamlScalar(block, "metadata", "version"),
    64,
  );
  const tags = tagsMatch
    ? tagsMatch[1]
        .split(",")
        .map((tag) => outboundText(stripYamlValue(tag), 48))
        .filter(Boolean)
        .slice(0, 6)
    : [];

  return { name, displayName, description, descriptionZh, version, tags, body };
}

export function localizedText(value, fallback = "") {
  if (typeof value === "string") return value.trim() || fallback;
  if (!value || typeof value !== "object") return fallback;
  return String(
    value.zh ||
      value["zh-CN"] ||
      value.zh_CN ||
      value.en ||
      Object.values(value).find((item) => typeof item === "string") ||
      fallback,
  ).trim();
}

export function frontmatterBlock(source) {
  return (
    source
      .replace(/\r\n/g, "\n")
      .match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1] || ""
  );
}

export function readNestedYamlScalar(block, parentKey, childKey) {
  const escapedParent = parentKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedChild = childKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parentMatch = block.match(
    new RegExp(
      `^${escapedParent}:\\s*\\n((?:[ \\t]+[^\\n]*(?:\\n|$))*)`,
      "m",
    ),
  );
  if (!parentMatch) return "";
  const childMatch = parentMatch[1].match(
    new RegExp(`^[ \\t]+${escapedChild}:\\s*(.+)$`, "m"),
  );
  return childMatch ? stripYamlValue(childMatch[1]) : "";
}

export function parseSimpleYamlSection(source, sectionName, allowedKeys) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const sectionIndex = lines.findIndex(
    (line) => line.trimEnd() === `${sectionName}:`,
  );
  if (sectionIndex < 0) return {};
  const result = {};
  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^[^\s#][^:]*:/u.test(line)) break;
    const match = line.match(/^\s{2}([a-zA-Z0-9_-]+):\s*(.*?)\s*$/u);
    if (!match || !allowedKeys.includes(match[1]) || !match[2]) continue;
    const rawValue = stripYamlValue(match[2]);
    if (/^(true|false)$/i.test(rawValue)) {
      result[match[1]] = rawValue.toLowerCase() === "true";
    } else if (/^-?\d+(?:\.\d+)?$/u.test(rawValue)) {
      result[match[1]] = Number(rawValue);
    } else {
      result[match[1]] = rawValue;
    }
  }
  return result;
}
