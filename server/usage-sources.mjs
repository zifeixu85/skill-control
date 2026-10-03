import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { hermesHomeFor } from "./hermes.mjs";
import { object, readBoundedJson } from "./fs-safe.mjs";
import { openClawAgents, resolveOpenClawInstall } from "./openclaw.mjs";

/**
 * Usage sources for the incremental index. Transcript sources are append-only JSONL files
 * read from a byte offset; each line is filtered by cheap substring checks before parsing
 * and only counts, token numbers, skill names, dates and a project folder name are kept.
 * Message text, tool arguments and outputs never leave the line processor.
 */

const FILE_LIMIT = 20_000;
const SKILL_NAME = /^[\w.@:-]{1,128}$/u;
const SKILL_PATH = /skills[\\/]{1,2}([\w.@-]{1,128})[\\/]{1,2}SKILL\.md/gu;

export const hashKey = (value) => createHash("sha1").update(value).digest("hex").slice(0, 20);

/** Local calendar day (YYYY-MM-DD) for a timestamp in ms, or null. */
export function dayKey(value) {
  const ms = typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const projectName = (cwd) => {
  if (typeof cwd !== "string" || !cwd) return null;
  const name = path.basename(cwd.replace(/[\\/]+$/u, ""));
  return /^[\p{L}\p{N}_.@ -]{1,80}$/u.test(name) ? name : null;
};
const count = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);
const skillName = (value) => (typeof value === "string" && SKILL_NAME.test(value.trim()) ? value.trim() : null);

/** Recursively lists *.jsonl files under `root` (bounded depth and count). */
async function jsonlFiles(root, maxDepth) {
  const files = [];
  async function walk(directory, depth) {
    if (files.length >= FILE_LIMIT) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < maxDepth && !entry.name.startsWith(".")) await walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
      if (files.length >= FILE_LIMIT) return;
    }
  }
  await walk(root, 0);
  return files;
}

