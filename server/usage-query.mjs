import { pricingFreshness } from "./pricing.mjs";
import { CODEX_DB_REASON, costIndex, modelsAcrossAgents, roundUsd, sumCosts } from "./usage-cost.mjs";
import { agentProjects, costProjects, projectsAcrossAgents } from "./usage-projects.mjs";
import { fileActiveDays, recordActiveDays, sessionCounter, sessionKeyOf } from "./usage-sessions.mjs";
import { dayKey } from "./usage-sources.mjs";
import { cacheBySession, rowRates, ratesAcross, ratesOf, reportsCache } from "./usage-cache.mjs";

/** byModel rows with their cache rates. */
const withRowRates = (byModel, agentId = null) => byModel.map((row) => ({ ...row, ...rowRates(row, agentId) }));

/**
 * Read-side of the usage index: per-agent summaries, one skill across agents and one
 * agent's series, top skills and top projects. Every figure carries its source and
 * confidence: "exact" (counted from transcripts), "inferred" (SKILL.md reads seen in tool
 * arguments) or "reported" (the product's own counters). Costs are API-equivalent estimates
 * at the vendors' official prices (usage-cost.mjs), with the share of each basis.
 */

export const MAX_USAGE_DAYS = 3650;
export const ALL_TIME_LABEL = "所有时间";

export const USAGE_SOURCES = {
  claude: {
    tokens: { label: "会话记录 ~/.claude/projects", confidence: "exact" },
    skills: { label: "Skill 工具调用", confidence: "exact" },
    reportedCost: false,
  },
  codex: {
    tokens: { label: "会话记录 ~/.codex/sessions（token_count）", confidence: "exact" },
    threads: { label: "会话记录已删除的线程：state 数据库 threads 表的总 tokens（按本机比例拆分估算）", confidence: "estimate" },
    skills: { label: "命令参数中读取的 SKILL.md", confidence: "inferred" },
    reportedCost: false,
  },
  workbuddy: {
    tokens: { label: "会话记录 ~/.workbuddy/projects", confidence: "exact" },
    skills: { label: "Skill 工具调用与 usage-log.json", confidence: "exact" },
    credits: { label: "workbuddy.db 额度记录", confidence: "reported" },
    reportedCost: false,
  },
  hermes: {
    tokens: { label: "state.db 会话表", confidence: "reported" },
    skills: { label: "skills/.usage.json", confidence: "reported" },
    reportedCost: true,
  },
  openclaw: {
    tokens: { label: "sessions.json", confidence: "reported" },
    skills: { label: "会话中读取的 SKILL.md", confidence: "inferred" },
    reportedCost: true,
  },
  "office-raccoon": {
    tokens: { label: "local-chat.sqlite3 每轮 token 记录（没有模型信息，不计价）", confidence: "reported" },
    skills: { label: "对话中的技能调用记录", confidence: "reported" },
    reportedCost: false,
  },
  qclaw: {
    tokens: { label: "sessions.json", confidence: "reported" },
    skills: { label: "会话中读取的 SKILL.md", confidence: "inferred" },
    reportedCost: true,
  },
};

/** `days` query value: 1–3650, or null for all time ("all" or "0"); anything else is the fallback. */
export const clampDays = (value, fallback) => {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "all" || text === "0") return null;
  const days = /^\d{1,6}$/u.test(text) ? Number.parseInt(text, 10) : Number.NaN;
  return Number.isFinite(days) ? Math.min(MAX_USAGE_DAYS, Math.max(1, days)) : fallback;
};

export const windowLabel = (days) => (days === null ? ALL_TIME_LABEL : `最近 ${days} 天`);

/** The earliest day anything in the index refers to (bounded by MAX_USAGE_DAYS). */
function earliestDay(index, today, now) {
  const floor = dayKey(now - (MAX_USAGE_DAYS - 1) * 86_400_000);
  let earliest = today;
  const see = (day) => {
    if (typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(day) && day < earliest) earliest = day;
  };
  for (const entry of Object.values(index.files || {})) {
    for (const day of Object.keys(entry.d || {})) see(day);
    for (const byName of [entry.k, entry.ki, entry.kt]) for (const byDay of Object.values(byName || {})) for (const day of Object.keys(byDay)) see(day);
  }
  for (const records of Object.values(index.records || {})) for (const record of Object.values(records)) see(record.d);
  for (const credit of Object.values(index.credits || {})) see(credit.d);
  for (const skill of Object.values(index.reported?.hermes || {})) for (const day of Object.keys(skill.days || {})) see(day);
  for (const skill of Object.values(index.reported?.["office-raccoon"] || {})) for (const day of Object.keys(skill.days || {})) see(day);
  for (const skill of Object.values(index.reported?.workbuddy || {})) for (const day of skill.days || []) see(day);
  return earliest < floor ? floor : earliest;
}

