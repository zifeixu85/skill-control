import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { hermesHomeFor, readHermesActivity } from "./hermes.mjs";
import { readOpenClawActivity } from "./openclaw.mjs";
import { readBoundedJson } from "./fs-safe.mjs";

/**
 * Agent activity is derived from session file metadata only (stat, never contents).
 * It feeds the "常用 Agent" suggestion; ranking uses bytes written recently because
 * background automations inflate file counts and active days.
 */

export const ACTIVITY_WINDOW_DAYS = 30;
export const ACTIVITY_FILE_LIMIT = 20_000;
const DIRECTORY_ENTRY_LIMIT = 5_000;
const STAT_BATCH = 64;
const SUGGESTION_LIMIT = 2;
// The owner's real split is Codex 8.8 GB vs Claude Code 0.68 GB (7.7%), and both
// are daily drivers; a background-automation agent sat at 0.25%.
const SUGGESTION_MIN_SHARE = 0.02;
const SUGGESTION_MIN_FILES = 3;

// Codex appends to a resumed session's original rollout file, so a recently active
// session can live in an old YYYY/MM/DD folder (on the owner's machine 3.7 GB of the
// 8.8 GB written in the last 30 days sat in folders older than 30 days, the oldest 89
// days). Date folders are therefore pruned only beyond a one-year lookback.
const DATED_DIRECTORY_LOOKBACK_DAYS = 365;
const SORT_STAT_LIMIT = 20_000;

const ACTIVITY_SOURCES = {
  codex: {
    label: "Codex",
    root: [".codex", "sessions"],
    depth: 3,
    pattern: /^rollout-.+\.jsonl(?:\.zst)?$/u,
    datedDirectories: true,
  },
  claude: { label: "Claude Code", root: [".claude", "projects"], depth: 1, pattern: /\.jsonl$/u },
  workbuddy: { label: "WorkBuddy", root: [".workbuddy", "projects"], depth: 1, pattern: /\.jsonl$/u },
};

function localDay(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/** Latest instant a YYYY / YYYY/MM / YYYY/MM/DD folder can describe, or null. */
function datedFolderEnd(parts) {
  if (!parts.every((part) => /^\d{1,4}$/u.test(part))) return null;
  const [year, month = 12, day] = parts.map(Number);
  if (day !== undefined) return Date.UTC(year, month - 1, day + 1);
  return Date.UTC(year, month, 1);
}

async function sortByRecentMtime(directory, entries) {
  const stats = await Promise.all(
    entries.slice(0, SORT_STAT_LIMIT).map(async (entry) => {
      try {
        return { entry, mtimeMs: (await lstat(path.join(directory, entry.name))).mtimeMs };
      } catch {
        return { entry, mtimeMs: 0 };
      }
    }),
  );
  return stats.sort((left, right) => right.mtimeMs - left.mtimeMs).map((item) => item.entry);
}

async function collectSessionFiles(root, source, { maxFiles, now }) {
  const files = [];
  let truncated = false;
  const pruneBefore = now - DATED_DIRECTORY_LOOKBACK_DAYS * 86_400_000;
  async function visit(directory, remainingDepth, dateParts) {
    if (files.length >= maxFiles) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries = entries.filter((entry) =>
      remainingDepth === 0
        ? entry.isFile() && source.pattern.test(entry.name)
        : entry.isDirectory() && !entry.name.startsWith("."),
    );
    // Newest first, then cap: dated folders sort by name, project folders by mtime.
    if (remainingDepth > 0 && !source.datedDirectories) {
      entries = await sortByRecentMtime(directory, entries);
    } else {
      entries.sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true }));
    }
    if (entries.length > DIRECTORY_ENTRY_LIMIT) {
      truncated = true;
      entries = entries.slice(0, DIRECTORY_ENTRY_LIMIT);
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      // Dirent types come from lstat semantics, so symlinks are never followed here.
      if (remainingDepth === 0) {
        files.push(path.join(directory, entry.name));
        continue;
      }
      const parts = [...dateParts, entry.name];
      if (source.datedDirectories) {
        const end = datedFolderEnd(parts);
        if (end !== null && end < pruneBefore) continue;
      }
      await visit(path.join(directory, entry.name), remainingDepth - 1, parts);
    }
  }
  await visit(root, source.depth, []);
  return { files, truncated };
}