async function withStats(files) {
  const result = [];
  for (const file of files) {
    try {
      const info = await stat(file.path);
      if (info.isFile()) result.push({ ...file, size: info.size, mtimeMs: info.mtimeMs });
    } catch {
      // Removed while listing.
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Line processors. `context` exposes: session(day, cwd), tokens(day, usage),
// skill(name, day), skillTokens(name, day, total), state (persisted per file).

function claudeLine(line, context) {
  if (!line.includes('"type":"assistant"')) return;
  const entry = JSON.parse(line);
  const message = object(entry.message);
  const day = dayKey(entry.timestamp);
  if (!day) return;
  context.session(day, entry.cwd);
  const messageId = typeof message.id === "string" ? message.id : entry.requestId;
  const usage = object(message.usage);
  if (Object.keys(usage).length && messageId && !context.seen(messageId)) {
    const tokens = {
      input: count(usage.input_tokens),
      output: count(usage.output_tokens),
      cacheRead: count(usage.cache_read_input_tokens),
      cacheWrite: count(usage.cache_creation_input_tokens),
    };
    tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    context.tokens(day, tokens);
    const attributed = skillName(entry.attributionSkill);
    if (attributed) context.skillTokens(attributed, day, tokens.total);
  }
  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (block?.type === "tool_use" && block.name === "Skill") {
      const name = skillName(object(block.input).skill);
      // Resumed sessions repeat earlier tool calls; each call id counts once.
      if (name && !(typeof block.id === "string" && context.seen(`tool:${block.id}`))) context.skill(name, day);
    }
  }
}

const CODEX_FIELDS = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "total_tokens"];

function codexLine(line, context) {
  const meta = line.includes('"type":"session_meta"');
  const tokenCount = line.includes('"type":"token_count"');
  const call = line.includes("SKILL.md") && (line.includes('"type":"function_call"') || line.includes('"type":"custom_tool_call"'));
  if (!meta && !tokenCount && !call) return;
  const entry = JSON.parse(line);
  const payload = object(entry.payload);
  const day = dayKey(entry.timestamp || payload.timestamp);
  if (!day) return;
  if (entry.type === "session_meta") {
    context.session(day, payload.cwd);
    return;
  }
  if (payload.type === "token_count") {
    const info = object(payload.info);
    const total = object(info.total_token_usage);
    if (!Object.keys(total).length) return;
    const previous = context.state.codexTotals ? object(context.state.codexTotals) : null;
    // A forked or resumed session starts from its parent's running total, and totals can
    // drop after compaction: then only this turn's own usage is new.
    const fresh = !previous || count(total.total_tokens) < count(previous.total_tokens);
    const last = object(info.last_token_usage);
    const delta = Object.fromEntries(
      CODEX_FIELDS.map((field) => [field, fresh ? count(last[field]) : Math.max(0, count(total[field]) - count(previous[field]))]),
    );
    context.state.codexTotals = Object.fromEntries(CODEX_FIELDS.map((field) => [field, count(total[field])]));
    if (!delta.total_tokens) return;
    context.tokens(day, {
      input: Math.max(0, delta.input_tokens - delta.cached_input_tokens),
      output: delta.output_tokens,
      cacheRead: delta.cached_input_tokens,
      cacheWrite: delta.cache_write_input_tokens,
      total: delta.total_tokens,
    });
    return;
  }
  if (payload.type === "function_call" || payload.type === "custom_tool_call") {
    // Only the call's own arguments are inspected — never its output.
    const argumentsText = typeof payload.arguments === "string" ? payload.arguments : typeof payload.input === "string" ? payload.input : "";
    const names = new Set([...argumentsText.slice(0, 200_000).matchAll(SKILL_PATH)].map((match) => match[1]));
    for (const name of names) context.skill(name, day, "inferred");
  }
}

function workBuddyLine(line, context) {
  const hasUsage = line.includes('"usage"');
  const hasSkill = line.includes('"Skill"');
  if (!hasUsage && !hasSkill && context.state.sessionCounted) return;
  const entry = JSON.parse(line);
  const day = dayKey(entry.timestamp);
  if (!day) return;
  context.session(day, entry.cwd);
  const usage = object(object(entry.message).usage);
  const messageId = object(entry.providerData).messageId || entry.id;
  if (hasUsage && Object.keys(usage).length && typeof messageId === "string" && !context.seen(messageId)) {
    const input = count(usage.input_tokens);
    const cacheRead = Math.min(input, count(usage.cache_read_input_tokens));
    const output = count(usage.output_tokens);
    context.tokens(day, { input: input - cacheRead, output, cacheRead, cacheWrite: 0, total: count(usage.total_tokens) || input + output });
  }
  if (entry.type === "function_call" && entry.name === "Skill" && typeof entry.arguments === "string") {
    let args = {};
    try {
      args = object(JSON.parse(entry.arguments));
    } catch {
      args = {};
    }
    const name = skillName(args.skill) || skillName(args.command);
    if (name) context.skill(name, day);
  }
}

function openClawLine(line, context) {
  if (!line.includes("SKILL.md")) return;
  if (!/"(?:toolCall|tool_call|tool_use|function_call)"/u.test(line) || /"(?:toolResult|tool_result|function_call_output)"/u.test(line)) return;
  const entry = JSON.parse(line);
  const day = dayKey(entry.timestamp) || context.fileDay;
  if (!day) return;
  for (const name of new Set([...line.slice(0, 200_000).matchAll(SKILL_PATH)].map((match) => match[1]))) {
    context.skill(name, day, "inferred");
  }
}

// ---------------------------------------------------------------------------
// Source discovery

/**
 * Every transcript file with its index key. Codex keys use the rollout file name so a
 * session moved into archived_sessions keeps its progress.
 */
export async function discoverTranscripts(homeDirectory) {
  const files = [];
  const claudeRoot = path.join(homeDirectory, ".claude", "projects");
  for (const file of await jsonlFiles(claudeRoot, 4)) {
    const relative = path.relative(claudeRoot, file);
    files.push({ path: file, agentId: "claude", key: `claude|${hashKey(relative)}`, sessionFile: relative.split(path.sep).length === 2 });
  }
  for (const root of [path.join(homeDirectory, ".codex", "sessions"), path.join(homeDirectory, ".codex", "archived_sessions")]) {
    for (const file of await jsonlFiles(root, 4)) {
      files.push({ path: file, agentId: "codex", key: `codex|${hashKey(path.basename(file))}`, sessionFile: true });
    }
  }
  const workBuddyRoot = path.join(homeDirectory, ".workbuddy", "projects");
  for (const file of await jsonlFiles(workBuddyRoot, 4)) {
    const relative = path.relative(workBuddyRoot, file);
    files.push({ path: file, agentId: "workbuddy", key: `workbuddy|${hashKey(relative)}`, sessionFile: relative.split(path.sep).length === 2 });
  }
  for (const kind of ["openclaw", "qclaw"]) {
    const install = await resolveOpenClawInstall(kind, homeDirectory).catch(() => null);
    if (!install?.available) continue;
    for (const agent of openClawAgents(install)) {
      for (const file of await jsonlFiles(path.join(install.stateDir, "agents", agent.id, "sessions"), 0)) {
        files.push({ path: file, agentId: kind, key: `${kind}|${hashKey(path.relative(install.stateDir, file))}`, sessionFile: false });
      }
    }
  }
  const unique = new Map(files.map((file) => [file.key, file]));
  return withStats([...unique.values()]);
}

export const LINE_PROCESSORS = {
  claude: claudeLine,
  codex: codexLine,
  workbuddy: workBuddyLine,
  openclaw: openClawLine,
  qclaw: openClawLine,
};

// ---------------------------------------------------------------------------
// Snapshot sources: small databases and JSON files re-read on every run. Each session is
// stored as its own record, so aggregates survive when the product deletes old rows.

async function openDatabase(file) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return null;
  }
  try {
    await stat(file);
    // Read-only and query-only; never `immutable`, so a live WAL is still honoured.
    const database = new DatabaseSync(file, { readOnly: true });
    database.exec("PRAGMA query_only = 1");
    return database;
  } catch {
    return null;
  }
}