/** The days of a window, oldest first; `days === null` is all time (from the earliest indexed day). */
function windowDays(days, now = Date.now(), index = {}) {
  const today = dayKey(now);
  const list = [];
  if (days === null) {
    const first = earliestDay(index, today, now);
    for (let offset = 0; offset < MAX_USAGE_DAYS; offset += 1) {
      const day = dayKey(now - offset * 86_400_000);
      list.push(day);
      if (day <= first) break;
    }
    return list.reverse();
  }
  for (let offset = days - 1; offset >= 0; offset -= 1) list.push(dayKey(now - offset * 86_400_000));
  return list;
}

const emptyTokens = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
const FIELDS = ["input", "output", "cacheRead", "cacheWrite", "total"];

/** Per agent, per day: { sessions, tokens, costUsd } from transcript files and DB records. */
/**
 * Per agent, per day: { sessions (active that day), started, tokens, credits } from transcript
 * files and DB records, plus `windowSessions`: sessions active on any day of the window.
 */
function dailyByAgent(index, inWindow) {
  const agents = new Map();
  const sessions = sessionCounter();
  const bucket = (agentId, day) => {
    const days = agents.get(agentId) || new Map();
    agents.set(agentId, days);
    const row = days.get(day) || { sessions: 0, started: 0, tokens: emptyTokens(), reportedCostUsd: 0, credits: 0 };
    days.set(day, row);
    return row;
  };
  const active = (agentId, sessionKey, days) => {
    if (!sessionKey) return;
    for (const day of days) bucket(agentId, day);
    sessions.add(agentId, sessionKey, days);
  };
  for (const [key, entry] of Object.entries(index.files || {})) {
    for (const [day, values] of Object.entries(entry.d || {})) {
      if (!inWindow(day)) continue;
      const row = bucket(entry.a, day);
      row.started += values[0];
      FIELDS.forEach((field, offset) => {
        row.tokens[field] += values[offset + 1];
      });
    }
    active(entry.a, sessionKeyOf(key, entry), fileActiveDays(entry, inWindow));
  }
  for (const [agentId, records] of Object.entries(index.records || {})) {
    for (const [key, record] of Object.entries(records)) {
      active(agentId, `record|${key}`, recordActiveDays(record, inWindow));
      if (!inWindow(record.d)) continue;
      const row = bucket(agentId, record.d);
      row.started += 1;
      FIELDS.forEach((field, offset) => {
        row.tokens[field] += record.t[offset] || 0;
      });
      row.reportedCostUsd += record.rc || 0;
    }
  }
  for (const credit of Object.values(index.credits || {})) {
    if (inWindow(credit.d)) bucket("workbuddy", credit.d).credits += credit.v || 0;
  }
  for (const [agentId, days] of agents) for (const [day, row] of days) row.sessions = sessions.onDay(agentId, day);
  const windowSessions = new Map([...agents.keys()].map((agentId) => [agentId, sessions.count(agentId)]));
  return { daily: agents, windowSessions };
}

