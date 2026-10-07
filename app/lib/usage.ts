import { normalizeCost, normalizeModelRows, type CostSplit, type ModelRow } from "./cost";
import { normalizeOtherProjects, normalizeProjectList, type OtherProjects, type ProjectRow } from "./projects";
import { windowLabel } from "./usage-window";
import {
  asArray,
  asNumber,
  asOptionalNumber,
  asOptionalString,
  asRecord,
  asString,
  pick,
  type UnknownRecord,
} from "./parse";

/**
 * Normalizers for /api/usage/* (docs/ARCHITECTURE.md · 洞察接口 · 用量分析).
 * Tolerant of missing fields so an older or newer service never breaks the page.
 */

export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface UsagePoint {
  date: string;
  /** Sessions active that day (a long session counts on every day it was used). */
  sessions: number;
  /** Sessions that started that day (adds up across days). */
  sessionsStarted: number;
  tokens: number;
  /** Estimated cost that day at official prices (0 when the service doesn't report it). */
  costUsd: number;
}

export interface UsageSource {
  id: string;
  label: string;
  confidence: string | null;
}

export interface UsageAgent {
  agentId: string;
  /** Sessions with any activity in the window, including ones started earlier. */
  sessions: number;
  /** Sessions that started in the window. */
  sessionsStarted: number;
  activeDays: number;
  tokens: UsageTokens | null;
  /** Estimated at official API prices (see lib/cost). */
  costUsd: number | null;
  costBasis: CostSplit | null;
  unpricedTokens: number;
  /** Hermes / OpenClaw / QClaw: the figure the product records itself. */
  reportedCostUsd: number | null;
  byModel: ModelRow[];
  credits: number | null;
  series: UsagePoint[];
  sources: UsageSource[];
}

export interface TopSkill {
  name: string;
  count: number;
  tokens: number;
  byAgent: Record<string, number>;
  confidenceByAgent: Record<string, string>;
  lastUsedAt: string | null;
  confidence: string | null;
}

export interface UsageIndex {
  complete: boolean;
  updatedAt: string | null;
  indexedFiles: number;
  totalFiles: number;
}

export type IndexState = "idle" | "indexing" | "partial" | "complete" | "error" | "unknown";

export interface UsageStatus {
  state: IndexState;
  indexedFiles: number;
  totalFiles: number;
  updatedAt: string | null;
  lastRunAt: string | null;
  error: string | null;
}

export interface UsageSummary {
  /** Window length; null for 所有时间. */
  days: number | null;
  windowLabel: string;
  generatedAt: string | null;
  index: UsageIndex | null;
  status: UsageStatus | null;
  agents: UsageAgent[];
  topSkills: TopSkill[];
}

/** Hover note on session counts: "sessions" means active in the window since the backend change. */
export const SESSIONS_HINT = "期间有活动的会话，含更早开始、仍在用的";

export const CONFIDENCE_LABELS: Record<string, string> = {
  exact: "精确",
  inferred: "推断",
  reported: "产品自报",
};

export const CONFIDENCE_HINTS: Record<string, string> = {
  exact: "从会话记录逐条统计",
  inferred: "从会话里读取 SKILL.md 的动作推断",
  reported: "产品自己记录的数字",
};

export function confidenceLabel(value: string | null | undefined): string {
  if (!value) return "来源未注明";
  return CONFIDENCE_LABELS[value] || value;
}

function normalizeTokens(value: unknown): UsageTokens | null {
  if (typeof value === "number") return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: value };
  const record = asRecord(value);
  if (!Object.keys(record).length) return null;
  const input = asNumber(record.input);
  const output = asNumber(record.output);
  const cacheRead = asNumber(record.cacheRead);
  const cacheWrite = asNumber(record.cacheWrite);
  return { input, output, cacheRead, cacheWrite, total: asNumber(record.total, input + output + cacheRead + cacheWrite) };
}

const tokenTotal = (value: unknown) => (typeof value === "object" && value ? asNumber(asRecord(value).total) : asNumber(value));

function normalizeSeries(value: unknown): UsagePoint[] {
  return asArray(value)
    .map((item) => {
      const point = asRecord(item);
      return {
        date: asString(point.date),
        sessions: asNumber(pick(point, "sessions", "count")),
        sessionsStarted: asNumber(point.sessionsStarted, asNumber(pick(point, "sessions", "count"))),
        tokens: tokenTotal(point.tokens),
        costUsd: asNumber(point.costUsd),
      };
    })
    .filter((point) => /^\d{4}-\d{2}-\d{2}/.test(point.date))
    .sort((left, right) => left.date.localeCompare(right.date));
}