function columnsOf(database, table) {
  try {
    return new Set(database.prepare(`PRAGMA table_info("${table}")`).all().map((column) => column.name));
  } catch {
    return new Set();
  }
}

/** Hermes state.db sessions: tokens, cost, day and working folder (never titles or messages). */
async function hermesSessions(homeDirectory, warnings) {
  const database = await openDatabase(path.join(hermesHomeFor(homeDirectory), "state.db"));
  if (!database) return null;
  try {
    const columns = columnsOf(database, "sessions");
    if (!columns.has("id") || !columns.has("started_at")) return null;
    const pick = (name) => (columns.has(name) ? `"${name}"` : "NULL");
    const rows = database
      .prepare(
        `SELECT id, started_at, ${pick("input_tokens")} AS i, ${pick("output_tokens")} AS o, ${pick("cache_read_tokens")} AS cr,
         ${pick("cache_write_tokens")} AS cw, ${pick("actual_cost_usd")} AS ac, ${pick("estimated_cost_usd")} AS ec, ${pick("cwd")} AS cwd
         FROM sessions ORDER BY started_at DESC LIMIT 50000`,
      )
      .all();
    return rows.map((row) => {
      const tokens = { input: count(row.i), output: count(row.o), cacheRead: count(row.cr), cacheWrite: count(row.cw) };
      return {
        key: hashKey(`hermes:${row.id}`),
        day: dayKey(Number(row.started_at)),
        tokens: { ...tokens, total: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite },
        costUsd: Number.isFinite(Number(row.ac)) && Number(row.ac) > 0 ? Number(row.ac) : Number(row.ec) || 0,
        project: projectName(row.cwd),
      };
    });
  } catch {
    warnings.push("Hermes state.db 结构无法识别，已跳过。");
    return null;
  } finally {
    database.close();
  }
}