async function statFiles(files) {
  const results = [];
  for (let index = 0; index < files.length; index += STAT_BATCH) {
    const batch = await Promise.all(
      files.slice(index, index + STAT_BATCH).map(async (file) => {
        try {
          const info = await lstat(file);
          return info.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : null;
        } catch {
          return null;
        }
      }),
    );
    results.push(...batch.filter(Boolean));
  }
  return results;
}

function emptyActivity(agentId, status) {
  return {
    agentId,
    status,
    basis: "bytes",
    files30d: 0,
    bytes30d: 0,
    weight30d: 0,
    activeDays30d: 0,
    lastActiveAt: null,
    truncated: false,
  };
}

// Products that keep token counts in a database instead of transcript files. Their
// activity weight is tokens × 4 (≈ characters), comparable to transcript bytes.
const TOKEN_WEIGHT = 4;
const TOKEN_SOURCES = {
  hermes: {
    label: "Hermes Agent",
    read: (homeDirectory, now) => readHermesActivity(homeDirectory, { now }),
    fallback: hermesUsageFallback,
  },
  openclaw: { label: "OpenClaw", read: (homeDirectory, now) => readOpenClawActivity("openclaw", homeDirectory, { now }) },
  qclaw: { label: "QClaw", read: (homeDirectory, now) => readOpenClawActivity("qclaw", homeDirectory, { now }) },
};