function normalizeSources(value: unknown): UsageSource[] {
  return asArray(value)
    .map((item) => {
      const source = asRecord(item);
      return { id: asString(source.id), label: asString(source.label), confidence: asOptionalString(source.confidence) };
    })
    .filter((source) => source.id || source.label);
}

export function normalizeUsageAgent(value: unknown, fallbackId = ""): UsageAgent {
  const record = asRecord(value);
  const totals = asRecord(record.totals);
  const base = Object.keys(totals).length ? totals : record;
  const cost = normalizeCost(base);
  return {
    agentId: asString(pick(record, "agentId", "id"), fallbackId),
    sessions: asNumber(base.sessions),
    sessionsStarted: asNumber(base.sessionsStarted, asNumber(base.sessions)),
    activeDays: asNumber(base.activeDays),
    tokens: normalizeTokens(base.tokens),
    costUsd: cost.costUsd,
    costBasis: cost.costBasis,
    unpricedTokens: cost.unpricedTokens,
    reportedCostUsd: asOptionalNumber(base.reportedCostUsd),
    byModel: normalizeModelRows(record.byModel),
    credits: asOptionalNumber(pick(base, "credits")),
    series: normalizeSeries(record.series),
    sources: normalizeSources(record.sources),
  };
}

function normalizeTopSkill(value: unknown, agentFallback = ""): TopSkill | null {
  const record = asRecord(value);
  const name = asString(pick(record, "name", "skillName"));
  if (!name) return null;
  const byAgent: Record<string, number> = {};
  const confidenceByAgent: Record<string, string> = {};
  for (const entry of asArray(record.agents).map(asRecord)) {
    const agentId = asString(entry.agentId);
    if (!agentId) continue;
    byAgent[agentId] = asNumber(entry.count);
    const confidence = asOptionalString(entry.confidence);
    if (confidence) confidenceByAgent[agentId] = confidence;
  }
  const count = asNumber(record.count, Object.values(byAgent).reduce((sum, item) => sum + item, 0));
  const single = asString(record.agentId, agentFallback);
  if (single && byAgent[single] === undefined) byAgent[single] = count;
  const confidence = asOptionalString(record.confidence);
  if (single && confidence && !confidenceByAgent[single]) confidenceByAgent[single] = confidence;
  return {
    name,
    count,
    tokens: tokenTotal(record.tokens),
    byAgent,
    confidenceByAgent,
    lastUsedAt: asOptionalString(record.lastUsedAt),
    confidence,
  };
}

export function normalizeTopSkills(value: unknown, agentFallback = ""): TopSkill[] {
  return asArray(value)
    .map((item) => normalizeTopSkill(item, agentFallback))
    .filter((item): item is TopSkill => Boolean(item))
    .sort((left, right) => right.count - left.count);
}

function normalizeIndex(value: unknown): UsageIndex | null {
  const record = asRecord(value);
  if (!Object.keys(record).length) return null;
  return {
    complete: record.complete === true,
    updatedAt: asOptionalString(record.updatedAt),
    indexedFiles: asNumber(record.indexedFiles),
    totalFiles: asNumber(record.totalFiles),
  };
}

const INDEX_STATES: IndexState[] = ["idle", "indexing", "partial", "complete", "error"];

export function normalizeUsageStatus(raw: unknown): UsageStatus | null {
  const record = asRecord(raw);
  if (!Object.keys(record).length) return null;
  const state = asString(record.state) as IndexState;
  return {
    state: INDEX_STATES.includes(state) ? state : "unknown",
    indexedFiles: asNumber(record.indexedFiles),
    totalFiles: asNumber(record.totalFiles),
    updatedAt: asOptionalString(record.updatedAt),
    lastRunAt: asOptionalString(record.lastRunAt),
    error: asOptionalString(record.error),
  };
}

/** True while the first index is still being built (numbers will grow). */
export function isIndexing(status: UsageStatus | null, index?: UsageIndex | null): boolean {
  // A quick incremental refresh of a finished index is not worth a progress banner.
  if (index?.complete) return false;
  if (status && (status.state === "indexing" || status.state === "partial")) return true;
  return Boolean(index && !index.complete && index.totalFiles > 0);
}

/** Poll only while the background index is actively running (not when partial or done). */
export function shouldPollUsage(status: UsageStatus | null, index?: UsageIndex | null): boolean {
  if (index?.complete) return false;
  return status?.state === "indexing";
}