/** WorkBuddy credits per session from workbuddy.db (credit_json holds request id → credits). */
async function workBuddyCredits(homeDirectory, warnings) {
  const database = await openDatabase(path.join(homeDirectory, ".workbuddy", "workbuddy.db"));
  if (!database) return null;
  try {
    if (!columnsOf(database, "session_usage").has("credit_json")) return null;
    const hasSessions = columnsOf(database, "sessions").has("created_at");
    const rows = database
      .prepare(
        hasSessions
          ? "SELECT u.session_id AS id, u.credit_json AS credits, u.updated_at AS updated, s.created_at AS created FROM session_usage u LEFT JOIN sessions s ON s.id = u.session_id LIMIT 50000"
          : "SELECT session_id AS id, credit_json AS credits, updated_at AS updated, NULL AS created FROM session_usage LIMIT 50000",
      )
      .all();
    return rows.map((row) => {
      let credits = 0;
      try {
        credits = Object.values(object(JSON.parse(row.credits || "{}"))).reduce((sum, value) => sum + count(value), 0);
      } catch {
        credits = 0;
      }
      return { key: hashKey(`workbuddy:${row.id}`), day: dayKey(Number(row.created || row.updated)), credits };
    });
  } catch {
    warnings.push("WorkBuddy 数据库结构无法识别，已跳过额度统计。");
    return null;
  } finally {
    database.close();
  }
}

/** OpenClaw / QClaw sessions.json: per-session token totals and update time. */
async function openClawSessions(kind, homeDirectory) {
  const install = await resolveOpenClawInstall(kind, homeDirectory).catch(() => null);
  if (!install?.available) return null;
  const records = [];
  let found = false;
  for (const agent of openClawAgents(install)) {
    const store = await readBoundedJson(path.join(install.stateDir, "agents", agent.id, "sessions", "sessions.json"), 20_000_000);
    if (store.status !== "ok") continue;
    found = true;
    for (const [key, raw] of Object.entries(object(store.value)).slice(0, 20_000)) {
      const entry = object(raw);
      const input = count(entry.inputTokens);
      const output = count(entry.outputTokens);
      const cacheRead = count(entry.cacheRead ?? entry.cacheReadTokens);
      const cacheWrite = count(entry.cacheWrite ?? entry.cacheWriteTokens);
      records.push({
        key: hashKey(`${kind}:${agent.id}:${key}`),
        day: dayKey(Number(entry.updatedAt)),
        tokens: { input, output, cacheRead, cacheWrite, total: count(entry.totalTokens) || input + output + cacheRead + cacheWrite },
        costUsd: Number(entry.estimatedCostUsd) || 0,
        project: null,
      });
    }
  }
  return found ? records : null;
}

/** Skill usage the products record themselves (counts and dates only). */
async function reportedSkills(homeDirectory) {
  const hermes = await readBoundedJson(path.join(hermesHomeFor(homeDirectory), "skills", ".usage.json"), 4_000_000);
  const workBuddy = await readBoundedJson(path.join(homeDirectory, ".workbuddy", "usage-log.json"), 4_000_000);
  return {
    hermes:
      hermes.status === "ok"
        ? Object.entries(object(hermes.value))
            .filter(([name]) => skillName(name))
            .slice(0, 5_000)
            .map(([name, entry]) => ({ name, count: count(object(entry).use_count), lastUsedAt: object(entry).last_used_at || null }))
        : null,
    workbuddy:
      workBuddy.status === "ok"
        ? Object.entries(object(object(workBuddy.value).skills))
            .filter(([name]) => skillName(name))
            .slice(0, 5_000)
            .map(([name, entry]) => ({
              name,
              days: (Array.isArray(object(entry).recentDates) ? object(entry).recentDates : []).map((value) => dayKey(value)).filter(Boolean),
              lastUsedAt: object(entry).lastUsedDate || null,
            }))
        : null,
  };
}

export async function readSnapshots(homeDirectory) {
  const warnings = [];
  const [hermes, workbuddyCredits, openclaw, qclaw, reported] = await Promise.all([
    hermesSessions(homeDirectory, warnings),
    workBuddyCredits(homeDirectory, warnings),
    openClawSessions("openclaw", homeDirectory),
    openClawSessions("qclaw", homeDirectory),
    reportedSkills(homeDirectory),
  ]);
  return { sessions: { hermes, openclaw, qclaw }, workbuddyCredits, reported, warnings };
}
