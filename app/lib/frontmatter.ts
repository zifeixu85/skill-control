import { dump, load } from "js-yaml";

export interface FrontmatterRow {
  key: string;
  value: string;
  /** Objects and lists are shown as YAML in a code block. */
  nested: boolean;
}

export interface SplitDocument {
  frontmatter: string | null;
  body: string;
}

const FRONTMATTER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
const PARSE_LIMIT = 64_000;
/** Per-value display cap; YAML aliases can expand a tiny file into megabytes. */
export const VALUE_LIMIT = 20_000;
export const TRUNCATED_NOTE = "（内容过长，已截断）";

function capped(text: string): string {
  return text.length > VALUE_LIMIT ? `${text.slice(0, VALUE_LIMIT)}\n${TRUNCATED_NOTE}` : text;
}

export function splitFrontmatter(text: string): SplitDocument {
  const source = String(text ?? "");
  const match = source.match(FRONTMATTER);
  if (!match) return { frontmatter: null, body: source };
  return { frontmatter: match[1], body: source.slice(match[0].length) };
}

function scalarText(value: unknown): string {
  if (value === null || value === undefined) return "（空）";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

/**
 * Every top-level key, in file order. Nested values are re-dumped as YAML.
 * Returns null when the block is not valid YAML (callers then show the raw text).
 */
export function frontmatterRows(frontmatter: string | null): FrontmatterRow[] | null {
  if (!frontmatter || frontmatter.length > PARSE_LIMIT) return frontmatter ? null : [];
  let parsed: unknown;
  try {
    parsed = load(frontmatter);
  } catch {
    return null;
  }
  if (parsed === null || parsed === undefined) return [];
  if (typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return Object.entries(parsed as Record<string, unknown>).map(([key, value]) => {
    const nested = typeof value === "object" && value !== null && !(value instanceof Date);
    return {
      key,
      nested,
      // noRefs: false keeps anchors/aliases as references instead of expanding them.
      value: capped(
        nested
          ? dump(value, { indent: 2, lineWidth: 100, noRefs: false, skipInvalid: true }).trimEnd()
          : scalarText(value),
      ),
    };
  });
}