/** Skill counts per agent within the window: { agentId: { skill: { day: count } } } + confidence. */
function skillsByAgent(index, inWindow) {
  const result = new Map();
  const add = (agentId, name, day, amount, confidence) => {
    if (!inWindow(day)) return;
    const skills = result.get(agentId) || new Map();
    result.set(agentId, skills);
    const row = skills.get(name) || { days: new Map(), confidence, tokens: 0, lastDay: null };
    skills.set(name, row);
    row.days.set(day, (row.days.get(day) || 0) + amount);
    if (!row.lastDay || day > row.lastDay) row.lastDay = day;
    if (row.confidence !== confidence && confidence === "exact") row.confidence = "exact";
  };
  for (const entry of Object.values(index.files || {})) {
    for (const [name, byDay] of Object.entries(entry.k || {})) {
      for (const [day, amount] of Object.entries(byDay)) add(entry.a, name, day, amount, "exact");
    }
    for (const [name, byDay] of Object.entries(entry.ki || {})) {
      for (const [day, amount] of Object.entries(byDay)) add(entry.a, name, day, amount, "inferred");
    }
  }
  for (const [name, skill] of Object.entries(index.reported?.hermes || {})) {
    for (const [day, amount] of Object.entries(skill.days || {})) add("hermes", name, day, amount, "reported");
  }
  for (const [name, skill] of Object.entries(index.reported?.["office-raccoon"] || {})) {
    for (const [day, amount] of Object.entries(skill.days || {})) add("office-raccoon", name, day, amount, "reported");
  }
  // usage-log.json only says on which days a skill was used: it fills days that the
  // transcripts (possibly deleted since) do not cover, and never adds to counted days.
  for (const [name, skill] of Object.entries(index.reported?.workbuddy || {})) {
    for (const day of skill.days || []) {
      if (!result.get("workbuddy")?.get(name)?.days.has(day)) add("workbuddy", name, day, 1, "reported");
    }
  }
  // Token attribution (Claude attributionSkill), exact.
  for (const entry of Object.values(index.files || {})) {
    for (const [name, byDay] of Object.entries(entry.kt || {})) {
      for (const [day, tokens] of Object.entries(byDay)) {
        if (!inWindow(day)) continue;
        const row = result.get(entry.a)?.get(name);
        if (row) row.tokens += tokens;
        else {
          add(entry.a, name, day, 0, "exact");
          result.get(entry.a).get(name).tokens += tokens;
        }
      }
    }
  }
  return result;
}

const sumDays = (days) => [...days.values()].reduce((total, value) => total + value, 0);

/**
 * Per-agent notes for the window, for the UI to show next to the figures. Codex: sessions
 * that only exist in its database (rollout files deleted) are estimates; spawned subagent
 * threads there count as sessions only, because their totals include the parent's context.
 */
function agentNotes(index, inWindow) {
  const notes = new Map();
  let sessions = 0;
  let tokens = 0;
  let spawned = 0;
  let uncounted = 0;
  let unsplit = 0;
  for (const record of Object.values(index.records?.codex || {})) {
    if (record.x !== "codex-db" || !inWindow(record.d)) continue;
    sessions += 1;
    tokens += record.t?.[4] || 0;
    if (record.i) {
      spawned += 1;
      uncounted += record.i;
    }
    if (record.u) unsplit += record.t?.[4] || 0;
  }
  if (sessions) {
    const parts = [`${CODEX_DB_REASON}（${sessions} 个会话）。`];
    if (spawned) parts.push(`其中 ${spawned} 个子代理线程的总数含父线程上下文、无法拆出自身用量，只计会话、不计 tokens。`);
    if (unsplit) parts.push("还没有可参考的 Codex 会话记录，这部分 tokens 暂不估算费用。");
    notes.set("codex", [{ kind: "codex-db-estimate", text: parts.join(""), sessions, tokens, spawnedSessions: spawned, uncountedTokens: uncounted, unpricedTokens: unsplit }]);
  }
  return notes;
}

function sourcesFor(agentId) {
  const sources = USAGE_SOURCES[agentId];
  if (!sources) return [];
  return Object.entries(sources)
    .filter(([, value]) => value && typeof value === "object")
    .map(([id, value]) => ({ id, label: value.label, confidence: value.confidence }));
}

function indexStatus(index) {
  return {
    complete: Boolean(index.complete),
    updatedAt: index.updatedAt || null,
    indexedFiles: index.totals?.indexedFiles || 0,
    totalFiles: index.totals?.files || 0,
  };
}

const NO_COST = { costUsd: 0, costBasis: { official: 0, estimate: 0, family: 0, reported: 0 }, unpricedTokens: 0, byModel: [], byDay: new Map(), reportedCostUsd: null, skills: new Map() };

/** The cost fields of an agent, a skill or a total. */
const costFields = (priced = NO_COST) => ({ costUsd: priced.costUsd, costBasis: priced.costBasis, unpricedTokens: priced.unpricedTokens });

const windowFilter = (dates) => (day) => typeof day === "string" && day >= dates[0] && day <= dates.at(-1);