/** Without state.db, Hermes' skill usage file still tells when it was last used. */
async function hermesUsageFallback(homeDirectory) {
  const usage = await readBoundedJson(path.join(hermesHomeFor(homeDirectory), "skills", ".usage.json"), 4_000_000);
  if (usage.status !== "ok") return null;
  const times = Object.values(usage.value || {})
    .map((entry) => Date.parse(entry?.last_used_at))
    .filter((value) => Number.isFinite(value));
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

/** Skill folder name → SKILL.md reads seen in recent transcripts (an estimate, capped). */
function topSkillReads(reads) {
  return Object.fromEntries([...reads].sort((left, right) => right[1] - left[1]).slice(0, MAX_SKILL_READS));
}

async function scanTokenSource(homeDirectory, agentId, source, { now }) {
  const activity = await source.read(homeDirectory, now).catch(() => null);
  if (!activity?.available) {
    const lastActiveAt = source.fallback ? await source.fallback(homeDirectory).catch(() => null) : null;
    return {
      ...emptyActivity(agentId, lastActiveAt ? "ok" : "missing"),
      basis: source.fallback ? "skill-usage" : "tokens",
      lastActiveAt,
      warnings: activity?.warnings || [],
    };
  }
  return {
    agentId,
    status: "ok",
    basis: "tokens",
    files30d: activity.sessions30d,
    bytes30d: null,
    tokens30d: activity.tokens30d,
    costUsd30d: activity.costUsd30d,
    weight30d: activity.tokens30d * TOKEN_WEIGHT,
    activeDays30d: null,
    lastActiveAt: activity.lastActiveAt,
    truncated: false,
    ...(activity.skillReads?.size ? { skillReads30d: topSkillReads(activity.skillReads) } : {}),
    warnings: activity.warnings || [],
  };
}

async function scanSource(homeDirectory, agentId, source, { now, maxFiles, windowDays }) {
  const root = path.join(homeDirectory, ...source.root);
  try {
    if (!(await lstat(root)).isDirectory()) return emptyActivity(agentId, "missing");
  } catch {
    return emptyActivity(agentId, "missing");
  }
  const { files, truncated } = await collectSessionFiles(root, source, { maxFiles, now });
  const stats = await statFiles(files);
  const windowStart = now - windowDays * 86_400_000;
  const days = new Set();
  let files30d = 0;
  let bytes30d = 0;
  let latest = 0;
  for (const info of stats) {
    latest = Math.max(latest, info.mtimeMs);
    if (info.mtimeMs < windowStart || info.mtimeMs > now + 86_400_000) continue;
    files30d += 1;
    bytes30d += info.size;
    days.add(localDay(info.mtimeMs));
  }
  return {
    agentId,
    status: "ok",
    basis: "bytes",
    files30d,
    bytes30d,
    weight30d: bytes30d,
    activeDays30d: days.size,
    lastActiveAt: latest ? new Date(latest).toISOString() : null,
    truncated,
  };
}

const MAX_SKILL_READS = 500;
const weightOf = (agent) => agent.weight30d ?? agent.bytes30d ?? 0;

/**
 * Top agents by recent activity weight (transcript bytes, or tokens × 4 for products
 * that only record tokens); agents below 2% of the leader or with fewer than 3
 * sessions are dropped.
 */
export function suggestPrimaryAgents(agents, limit = SUGGESTION_LIMIT) {
  const ranked = agents
    .filter(
      (agent) =>
        agent.status === "ok" &&
        agent.files30d >= SUGGESTION_MIN_FILES &&
        weightOf(agent) > 0,
    )
    .sort(
      (left, right) =>
        weightOf(right) - weightOf(left) ||
        right.files30d - left.files30d ||
        left.agentId.localeCompare(right.agentId),
    );
  if (!ranked.length) return [];
  const threshold = weightOf(ranked[0]) * SUGGESTION_MIN_SHARE;
  return ranked
    .filter((agent) => weightOf(agent) >= threshold)
    .slice(0, limit)
    .map((agent) => agent.agentId);
}

export async function scanAgentActivity(
  homeDirectory = homedir(),
  {
    agentIds = [],
    now = Date.now(),
    maxFiles = ACTIVITY_FILE_LIMIT,
    windowDays = ACTIVITY_WINDOW_DAYS,
  } = {},
) {
  const orderedIds = [
    ...new Set([...agentIds.map(String), ...Object.keys(ACTIVITY_SOURCES)]),
  ];
  const agents = await Promise.all(
    orderedIds.map((agentId) =>
      Object.hasOwn(ACTIVITY_SOURCES, agentId)
        ? scanSource(homeDirectory, agentId, ACTIVITY_SOURCES[agentId], {
            now,
            maxFiles,
            windowDays,
          })
        : Object.hasOwn(TOKEN_SOURCES, agentId) && agentIds.includes(agentId)
          ? scanTokenSource(homeDirectory, agentId, TOKEN_SOURCES[agentId], { now })
          : emptyActivity(agentId, "unknown"),
    ),
  );
  const warnings = [
    ...agents
      .filter((agent) => agent.truncated)
      .map(
        (agent) =>
          `${ACTIVITY_SOURCES[agent.agentId]?.label || agent.agentId} 的会话文件过多，仅统计了最近的部分文件，活跃度可能偏低。`,
      ),
    ...agents.flatMap((agent) => agent.warnings || []),
  ];
  for (const agent of agents) delete agent.warnings;
  // Suggestions are ranked among configured Agents only, before the top-N cap.
  const allowed = new Set(agentIds.map(String));
  const candidates = allowed.size
    ? agents.filter((agent) => allowed.has(agent.agentId))
    : agents;
  return {
    windowDays,
    rankedBy: "weight30d",
    agents,
    suggestedPrimaryAgentIds: suggestPrimaryAgents(candidates),
    warnings,
    scannedAt: new Date(now).toISOString(),
  };
}
