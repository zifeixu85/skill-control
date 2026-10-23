import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { hermesHomeFor } from "./hermes.mjs";
import { object, readBoundedJson } from "./fs-safe.mjs";
import { raccoonAppDataDir } from "./office-raccoon.mjs";
import { openClawAgents, resolveOpenClawInstall } from "./openclaw.mjs";
import { bucketFor, isIgnoredModel, modelKey } from "./pricing.mjs";

/**
 * Usage sources for the incremental index. Transcript sources are append-only JSONL files
 * read from a byte offset; each line is filtered by cheap substring checks before parsing
 * and only counts, token numbers, skill names, dates and a project folder name are kept.
 * Message text, tool arguments and outputs never leave the line processor. Token usage is
 * also kept per model and price bucket (see pricing.mjs) so costs can be priced later.
 */

const FILE_LIMIT = 20_000;
const SKILL_NAME = /^[\w.@:-]{1,128}$/u;
const SKILL_PATH = /skills[\\/]{1,2}([\w.@-]{1,128})[\\/]{1,2}SKILL\.md/gu;

export const hashKey = (value) => createHash("sha1").update(value).digest("hex").slice(0, 20);

/** A timestamp (ISO text, seconds or ms) in ms, or null. */
export function timeMs(value) {
  const ms = typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** Local calendar day (YYYY-MM-DD) for a timestamp in ms, or null. */
export function dayKey(value) {
  const ms = timeMs(value);
  if (!ms) return null;
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
// modelUsage(day, model, bucket, row, skill?), skill(name, day), skillTokens(name, day, total)
// and state (persisted per file). A row is [input, output, cacheRead, cacheWrite (5 min),
// cacheWrite1h, requests] with input excluding every cached token.

/** Records one request's tokens under its model and price bucket. */
function recordModel(context, { agentId, day, model, promptTokens, timestamp, fast = false, row, skill = null }) {
  if (isIgnoredModel(model) || row.slice(0, 5).every((value) => !value)) return;
  context.modelUsage(day, model, bucketFor({ model, promptTokens, timestamp, fast, agentId }), row, skill);
}

const CODEX_PENDING_LIMIT = 2_000;

/**
 * Resumed and compacted Codex sessions can report usage before their first turn_context.
 * Those requests are recorded as "unknown" at once (so totals always add up) and moved to
 * the session's model when its first turn_context arrives.
 */
function codexModelKnown(context, model) {
  const pending = Array.isArray(context.state.codexPending) ? context.state.codexPending : [];
  context.state.codexModel = model;
  delete context.state.codexPending;
  if (model === "unknown") return;
  for (const request of pending) {
    context.modelUsage(request.day, "unknown", request.bucket, request.row.map((value) => -value));
    recordModel(context, { agentId: "codex", day: request.day, model, promptTokens: request.prompt, timestamp: request.at, row: request.row });
  }
}

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
    // input_tokens is the uncached part; cache writes split into 5-minute and 1-hour TTLs.
    const split = object(usage.cache_creation);
    const write5m = count(split.ephemeral_5m_input_tokens);
    const write1h = count(split.ephemeral_1h_input_tokens);
    const cacheWrite = Math.max(count(usage.cache_creation_input_tokens), write5m + write1h);
    const tokens = {
      input: count(usage.input_tokens),
      output: count(usage.output_tokens),
      cacheRead: count(usage.cache_read_input_tokens),
      cacheWrite,
    };
    tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    context.tokens(day, tokens);
    const attributed = skillName(entry.attributionSkill);
    if (attributed) context.skillTokens(attributed, day, tokens.total);
    const longWrites = Math.min(cacheWrite, write1h);
    recordModel(context, {
      agentId: "claude",
      day,
      model: modelKey(message.model),
      promptTokens: tokens.input + tokens.cacheRead + cacheWrite,
      timestamp: entry.timestamp,
      fast: usage.speed === "fast",
      row: [tokens.input, tokens.output, tokens.cacheRead, cacheWrite - longWrites, longWrites, 1],
      skill: attributed,
    });
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
  const turn = line.includes('"type":"turn_context"');
  const call = line.includes("SKILL.md") && (line.includes('"type":"function_call"') || line.includes('"type":"custom_tool_call"'));
  if (!meta && !tokenCount && !turn && !call) return;
  const entry = JSON.parse(line);
  const payload = object(entry.payload);
  if (entry.type === "turn_context") {
    // The model of a turn applies to the token_count events that follow it.
    if (payload.model !== undefined && context.state.codexModel !== modelKey(payload.model)) codexModelKnown(context, modelKey(payload.model));
    return;
  }
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
    // input_tokens includes cached reads and cache writes; output includes reasoning.
    const cacheRead = Math.min(delta.input_tokens, delta.cached_input_tokens);
    const cacheWrite = Math.min(delta.input_tokens - cacheRead, delta.cache_write_input_tokens);
    const input = delta.input_tokens - cacheRead - cacheWrite;
    context.tokens(day, { input, output: delta.output_tokens, cacheRead, cacheWrite, total: delta.total_tokens });
    const request = {
      agentId: "codex",
      day,
      model: context.state.codexModel || "unknown",
      promptTokens: count(last.input_tokens) || delta.input_tokens,
      timestamp: entry.timestamp || payload.timestamp,
      row: [input, delta.output_tokens, cacheRead, cacheWrite, 0, 1],
    };
    recordModel(context, request);
    if (!context.state.codexModel && request.row.slice(0, 5).some(Boolean)) {
      const pending = (context.state.codexPending ||= []);
      if (pending.length < CODEX_PENDING_LIMIT) {
        pending.push({ day, bucket: bucketFor({ model: "unknown", promptTokens: request.promptTokens }), prompt: request.promptTokens, at: request.timestamp, row: request.row });
      }
    }
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
    recordModel(context, {
      agentId: "workbuddy",
      day,
      model: modelKey(object(entry.providerData).model),
      promptTokens: input,
      timestamp: entry.timestamp,
      row: [input - cacheRead, output, cacheRead, 0, 0, 1],
    });
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
/**
 * A transcript nested under a session (`<dir>/<session>/subagents/agent-x.jsonl`) belongs to
 * the session file `<dir>/<session>.jsonl`: its key, so subagent activity makes the session
 * active.
 */
function nestedFile(agentId, relative) {
  const parts = relative.split(path.sep);
  if (parts.length === 2) return { sessionFile: true };
  return { sessionFile: false, ...(parts.length > 2 ? { parentKey: `${agentId}|${hashKey(path.join(parts[0], `${parts[1]}.jsonl`))}` } : {}) };
}

export async function discoverTranscripts(homeDirectory) {
  const files = [];
  const claudeRoot = path.join(homeDirectory, ".claude", "projects");
  for (const file of await jsonlFiles(claudeRoot, 4)) {
    const relative = path.relative(claudeRoot, file);
    files.push({ path: file, agentId: "claude", key: `claude|${hashKey(relative)}`, ...nestedFile("claude", relative) });
  }
  for (const root of [path.join(homeDirectory, ".codex", "sessions"), path.join(homeDirectory, ".codex", "archived_sessions")]) {
    for (const file of await jsonlFiles(root, 4)) {
      files.push({ path: file, agentId: "codex", key: `codex|${hashKey(path.basename(file))}`, sessionFile: true });
    }
  }
  const workBuddyRoot = path.join(homeDirectory, ".workbuddy", "projects");
  for (const file of await jsonlFiles(workBuddyRoot, 4)) {
    const relative = path.relative(workBuddyRoot, file);
    files.push({ path: file, agentId: "workbuddy", key: `workbuddy|${hashKey(relative)}`, ...nestedFile("workbuddy", relative) });
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

/**
 * Hermes state.db sessions: model, tokens, the product's own cost, day and working folder
 * (never titles or messages). input_tokens excludes cache reads and writes, and
 * reasoning_tokens is a subset of output_tokens (Hermes shows it as "Reasoning (subset)").
 */
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
         ${pick("cache_write_tokens")} AS cw, ${pick("actual_cost_usd")} AS ac, ${pick("estimated_cost_usd")} AS ec, ${pick("cwd")} AS cwd,
         ${pick("model")} AS model, ${pick("api_call_count")} AS calls, ${pick("ended_at")} AS ended
         FROM sessions ORDER BY started_at DESC LIMIT 50000`,
      )
      .all();
    return rows.map((row) => {
      const tokens = { input: count(row.i), output: count(row.o), cacheRead: count(row.cr), cacheWrite: count(row.cw) };
      return {
        key: hashKey(`hermes:${row.id}`),
        day: dayKey(Number(row.started_at)),
        endDay: row.ended === null || row.ended === undefined ? null : dayKey(Number(row.ended)),
        at: timeMs(Number(row.started_at)),
        model: row.model === null || row.model === undefined ? null : modelKey(row.model),
        requests: count(row.calls),
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
      const model = typeof entry.model === "string" ? (typeof entry.modelProvider === "string" ? `${entry.modelProvider}/${entry.model}` : entry.model) : null;
      records.push({
        key: hashKey(`${kind}:${agent.id}:${key}`),
        day: dayKey(Number(entry.updatedAt)),
        at: timeMs(Number(entry.updatedAt)),
        model: model === null ? null : modelKey(model),
        requests: 0,
        tokens: { input, output, cacheRead, cacheWrite, total: count(entry.totalTokens) || input + output + cacheRead + cacheWrite },
        costUsd: Number(entry.estimatedCostUsd) || 0,
        project: null,
      });
    }
  }
  return found ? records : null;
}

const RACCOON_PAYLOAD_LIMIT = 2_000_000;
const RACCOON_MESSAGE_LIMIT = 200_000;

/**
 * 办公小浣熊 local-chat.sqlite3: per session its workspace folder and days; per assistant
 * turn `usage_metadata.token_usage` (prompt / completion tokens, calls) and the skills it
 * invoked. Only those numbers and skill codes are read from each payload; no model is
 * recorded, so its tokens stay unpriced.
 */
async function raccoonSessions(homeDirectory, warnings) {
  const database = await openDatabase(path.join(raccoonAppDataDir(homeDirectory), "local-chat.sqlite3"));
  if (!database) return null;
  try {
    const sessionColumns = columnsOf(database, "sessions");
    const messageColumns = columnsOf(database, "messages");
    if (!sessionColumns.has("id") || !messageColumns.has("payload_json") || !messageColumns.has("session_id")) return null;
    const pick = (columns, name) => (columns.has(name) ? `"${name}"` : "NULL");
    const sessions = new Map();
    for (const row of database
      .prepare(`SELECT id, ${pick(sessionColumns, "created_at_ms")} AS created, ${pick(sessionColumns, "last_chatted_at_ms")} AS chatted, ${pick(sessionColumns, "updated_at_ms")} AS updated, ${pick(sessionColumns, "workspace_dir")} AS cwd FROM sessions LIMIT 50000`)
      .all()) {
      sessions.set(String(row.id), { row, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, requests: 0 });
    }
    const skills = new Map();
    const statement = database.prepare(
      `SELECT session_id AS session, ${pick(messageColumns, "created_at_ms")} AS created, payload_json AS payload FROM messages WHERE payload_json LIKE '%usage_metadata%' LIMIT ${RACCOON_MESSAGE_LIMIT}`,
    );
    for (const message of statement.iterate()) {
      if (typeof message.payload !== "string" || message.payload.length > RACCOON_PAYLOAD_LIMIT) continue;
      let usage;
      try {
        usage = object(object(JSON.parse(message.payload)).usage_metadata);
      } catch {
        continue;
      }
      const session = sessions.get(String(message.session));
      const tokens = object(usage.token_usage);
      if (session) {
        const input = count(tokens.promptTokens);
        const output = count(tokens.completionTokens);
        session.tokens.input += input;
        session.tokens.output += output;
        session.tokens.total += count(tokens.totalTokens) || input + output;
        session.requests += count(tokens.calls);
      }
      const day = dayKey(Number(message.created));
      if (!day) continue;
      const codes = new Set([
        ...(Array.isArray(usage.used_skill_codes) ? usage.used_skill_codes : []),
        ...(Array.isArray(usage.skill_invocations) ? usage.skill_invocations.map((item) => object(item).skill_code) : []),
      ].map(skillName).filter(Boolean));
      for (const code of codes) {
        const entry = skills.get(code) || { days: {}, lastUsedAt: null };
        entry.days[day] = (entry.days[day] || 0) + 1;
        if (!entry.lastUsedAt || day > entry.lastUsedAt) entry.lastUsedAt = day;
        skills.set(code, entry);
      }
    }
    const records = [...sessions.entries()].map(([id, session]) => {
      const startDay = dayKey(Number(session.row.created));
      const lastDay = dayKey(Number(session.row.chatted || session.row.updated));
      return {
        key: hashKey(`office-raccoon:${id}`),
        day: startDay,
        endDay: lastDay,
        at: timeMs(Number(session.row.created)),
        model: null,
        requests: session.requests,
        tokens: session.tokens,
        costUsd: 0,
        project: projectName(session.row.cwd),
      };
    });
    return { records, skills: [...skills.entries()].slice(0, 5_000).map(([name, entry]) => ({ name, ...entry })) };
  } catch {
    warnings.push("办公小浣熊的对话数据库结构无法识别，已跳过用量统计。");
    return null;
  } finally {
    database.close();
  }
}

const CODEX_THREAD_LIMIT = 50_000;
const CODEX_STATE_FILE = /^state_(\d{1,4})\.sqlite$/u;

/** The newest ~/.codex/state_<n>.sqlite (Codex bumps the number when it migrates the schema). */
async function codexStateFile(homeDirectory) {
  const names = await readdir(path.join(homeDirectory, ".codex")).catch(() => []);
  const newest = names
    .map((name) => ({ name, version: Number(name.match(CODEX_STATE_FILE)?.[1]) }))
    .filter((item) => Number.isFinite(item.version))
    .sort((left, right) => right.version - left.version)[0];
  return newest ? path.join(homeDirectory, ".codex", newest.name) : null;
}

/** A thread spawned by another one (a subagent): its tokens_used starts from the parent's context. */
function spawnedThread(source) {
  if (typeof source !== "string" || !source.startsWith("{")) return false;
  try {
    return Boolean(object(object(JSON.parse(source)).subagent).thread_spawn);
  } catch {
    return false;
  }
}

/**
 * Codex threads from state_<n>.sqlite: Codex now keeps sessions in this database and deletes
 * old rollout files. Only these columns are read: id, rollout_path (its file name is the
 * index key of the transcript), created / updated times, model, cwd (folder name only),
 * tokens_used (one total per thread) and source (only whether it is a spawned subagent);
 * plus the child ids of thread_spawn_edges. Titles, first messages, previews and
 * thread_history items are never read.
 */
async function codexThreads(homeDirectory, warnings) {
  const file = await codexStateFile(homeDirectory);
  const database = file ? await openDatabase(file) : null;
  if (!database) return null;
  try {
    const columns = columnsOf(database, "threads");
    if (!["id", "rollout_path", "created_at", "tokens_used"].every((name) => columns.has(name))) return null;
    const pick = (name) => (columns.has(name) ? `"${name}"` : "NULL");
    const children = new Set();
    if (columnsOf(database, "thread_spawn_edges").has("child_thread_id")) {
      for (const row of database.prepare(`SELECT child_thread_id AS id FROM thread_spawn_edges LIMIT ${CODEX_THREAD_LIMIT}`).all()) children.add(String(row.id));
    }
    const rows = database
      .prepare(
        `SELECT id, rollout_path AS rollout, created_at AS created, ${pick("created_at_ms")} AS createdMs, ${pick("updated_at")} AS updated,
         ${pick("updated_at_ms")} AS updatedMs, ${pick("model")} AS model, ${pick("cwd")} AS cwd, tokens_used AS tokens, ${pick("source")} AS source
         FROM threads ORDER BY created_at DESC LIMIT ${CODEX_THREAD_LIMIT}`,
      )
      .all();
    return rows.map((row) => {
      const created = timeMs(Number(row.createdMs)) || timeMs(Number(row.created));
      const updated = timeMs(Number(row.updatedMs)) || timeMs(Number(row.updated));
      return {
        key: hashKey(`codex-thread:${row.id}`),
        rolloutKey: typeof row.rollout === "string" && row.rollout ? `codex|${hashKey(path.basename(row.rollout))}` : null,
        day: dayKey(created),
        endDay: updated ? dayKey(updated) : null,
        at: created,
        model: row.model === null || row.model === undefined ? null : modelKey(row.model),
        total: count(row.tokens),
        spawned: children.has(String(row.id)) || spawnedThread(row.source),
        project: projectName(row.cwd),
      };
    });
  } catch {
    warnings.push("Codex 的 state 数据库结构无法识别，已跳过数据库里的会话。");
    return null;
  } finally {
    database.close();
  }
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
  const [hermes, workbuddyCredits, openclaw, qclaw, reported, raccoon, codex] = await Promise.all([
    hermesSessions(homeDirectory, warnings),
    workBuddyCredits(homeDirectory, warnings),
    openClawSessions("openclaw", homeDirectory),
    openClawSessions("qclaw", homeDirectory),
    reportedSkills(homeDirectory),
    raccoonSessions(homeDirectory, warnings),
    codexThreads(homeDirectory, warnings),
  ]);
  return {
    sessions: { hermes, openclaw, qclaw, "office-raccoon": raccoon?.records || null },
    workbuddyCredits,
    codexThreads: codex,
    reported: { ...reported, "office-raccoon": raccoon?.skills || null },
    warnings,
  };
}
