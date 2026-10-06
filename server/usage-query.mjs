import { pricingFreshness } from "./pricing.mjs";
import { costIndex, modelsAcrossAgents, roundUsd, sumCosts } from "./usage-cost.mjs";
import { dayKey } from "./usage-sources.mjs";

/**
 * Read-side of the usage index: per-agent summaries, one skill across agents and one
 * agent's series, top skills and top projects. Every figure carries its source and
 * confidence: "exact" (counted from transcripts), "inferred" (SKILL.md reads seen in tool
 * arguments) or "reported" (the product's own counters). Costs are API-equivalent estimates
 * at the vendors' official prices (usage-cost.mjs), with the share of each basis.
 */

export const MAX_USAGE_DAYS = 400;

export const USAGE_SOURCES = {
  claude: {
    tokens: { label: "会话记录 ~/.claude/projects", confidence: "exact" },
    skills: { label: "Skill 工具调用", confidence: "exact" },
    reportedCost: false,
  },
  codex: {
    tokens: { label: "会话记录 ~/.codex/sessions（token_count）", confidence: "exact" },
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
  qclaw: {
    tokens: { label: "sessions.json", confidence: "reported" },
    skills: { label: "会话中读取的 SKILL.md", confidence: "inferred" },
    reportedCost: true,
  },
};

export const clampDays = (value, fallback) => {
  const days = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(days) ? Math.min(MAX_USAGE_DAYS, Math.max(1, days)) : fallback;
};

function windowDays(days, now = Date.now()) {
  const list = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) list.push(dayKey(now - offset * 86_400_000));
  return list;
}

const emptyTokens = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
const FIELDS = ["input", "output", "cacheRead", "cacheWrite", "total"];

/** Per agent, per day: { sessions, tokens, costUsd } from transcript files and DB records. */
function dailyByAgent(index, inWindow) {
  const agents = new Map();
  const bucket = (agentId, day) => {
    const days = agents.get(agentId) || new Map();
    agents.set(agentId, days);
    const row = days.get(day) || { sessions: 0, tokens: emptyTokens(), reportedCostUsd: 0, credits: 0 };
    days.set(day, row);
    return row;
  };
  for (const entry of Object.values(index.files || {})) {
    for (const [day, values] of Object.entries(entry.d || {})) {
      if (!inWindow(day)) continue;
      const row = bucket(entry.a, day);
      row.sessions += values[0];
      FIELDS.forEach((field, offset) => {
        row.tokens[field] += values[offset + 1];
      });
    }
  }
  for (const [agentId, records] of Object.entries(index.records || {})) {
    for (const record of Object.values(records)) {
      if (!inWindow(record.d)) continue;
      const row = bucket(agentId, record.d);
      row.sessions += 1;
      FIELDS.forEach((field, offset) => {
        row.tokens[field] += record.t[offset] || 0;
      });
      row.reportedCostUsd += record.rc || 0;
    }
  }
  for (const credit of Object.values(index.credits || {})) {
    if (inWindow(credit.d)) bucket("workbuddy", credit.d).credits += credit.v || 0;
  }
  return agents;
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
  const dates = windowDays(days, now);
  const inWindow = windowFilter(dates);
  const daily = dailyByAgent(index, inWindow);
  const skills = skillsByAgent(index, inWindow);
  const costs = costIndex(index, inWindow);
  const agentIds = [...new Set([...daily.keys(), ...skills.keys(), ...costs.keys()])].sort();
  const agents = agentIds.map((agentId) => {
    const byDay = daily.get(agentId) || new Map();
    const priced = costs.get(agentId) || NO_COST;
    const tokens = emptyTokens();
    let sessions = 0;
    let credits = 0;
    let activeDays = 0;
    for (const row of byDay.values()) {
      sessions += row.sessions;
      credits += row.credits;
      if (row.sessions || row.tokens.total) activeDays += 1;
      for (const field of FIELDS) tokens[field] += row.tokens[field];
    }
    return {
      agentId,
      sessions,
      activeDays,
      tokens,
      ...costFields(priced),
      ...(USAGE_SOURCES[agentId]?.reportedCost ? { reportedCostUsd: priced.reportedCostUsd ?? 0 } : {}),
      byModel: priced.byModel,
      ...(agentId === "workbuddy" ? { credits: Math.round(credits * 100) / 100 } : {}),
      series: dates.map((date) => ({
        date,
        sessions: byDay.get(date)?.sessions || 0,
        tokens: byDay.get(date)?.tokens.total || 0,
        costUsd: roundUsd(priced.byDay.get(date)),
      })),
      sources: sourcesFor(agentId),
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
  return { generatedAt: new Date(now).toISOString(), windowDays: days, index: indexStatus(index), cost: sumCosts([...costs.values()]), agents, topSkills };
}

/** GET /api/usage/models */
export function usageModels(index, { days = 30, now = Date.now() } = {}) {
  const dates = windowDays(days, now);
  const costs = costIndex(index, windowFilter(dates));
  const models = modelsAcrossAgents(costs);
  const freshness = pricingFreshness(undefined, now);
  return {
    generatedAt: new Date(now).toISOString(),
    windowDays: days,
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
  const dates = windowDays(days, now);
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
  return { name: String(name || ""), windowDays: days, index: indexStatus(index), agents };
}

/** GET /api/usage/agent */
export function usageForAgent(index, agentId, { days = 90, now = Date.now() } = {}) {
  const dates = windowDays(days, now);
  const inWindow = windowFilter(dates);
  const byDay = dailyByAgent(index, inWindow).get(agentId) || new Map();
  const skills = skillsByAgent(index, inWindow).get(agentId) || new Map();
  const priced = costIndex(index, inWindow).get(agentId) || NO_COST;
  const totals = {
    sessions: 0,
    activeDays: 0,
    tokens: emptyTokens(),
    ...costFields(priced),
    ...(USAGE_SOURCES[agentId]?.reportedCost ? { reportedCostUsd: priced.reportedCostUsd ?? 0 } : {}),
  };
  for (const row of byDay.values()) {
    totals.sessions += row.sessions;
    if (row.sessions || row.tokens.total) totals.activeDays += 1;
    for (const field of FIELDS) totals.tokens[field] += row.tokens[field];
  }
  const projects = new Map();
  const addProject = (name, sessions, tokens) => {
    if (!name) return;
    const row = projects.get(name) || { name, sessions: 0, tokens: 0 };
    row.sessions += sessions;
    row.tokens += tokens;
    projects.set(name, row);
  };
  for (const entry of Object.values(index.files || {})) {
    if (entry.a !== agentId || !entry.p) continue;
    let sessions = 0;
    let tokens = 0;
    for (const [day, values] of Object.entries(entry.d || {})) {
      if (!inWindow(day)) continue;
      sessions += values[0];
      tokens += values[5];
    }
    if (sessions || tokens) addProject(entry.p, sessions, tokens);
  }
  for (const record of Object.values(index.records?.[agentId] || {})) {
    if (inWindow(record.d)) addProject(record.p, 1, record.t[4] || 0);
  }
  return {
    agentId,
    windowDays: days,
    index: indexStatus(index),
    totals,
    byModel: priced.byModel,
    series: dates.map((date) => {
      const row = byDay.get(date);
      return { date, sessions: row?.sessions || 0, tokens: row ? { ...row.tokens } : emptyTokens(), costUsd: roundUsd(priced.byDay.get(date)) };
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
    topProjects: [...projects.values()].sort((left, right) => right.tokens - left.tokens || right.sessions - left.sessions).slice(0, 20),
    sources: sourcesFor(agentId),
  };
}