/** GET /api/usage/summary */
export function usageSummary(index, { days = 30, now = Date.now() } = {}) {
  const dates = windowDays(days, now, index);
  const inWindow = windowFilter(dates);
  const { daily, windowSessions } = dailyByAgent(index, inWindow);
  const skills = skillsByAgent(index, inWindow);
  const costs = costIndex(index, inWindow);
  const notes = agentNotes(index, inWindow);
  const cache = cacheBySession(index, inWindow);
  const agentIds = [...new Set([...daily.keys(), ...skills.keys(), ...costs.keys()])].sort();
  const agents = agentIds.map((agentId) => {
    const byDay = daily.get(agentId) || new Map();
    const priced = costs.get(agentId) || NO_COST;
    const tokens = emptyTokens();
    let sessionsStarted = 0;
    let credits = 0;
    let activeDays = 0;
    for (const row of byDay.values()) {
      sessionsStarted += row.started;
      credits += row.credits;
      if (row.started || row.tokens.total) activeDays += 1;
      for (const field of FIELDS) tokens[field] += row.tokens[field];
    }
    return {
      agentId,
      sessions: windowSessions.get(agentId) || 0,
      sessionsStarted,
      activeDays,
      tokens,
      ...costFields(priced),
      ...(USAGE_SOURCES[agentId]?.reportedCost ? { reportedCostUsd: priced.reportedCostUsd ?? 0 } : {}),
      ...ratesOf(agentId, priced.byModel),
      cacheBySession: cache.get(agentId) || null,
      byModel: withRowRates(priced.byModel, agentId),
      ...(agentId === "workbuddy" ? { credits: Math.round(credits * 100) / 100 } : {}),
      series: dates.map((date) => ({
        date,
        sessions: byDay.get(date)?.sessions || 0,
        sessionsStarted: byDay.get(date)?.started || 0,
        tokens: byDay.get(date)?.tokens.total || 0,
        costUsd: roundUsd(priced.byDay.get(date)),
      })),
      sources: sourcesFor(agentId),
      ...(notes.has(agentId) ? { notes: notes.get(agentId) } : {}),
    };
  });
  const totals = new Map();
  for (const [agentId, agentSkills] of skills) {
    for (const [name, row] of agentSkills) {
      const total = totals.get(name) || { name, count: 0, tokens: 0, costUsd: null, agents: [] };
      const count = sumDays(row.days);
      const skillCost = costs.get(agentId)?.skills.get(name);
      total.count += count;
      total.tokens += row.tokens;
      if (skillCost) total.costUsd = roundUsd((total.costUsd || 0) + skillCost.costUsd);
      total.agents.push({ agentId, count, confidence: row.confidence, lastUsedAt: row.lastDay, ...(skillCost ? { costUsd: skillCost.costUsd } : {}) });
      totals.set(name, total);
    }
  }
  const topSkills = [...totals.values()]
    .filter((skill) => skill.count > 0 || skill.tokens > 0)
    .sort((left, right) => right.count - left.count || right.tokens - left.tokens || left.name.localeCompare(right.name))
    .slice(0, 50);
  return {
    generatedAt: new Date(now).toISOString(),
    windowDays: days,
    windowLabel: windowLabel(days),
    index: indexStatus(index),
    cost: sumCosts([...costs.values()]),
    agents,
    topSkills,
  };
}

/**
 * Sort keys from the usage index for every skill, by lower-case name and by the part after
 * "plugin:": { lastUsedAt (day), uses30d, usesAll } over all agents.
 */
export function skillUsageStats(index, { now = Date.now() } = {}) {
  const cutoff = dayKey(now - 29 * 86_400_000);
  const stats = new Map();
  for (const skills of skillsByAgent(index, (day) => typeof day === "string").values()) {
    for (const [name, row] of skills) {
      for (const key of new Set([name.toLowerCase(), name.toLowerCase().split(":").at(-1)])) {
        const entry = stats.get(key) || { lastUsedAt: null, uses30d: 0, usesAll: 0 };
        for (const [day, count] of row.days) {
          entry.usesAll += count;
          if (day >= cutoff) entry.uses30d += count;
          if (count > 0 && (!entry.lastUsedAt || day > entry.lastUsedAt)) entry.lastUsedAt = day;
        }
        stats.set(key, entry);
      }
    }
  }
  return stats;
}

const TOTAL_WINDOWS = [
  ["today", 1, "今天"],
  ["7", 7, "近 7 天"],
  ["30", 30, "近 30 天"],
  ["90", 90, "近 90 天"],
  ["all", null, "全部"],
];