export function indexProgress(status: UsageStatus | null, index?: UsageIndex | null) {
  const indexed = status?.indexedFiles || index?.indexedFiles || 0;
  const total = status?.totalFiles || index?.totalFiles || 0;
  return { indexed, total, ratio: total ? Math.min(1, indexed / total) : 0 };
}

function agentList(value: unknown): UnknownRecord[] {
  if (Array.isArray(value)) return value.map(asRecord);
  return Object.entries(asRecord(value)).map(([agentId, entry]) => ({ agentId, ...asRecord(entry) }));
}

export function normalizeUsageSummary(raw: unknown, days: number | null = 30): UsageSummary {
  const record = asRecord(raw);
  // 所有时间: the service answers windowDays null (and windowLabel "所有时间").
  const windowDays = record.windowDays === null || days === null ? null : asNumber(pick(record, "windowDays", "days"), days);
  return {
    days: windowDays,
    windowLabel: windowLabel(windowDays, asOptionalString(record.windowLabel)),
    generatedAt: asOptionalString(record.generatedAt),
    index: normalizeIndex(record.index),
    status: normalizeUsageStatus(record.status),
    agents: agentList(record.agents)
      .map((entry) => normalizeUsageAgent(entry))
      .filter((entry) => entry.agentId),
    topSkills: normalizeTopSkills(record.topSkills),
  };
}

export interface SkillUsageAgent {
  agentId: string;
  total: number;
  tokens: number;
  lastUsedAt: string | null;
  confidence: string | null;
  reportedTotal: number | null;
  /** Estimated cost of the attributed tokens; null when nothing was attributed. */
  costUsd: number | null;
  costBasis: CostSplit | null;
  series: { date: string; count: number }[];
}

export interface SkillUsage {
  name: string;
  days: number;
  status: UsageStatus | null;
  index: UsageIndex | null;
  agents: SkillUsageAgent[];
}

export function normalizeSkillUsage(raw: unknown, name: string): SkillUsage {
  const record = asRecord(raw);
  return {
    name: asString(record.name, name),
    days: asNumber(record.windowDays, 90),
    status: normalizeUsageStatus(record.status),
    index: normalizeIndex(record.index),
    agents: asArray(record.agents).map((item) => {
      const entry = asRecord(item);
      return {
        agentId: asString(entry.agentId),
        total: asNumber(pick(entry, "total", "count")),
        tokens: tokenTotal(entry.tokens),
        lastUsedAt: asOptionalString(entry.lastUsedAt),
        confidence: asOptionalString(entry.confidence),
        reportedTotal: asOptionalNumber(entry.reportedTotal),
        costUsd: asOptionalNumber(entry.costUsd),
        costBasis: normalizeCost(entry).costBasis,
        series: asArray(entry.series)
          .map((point) => ({ date: asString(asRecord(point).date), count: asNumber(asRecord(point).count) }))
          .filter((point) => point.date),
      };
    }),
  };
}

export interface AgentUsage extends UsageAgent {
  days: number;
  status: UsageStatus | null;
  index: UsageIndex | null;
  topSkills: TopSkill[];
  /** By cost; the rest are summed in `otherProjects` so the list reconciles with the totals. */
  topProjects: ProjectRow[];
  otherProjects: OtherProjects | null;
}

export function normalizeAgentUsage(raw: unknown, agentId: string): AgentUsage {
  const record = asRecord(raw);
  return {
    ...normalizeUsageAgent(record, agentId),
    days: asNumber(record.windowDays, 90),
    status: normalizeUsageStatus(record.status),
    index: normalizeIndex(record.index),
    topSkills: normalizeTopSkills(record.topSkills, agentId),
    topProjects: normalizeProjectList(record.topProjects),
    otherProjects: normalizeOtherProjects(record.otherProjects),
  };
}

/** One point per day across the window (local dates), zero-filled. */
export function fillSeries(series: UsagePoint[], days: number, endDate: string): UsagePoint[] {
  const byDate = new Map(series.map((point) => [point.date.slice(0, 10), point]));
  const match = endDate.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return series;
  const end = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const filled: UsagePoint[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(end - offset * 86_400_000).toISOString().slice(0, 10);
    filled.push(byDate.get(day) || { date: day, sessions: 0, sessionsStarted: 0, tokens: 0, costUsd: 0 });
  }
  return filled;
}

/** Local calendar date (YYYY-MM-DD) of a timestamp; the service buckets days locally. */
export function localDate(value: number | string | null | undefined): string {
  const date = value === null || value === undefined ? null : new Date(value);
  if (!date || Number.isNaN(date.getTime())) return "";
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
