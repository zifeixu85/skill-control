import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { readTextPrefix } from "./fs-safe.mjs";

/**
 * Which skills mention which command names, from SKILL.md text. Bounded (files, bytes per
 * file, time) and cached by file size and mtime, so a repeat scan reads only changed files.
 * A mention is a command position inside code (`inline` or fenced blocks: the first word of
 * a line or of a `|`, `&&`, `;`, `$(` segment, after `$ `, `sudo`, `npx` …), so "go" in
 * "go to the page" or `digest` as a variable is not one. Distinctive names (with a `-`, `_`,
 * `.` or digit, such as lark-cli) also count anywhere in prose as a word. Only the matched
 * names are kept; no skill text is stored or returned.
 */

const FILE_LIMIT = 2_000;
const BYTES_PER_FILE = 64 * 1024;
const CACHE_VERSION = 2;
const NAME = /^[\w.+-]{1,64}$/u;
const PREFIX_WORDS = new Set(["sudo", "exec", "env", "npx", "bunx", "pnpx", "uvx", "command", "time", "nohup", "xargs", "watch", "then", "do", "!"]);

/** Names that count in prose as well as in code. */
const proseCounts = (name) => /[-_.\d]/u.test(name) && name.length >= 3;

const unquote = (token) => token.replace(/^["'(]+|["')]+$/gu, "");

/** Words in command position in code text. */
function commandWords(code) {
  const found = [];
  for (const line of code.split(/\r?\n/u).slice(0, 5_000)) {
    for (const segment of line.replace(/^`+|`+$/gu, "").split(/\|\||&&|[|;]|\$\(/u)) {
      let words = segment.trim().replace(/^(?:[$>%]\s+)/u, "").split(/\s+/u).map(unquote).filter(Boolean);
      while (words.length && (/^\w+=/u.test(words[0]) || PREFIX_WORDS.has(words[0]))) {
        found.push(words[0]);
        words = words.slice(1);
      }
      if (words[0]) found.push(words[0].split("/").pop());
    }
  }
  return found;
}

function splitCode(value) {
  const code = [];
  const prose = value.replace(/```[^\n]*\n([\s\S]*?)(?:```|$)|`([^`\n]{1,400})`/gu, (match, block, inline) => {
    code.push(block ?? inline ?? "");
    return " ";
  });
  return { code: code.join("\n"), prose };
}

const tokensOf = (value) =>
  value
    .split(/[^\w.+-]+/u)
    .map((token) => token.replace(/^[.+-]+|[.+-]+$/gu, ""))
    .filter((token) => token && token.length <= 64);

/** The names from `nameSet` that `value` mentions as a word. */
export function mentionsIn(value, nameSet) {
  const { code, prose } = splitCode(String(value || ""));
  const found = new Set();
  for (const token of commandWords(code)) if (nameSet.has(token) && token.length > 1) found.add(token);
  for (const token of tokensOf(`${prose}\n${code}`)) if (nameSet.has(token) && proseCounts(token)) found.add(token);
  return [...found].sort();
}

async function loadCache(cacheFile, namesHash) {
  if (!cacheFile) return {};
  try {
    const value = JSON.parse(await readFile(cacheFile, "utf8"));
    return value?.version === CACHE_VERSION && value.namesHash === namesHash && value.files && typeof value.files === "object" ? value.files : {};
  } catch {
    return {};
  }
}

async function saveCache(cacheFile, namesHash, files) {
  await mkdir(path.dirname(cacheFile), { recursive: true });
  const temporary = `${cacheFile}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify({ version: CACHE_VERSION, namesHash, files })}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, cacheFile);
}

/**
 * `skillFiles`: [{ file, name }] (SKILL.md paths and skill names); `names`: command names.
 * Returns { byName: Map(name → [skill names]), scanned, truncated }.
 */
export async function findSkillMentions({ skillFiles = [], names = [], cacheFile = null, budgetMs = 2_500, now = () => Date.now() }) {
  const nameSet = new Set([...names].filter((name) => NAME.test(name)));
  const namesHash = createHash("sha1").update([...nameSet].sort().join("\n")).digest("hex");
  const cached = await loadCache(cacheFile, namesHash);
  const files = {};
  const byName = new Map();
  const started = now();
  let truncated = skillFiles.length > FILE_LIMIT;
  let changed = false;
  const seen = new Set();
  for (const { file, name } of skillFiles.slice(0, FILE_LIMIT)) {
    if (typeof file !== "string" || seen.has(file)) continue;
    seen.add(file);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) continue;
    let hits = null;
    const entry = cached[file];
    if (entry && entry.size === info.size && entry.mtimeMs === info.mtimeMs && Array.isArray(entry.hits)) hits = entry.hits.filter((hit) => nameSet.has(hit));
    else if (now() - started > budgetMs) {
      truncated = true;
      continue;
    } else {
      const read = await readTextPrefix(file, BYTES_PER_FILE);
      if (read.status !== "ok") continue;
      hits = mentionsIn(read.text, nameSet);
      changed = true;
    }
    files[file] = { size: info.size, mtimeMs: info.mtimeMs, hits };
    for (const hit of hits) {
      const list = byName.get(hit) || [];
      if (name && !list.includes(name)) list.push(name);
      byName.set(hit, list);
    }
  }
  if (cacheFile && (changed || Object.keys(files).length !== Object.keys(cached).length)) await saveCache(cacheFile, namesHash, files).catch(() => {});
  return { byName, scanned: seen.size, truncated };
}