/** One window of GET /api/usage/totals: every agent added up, plus each agent's share. */
function windowTotals(index, { id, days, label, now }) {
  const dates = windowDays(days, now, index);
  const inWindow = windowFilter(dates);
  const { daily, windowSessions } = dailyByAgent(index, inWindow);
  const costs = costIndex(index, inWindow);
  const notes = agentNotes(index, inWindow);
  const cache = cacheBySession(index, inWindow);
  const tokens = emptyTokens();
  const activeDays = new Set();
  const byAgent = [];
  for (const agentId of [...new Set([...daily.keys(), ...costs.keys()])]) {
    const agentTokens = emptyTokens();
    for (const [day, row] of daily.get(agentId) || []) {
      for (const field of FIELDS) agentTokens[field] += row.tokens[field];
      if (row.started || row.tokens.total) activeDays.add(day);
    }
    for (const field of FIELDS) tokens[field] += agentTokens[field];
    const costUsd = costs.get(agentId)?.costUsd || 0;
    if (agentTokens.total || costUsd || windowSessions.get(agentId)) {
      byAgent.push({
        agentId,
        tokens: agentTokens,
        costUsd,
        sessions: windowSessions.get(agentId) || 0,
        ...ratesOf(agentId, costs.get(agentId)?.byModel || []),
        cacheBySession: cache.get(agentId) || null,
        ...(notes.has(agentId) ? { notes: notes.get(agentId) } : {}),
      });
    }
  }
  byAgent.sort((left, right) => right.costUsd - left.costUsd || right.tokens.total - left.tokens.total || left.agentId.localeCompare(right.agentId));
  return {
    id,
    label,
    windowDays: days,
    from: dates[0],
    to: dates.at(-1),
    tokens,
    ...sumCosts([...costs.values()]),
    sessions: [...windowSessions.values()].reduce((sum, value) => sum + value, 0),
    activeDays: activeDays.size,
    ...ratesAcross([...costs].map(([agentId, priced]) => [agentId, priced.byModel])),
    byAgent,
  };
}

/** GET /api/usage/totals: today, 7, 30, 90 days and all time in one response. */
export function usageTotals(index, { now = Date.now() } = {}) {
  return {
    generatedAt: new Date(now).toISOString(),
    index: indexStatus(index),
    windows: TOTAL_WINDOWS.map(([id, days, label]) => windowTotals(index, { id, days, label, now })),
  };
}

/** GET /api/usage/projects */
export function usageProjects(index, { days = 30, now = Date.now() } = {}) {
  const dates = windowDays(days, now, index);
  const inWindow = windowFilter(dates);
  const costs = costIndex(index, inWindow);
  return {
    generatedAt: new Date(now).toISOString(),
    windowDays: days,
    windowLabel: windowLabel(days),
    index: indexStatus(index),
    ...projectsAcrossAgents(costProjects(index, inWindow, costs), costs),
  };
}

/** GET /api/usage/models */
export function usageModels(index, { days = 30, now = Date.now() } = {}) {
  const dates = windowDays(days, now, index);
  const costs = costIndex(index, windowFilter(dates));
  // A merged row's rate is null when none of its agents records cache tokens.
  const models = modelsAcrossAgents(costs).map((row) =>
    row.agents.some((agent) => reportsCache(agent.agentId)) ? { ...row, ...rowRates(row) } : { ...row, cacheHitRate: null, cacheWriteShare: null },
  );
  const freshness = pricingFreshness(undefined, now);
  return {
    generatedAt: new Date(now).toISOString(),
    windowDays: days,
    windowLabel: windowLabel(days),
    index: indexStatus(index),
    totals: sumCosts([...costs.values()]),
    models,
    unpriced: models.filter((model) => model.basis === "unpriced").map((model) => model.model),
    // Promotions and previews past their review date, and the age of the whole table.
    pricingStale: freshness.pricingStale,
    pricingTable: freshness.table,
  };
}

