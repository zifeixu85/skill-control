import path from "node:path";
import { readBoundedText, text } from "./fs-safe.mjs";

/**
 * Hermes toolset definitions read statically from `hermes-agent/toolsets.py` — the
 * Python file is never imported or executed. Only the `TOOLSETS = { … }` literal and the
 * module-level `_NAME = [ … ]` string lists it references are understood.
 */

const SOURCE_LIMIT = 1_000_000;
const STRING = /"((?:[^"\\\n]|\\.){0,2000})"|'((?:[^'\\\n]|\\.){0,2000})'/gu;
const NAME = /^[\w.-]{1,64}$/u;

const unescape = (value) => value.replace(/\\(["'\\n])/gu, (match, character) => (character === "n" ? " " : character));

function stringsIn(source) {
  return [...source.matchAll(STRING)].map((match) => unescape(match[1] ?? match[2] ?? ""));
}

/** Module-level `_NAME = [ "a", "b", … ]` lists (possibly concatenated with `+`). */
function listConstants(source) {
  const constants = new Map();
  for (const match of source.matchAll(/^(_?[A-Z][A-Z0-9_]{0,63})\s*=\s*\[([\s\S]{0,40000}?)^\]/gmu)) {
    constants.set(match[1], stringsIn(match[2].replace(/#[^\n]*/gu, "")).filter((item) => NAME.test(item)));
  }
  return constants;
}

/** The value text after `"key":` up to the next top-level key of the same entry. */
function fieldText(block, key) {
  const start = block.search(new RegExp(`["']${key}["']\\s*:`, "u"));
  if (start < 0) return "";
  const rest = block.slice(start).replace(new RegExp(`^["']${key}["']\\s*:`, "u"), "");
  const next = rest.search(/\n\s{8}["'](?:description|tools|includes)["']\s*:/u);
  return next < 0 ? rest : rest.slice(0, next);
}

function listField(block, key, constants) {
  const value = fieldText(block, key).replace(/#[^\n]*/gu, "");
  const items = new Set(stringsIn(value).filter((item) => NAME.test(item)));
  for (const identifier of value.match(/\b_?[A-Z][A-Z0-9_]{0,63}\b/gu) || []) {
    for (const item of constants.get(identifier) || []) items.add(item);
  }
  return [...items];
}

/** Parses the TOOLSETS literal into { name: { description, tools, includes } }. */
export function parseToolsetsSource(source) {
  const start = source.search(/^TOOLSETS\s*=\s*\{/mu);
  if (start < 0) return new Map();
  const constants = listConstants(source);
  const body = source.slice(start);
  const end = body.search(/^\}/mu);
  const literal = end < 0 ? body : body.slice(0, end);
  const heads = [...literal.matchAll(/^\s{4}["']([\w.-]{1,64})["']\s*:\s*\{/gmu)];
  const toolsets = new Map();
  heads.slice(0, 500).forEach((head, index) => {
    const block = literal.slice(head.index, heads[index + 1]?.index ?? literal.length);
    toolsets.set(head[1], {
      description: text(stringsIn(fieldText(block, "description").replace(/#[^\n]*/gu, "")).join(""), 300),
      tools: listField(block, "tools", constants),
      includes: listField(block, "includes", constants),
    });
  });
  return toolsets;
}

export async function readHermesToolsets(hermesHome) {
  const read = await readBoundedText(path.join(hermesHome, "hermes-agent", "toolsets.py"), SOURCE_LIMIT);
  return read.status === "ok" ? parseToolsetsSource(read.text) : null;
}

/** Enabled toolsets plus everything they include, and the union of their tools. */
export function expandToolsets(enabled, definitions) {
  const active = new Set();
  const visit = (name, depth) => {
    if (active.has(name) || depth > 10) return;
    active.add(name);
    for (const child of definitions.get(name)?.includes || []) visit(child, depth + 1);
  };
  for (const name of enabled) visit(name, 0);
  const tools = new Set([...active].flatMap((name) => definitions.get(name)?.tools || []));
  return { active, tools };
}
