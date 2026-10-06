import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { bucketFor, emptyRow } from "./pricing.mjs";
import { dayKey, discoverTranscripts, LINE_PROCESSORS, readSnapshots } from "./usage-sources.mjs";

/**
 * Incremental usage index persisted at ~/.agent-skill-manager/usage-index.json. It holds
 * counts and aggregates only: per transcript file its byte offset and per-day token,
 * session and skill counts; per database session its day, tokens and cost. Message text is
 * never stored. Each run has a time budget and resumes where the last one stopped.
 *
 * Version 2 adds tokens per model: `m` (model → day → bucket → row) and `km` (skill → model
 * → day → bucket → row) per file, and `m` / `b` / `rc` per database record, where a row is
 * [input, output, cacheRead, cacheWrite5m, cacheWrite1h, requests] and the bucket is the
 * prompt-size tier plus :off / :fast (pricing.mjs). Costs are priced at query time.
 */

export const USAGE_INDEX_VERSION = 2;
export const USAGE_INDEX_FILE = "usage-index.json";
const CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const HEAD_BYTES = 64;
const RETENTION_DAYS = 400;
const SEEN_LIMIT = 400_000;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

export const emptyIndex = () => ({
  version: USAGE_INDEX_VERSION,
  createdAt: new Date().toISOString(),
  updatedAt: null,
  complete: false,
  totals: { files: 0, bytes: 0, indexedFiles: 0, indexedBytes: 0 },
  files: {},
  records: {},
  credits: {},
  reported: { hermes: {}, workbuddy: {} },
  seen: {},
});

export async function loadUsageIndex(indexPath) {
  try {
    const value = JSON.parse(await readFile(indexPath, "utf8"));
    return value?.version === USAGE_INDEX_VERSION && value.files && typeof value.files === "object" ? value : emptyIndex();
  } catch {
    return emptyIndex();
  }
}