/** GET /api/usage/skill */
export function usageForSkill(index, name, { days = 90, now = Date.now() } = {}) {
  const dates = windowDays(days, now, index);
  const inWindow = windowFilter(dates);
  const skills = skillsByAgent(index, inWindow);
  const costs = costIndex(index, inWindow);
  const wanted = String(name || "").trim().toLowerCase();
  const agents = [];
  for (const [agentId, agentSkills] of skills) {
    for (const [skillName, row] of agentSkills) {
      if (skillName.toLowerCase() !== wanted && skillName.toLowerCase().split(":").at(-1) !== wanted) continue;
      const reported = agentId === "hermes" ? index.reported?.hermes?.[skillName] : agentId === "workbuddy" ? index.reported?.workbuddy?.[skillName] : null;
      const skillCost = costs.get(agentId)?.skills.get(skillName);
      agents.push({
        agentId,
        name: skillName,
        total: sumDays(row.days),
        tokens: row.tokens || 0,
        // Only token-attributed skills (Claude attributionSkill) have a cost.
        ...(skillCost ? { ...costFields(skillCost), byModel: skillCost.byModel } : { costUsd: null }),
        lastUsedAt: reported?.lastUsedAt || row.lastDay,
        confidence: row.confidence,
        ...(agentId === "hermes" && reported ? { reportedTotal: reported.count } : {}),
        series: dates.map((date) => ({ date, count: row.days.get(date) || 0 })),
      });
    }
  }
  // Products that report all-time counts still show when the window has no daily data.
  for (const [skillName, reported] of Object.entries(index.reported?.hermes || {})) {
    if (skillName.toLowerCase() === wanted && !agents.some((agent) => agent.agentId === "hermes")) {
      agents.push({
        agentId: "hermes",
        name: skillName,
        total: 0,
        tokens: 0,
        lastUsedAt: reported.lastUsedAt,
        confidence: "reported",
        costUsd: null,
        reportedTotal: reported.count,
        series: dates.map((date) => ({ date, count: 0 })),
      });
    }
  }
  return { name: String(name || ""), windowDays: days, windowLabel: windowLabel(days), index: indexStatus(index), agents };
}

/** GET /api/usage/agent */
export function usageForAgent(index, agentId, { days = 90, now = Date.now() } = {}) {
  const dates = windowDays(days, now, index);
  const inWindow = windowFilter(dates);
  const { daily, windowSessions } = dailyByAgent(index, inWindow);
  const byDay = daily.get(agentId) || new Map();
  const skills = skillsByAgent(index, inWindow).get(agentId) || new Map();
  const costs = costIndex(index, inWindow);
  const priced = costs.get(agentId) || NO_COST;
  const totals = {
    sessions: windowSessions.get(agentId) || 0,
    sessionsStarted: 0,
    activeDays: 0,
    tokens: emptyTokens(),
    ...costFields(priced),
    ...(USAGE_SOURCES[agentId]?.reportedCost ? { reportedCostUsd: priced.reportedCostUsd ?? 0 } : {}),
    ...ratesOf(agentId, priced.byModel),
    cacheBySession: cacheBySession(index, inWindow).get(agentId) || null,
  };
  for (const row of byDay.values()) {
    totals.sessionsStarted += row.started;
    if (row.started || row.tokens.total) totals.activeDays += 1;
    for (const field of FIELDS) totals.tokens[field] += row.tokens[field];
  }
  const { topProjects, otherProjects } = agentProjects(costProjects(index, inWindow, costs, { agentId }).get(agentId), 20, agentId);
  return {
    agentId,
    windowDays: days,
    windowLabel: windowLabel(days),
    index: indexStatus(index),
    totals,
    byModel: withRowRates(priced.byModel, agentId),
    series: dates.map((date) => {
      const row = byDay.get(date);
      return {
        date,
        sessions: row?.sessions || 0,
        sessionsStarted: row?.started || 0,
        tokens: row ? { ...row.tokens } : emptyTokens(),
        costUsd: roundUsd(priced.byDay.get(date)),
      };
    }),
    topSkills: [...skills]
      .map(([name, row]) => ({
        name,
        count: sumDays(row.days),
        tokens: row.tokens,
        costUsd: priced.skills.get(name)?.costUsd ?? null,
        lastUsedAt: row.lastDay,
        confidence: row.confidence,
      }))
      .filter((skill) => skill.count > 0 || skill.tokens > 0)
      .sort((left, right) => right.count - left.count || right.tokens - left.tokens)
      .slice(0, 30),
    topProjects,
    otherProjects,
    sources: sourcesFor(agentId),
    notes: agentNotes(index, inWindow).get(agentId) || [],
  };
}