async function saveUsageIndex(indexPath, index) {
  await mkdir(path.dirname(indexPath), { recursive: true });
  const temporary = `${indexPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, JSON.stringify(index), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, indexPath);
}

const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "total"];

/** Per-day row: [sessions, input, output, cacheRead, cacheWrite, total]. */
function addDay(days, day, sessions, tokens) {
  const row = days[day] || [0, 0, 0, 0, 0, 0];
  row[0] += sessions;
  TOKEN_FIELDS.forEach((field, index) => {
    row[index + 1] += tokens?.[field] || 0;
  });
  days[day] = row;
}

function addNested(target, name, day, amount) {
  const byDay = target[name] || {};
  byDay[day] = (byDay[day] || 0) + amount;
  target[name] = byDay;
}

async function headDigest(handle) {
  const buffer = Buffer.alloc(HEAD_BYTES);
  const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
  return createHash("sha1").update(buffer.subarray(0, bytesRead)).digest("hex").slice(0, 16);
}

function freshEntry(file) {
  return { a: file.agentId, size: 0, mtimeMs: 0, offset: 0, tail: 0, head: null, gone: false, st: {}, d: {}, k: {}, kt: {}, ki: {}, m: {}, km: {}, p: null };
}

/** Adds a token row under model → day → bucket (a negative row moves usage away; empty rows are dropped). */
function addModelRow(target, model, day, bucket, row) {
  const byDay = (target[model] ||= {});
  const byBucket = (byDay[day] ||= {});
  const sum = byBucket[bucket] || emptyRow();
  row.forEach((value, index) => {
    sum[index] = Math.max(0, sum[index] + (value || 0));
  });
  byBucket[bucket] = sum;
  if (sum.every((value) => value === 0)) delete byBucket[bucket];
  if (!Object.keys(byBucket).length) delete byDay[day];
  if (!Object.keys(byDay).length) delete target[model];
}

/** A short digest of a message id: enough to recognise repeats, nothing else. */
const idDigest = (value) => createHash("sha1").update(String(value)).digest("hex").slice(0, 12);

function lineContext(entry, file, seenIds) {
  return {
    state: entry.st,
    fileDay: dayKey(file.mtimeMs),
    // Resumed and forked sessions copy earlier messages into a new file; count each once.
    seen(id) {
      const digest = idDigest(id);
      if (seenIds.has(digest)) return true;
      seenIds.add(digest);
      return false;
    },
    session(day, cwd) {
      if (entry.st.sessionCounted) return;
      entry.st.sessionCounted = true;
      if (!entry.p && typeof cwd === "string") {
        const name = path.basename(cwd.replace(/[\\/]+$/u, ""));
        if (/^[\p{L}\p{N}_.@ -]{1,80}$/u.test(name)) entry.p = name;
      }
      if (file.sessionFile) addDay(entry.d, day, 1, null);
    },
    tokens(day, tokens) {
      addDay(entry.d, day, 0, tokens);
    },
    skill(name, day, confidence = "exact") {
      addNested(confidence === "inferred" ? entry.ki : entry.k, name, day, 1);
    },
    skillTokens(name, day, total) {
      addNested(entry.kt, name, day, total);
    },
    modelUsage(day, model, bucket, row, skill = null) {
      addModelRow((entry.m ||= {}), model, day, bucket, row);
      if (skill) addModelRow(((entry.km ||= {})[skill] ||= {}), model, day, bucket, row);
    },
  };
}

/**
 * Processes appended bytes of one transcript until done or the deadline passes.
 * Returns true when the file is fully indexed.
 */
async function indexFile(file, entry, deadline, seenIds) {
  let handle;
  try {
    handle = await open(file.path, READ_FLAGS);
  } catch {
    return false;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return false;
    const head = await headDigest(handle);
    if (entry.head && entry.head !== head) Object.assign(entry, freshEntry(file));
    if (info.size < entry.offset) Object.assign(entry, freshEntry(file));
    entry.head = head;
    entry.size = info.size;
    entry.mtimeMs = info.mtimeMs;
    entry.gone = false;
    const processLine = LINE_PROCESSORS[file.agentId];
    const context = lineContext(entry, file, seenIds);
    let carry = Buffer.alloc(0);
    let skipping = false;
    while (entry.offset + carry.length < info.size) {
      const position = entry.offset + carry.length;
      const length = Math.min(CHUNK_BYTES, info.size - position);
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (!bytesRead) break;
      const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      const lastNewline = data.lastIndexOf(0x0a);
      if (lastNewline < 0) {
        // One very long line: keep reading, or give up on it past the cap.
        if (data.length > MAX_LINE_BYTES) {
          skipping = true;
          entry.offset += data.length;
          carry = Buffer.alloc(0);
        } else {
          carry = data;
        }
        continue;
      }
      const lines = data.toString("utf8", 0, lastNewline).split("\n");
      if (skipping) {
        lines.shift();
        skipping = false;
      }
      for (const line of lines) {
        if (!line) continue;
        try {
          processLine(line, context);
        } catch {
          // A malformed line is skipped; nothing from it is kept.
        }
      }
      entry.offset += lastNewline + 1;
      carry = data.subarray(lastNewline + 1);
      if (Date.now() > deadline) break;
    }
    // A trailing line without newline is left for the next run (it may still be written).
    entry.tail = entry.offset + carry.length >= info.size ? carry.length : 0;
    return entry.offset + entry.tail >= info.size;
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}

const cutoffDay = () => dayKey(Date.now() - RETENTION_DAYS * 86_400_000);

function applySnapshots(index, snapshots) {
  const today = dayKey(Date.now());
  for (const [agentId, records] of Object.entries(snapshots.sessions)) {
    if (!records) continue;
    const target = index.records[agentId] || {};
    for (const record of records) {
      if (!record.day) continue;
      // Snapshots have no per-request prompt size: their bucket only carries the off-peak flag.
      const model = record.model || null;
      target[record.key] = {
        d: record.day,
        t: TOKEN_FIELDS.map((field) => record.tokens[field] || 0),
        m: model,
        b: model ? bucketFor({ model, timestamp: record.at, agentId }) : "s",
        n: record.requests || 0,
        rc: record.costUsd || 0,
        p: record.project || null,
      };
    }
    index.records[agentId] = target;
  }
  if (snapshots.workbuddyCredits) {
    for (const record of snapshots.workbuddyCredits) {
      if (record.day) index.credits[record.key] = { d: record.day, v: record.credits };
    }
  }
  // Hermes reports running totals: increases since the last run are attributed to today.
  for (const skill of snapshots.reported.hermes || []) {
    const previous = index.reported.hermes[skill.name];
    const days = { ...(previous?.days || {}) };
    if (previous && skill.count > previous.count) days[today] = (days[today] || 0) + skill.count - previous.count;
    index.reported.hermes[skill.name] = { count: skill.count, lastUsedAt: skill.lastUsedAt, days };
  }
  for (const skill of snapshots.reported.workbuddy || []) {
    const previous = index.reported.workbuddy[skill.name];
    const days = new Set([...(previous?.days || []), ...skill.days]);
    index.reported.workbuddy[skill.name] = { lastUsedAt: skill.lastUsedAt, days: [...days].sort().slice(-RETENTION_DAYS) };
  }
}

function pruneModels(byModel, cutoff) {
  for (const [model, byDay] of Object.entries(byModel || {})) {
    for (const day of Object.keys(byDay)) if (day < cutoff) delete byDay[day];
    if (!Object.keys(byDay).length) delete byModel[model];
  }
}

function pruneOld(index) {
  const cutoff = cutoffDay();
  for (const entry of Object.values(index.files)) {
    for (const day of Object.keys(entry.d)) if (day < cutoff) delete entry.d[day];
    pruneModels(entry.m, cutoff);
    for (const [skill, byModel] of Object.entries(entry.km || {})) {
      pruneModels(byModel, cutoff);
      if (!Object.keys(byModel).length) delete entry.km[skill];
    }
    for (const map of [entry.k, entry.kt, entry.ki]) {
      for (const [name, byDay] of Object.entries(map)) {
        for (const day of Object.keys(byDay)) if (day < cutoff) delete byDay[day];
        if (!Object.keys(byDay).length) delete map[name];
      }
    }
  }
  for (const records of Object.values(index.records)) {
    for (const [key, record] of Object.entries(records)) if (record.d < cutoff) delete records[key];
  }
}

export const defaultIndexPath = (homeDirectory = homedir()) => path.join(homeDirectory, ".agent-skill-manager", USAGE_INDEX_FILE);

/**
 * One indexing run. Newest files first, so recent days are complete early; the run stops
 * after `budgetMs` and the next run continues from the saved offsets.
 */
export async function runUsageIndex({
  homeDirectory = homedir(),
  indexPath = defaultIndexPath(homeDirectory),
  budgetMs = 3_000,
  onProgress = () => {},
} = {}) {
  const started = Date.now();
  const deadline = started + budgetMs;
  const index = await loadUsageIndex(indexPath);
  const [files, snapshots] = await Promise.all([discoverTranscripts(homeDirectory), readSnapshots(homeDirectory)]);
  applySnapshots(index, snapshots);
  const present = new Set(files.map((file) => file.key));
  for (const [key, entry] of Object.entries(index.files)) {
    // Products delete old transcripts; their aggregates stay.
    if (!present.has(key)) entry.gone = true;
  }
  const isDone = (file) => {
    const entry = index.files[file.key];
    return Boolean(entry) && entry.size === file.size && entry.offset + (entry.tail || 0) >= file.size;
  };
  const pending = files
    .filter((file) => !isDone(file) || index.files[file.key].mtimeMs !== file.mtimeMs)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  const progress = () => {
    const indexed = files.filter(isDone);
    index.totals = {
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.size, 0),
      indexedFiles: indexed.length,
      indexedBytes: files.reduce((sum, file) => sum + Math.min(file.size, index.files[file.key]?.offset || 0), 0),
    };
    onProgress({ ...index.totals });
  };
  progress();
  const seen = new Map(Object.entries(index.seen || {}).map(([agentId, digests]) => [agentId, new Set(digests)]));
  const seenFor = (agentId) => {
    if (!seen.has(agentId)) seen.set(agentId, new Set());
    return seen.get(agentId);
  };
  let timedOut = false;
  let processed = 0;
  for (const file of pending) {
    // Every run makes progress on at least one file, however small the budget.
    if (processed > 0 && Date.now() > deadline) {
      timedOut = true;
      break;
    }
    processed += 1;
    const entry = index.files[file.key] || freshEntry(file);
    index.files[file.key] = entry;
    await indexFile(file, entry, deadline, seenFor(file.agentId));
    progress();
  }
  index.seen = Object.fromEntries([...seen].map(([agentId, digests]) => [agentId, [...digests].slice(-SEEN_LIMIT)]));
  pruneOld(index);
  progress();
  index.complete = !timedOut && index.totals.indexedFiles >= index.totals.files;
  index.updatedAt = new Date().toISOString();
  await saveUsageIndex(indexPath, index);
  return {
    state: index.complete ? "complete" : "partial",
    ...index.totals,
    durationMs: Date.now() - started,
    warnings: snapshots.warnings,
  };
}
