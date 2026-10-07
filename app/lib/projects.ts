import { normalizeCost, type Cost } from "./cost";
import { asArray, asNumber, asOptionalString, asRecord, asString } from "./parse";

/**
 * Project costs (docs/ARCHITECTURE.md · 项目费用). A project is the last segment of a working
 * folder, so same-named folders in different places merge; null means no folder was recorded.
 */

export const UNKNOWN_PROJECT = "未识别项目";
export const PROJECT_NOTE = "项目按文件夹名区分，不同位置的同名文件夹会合并";

export interface ProjectModel {
  model: string;
  name: string;
  costUsd: number;
}

export interface ProjectRow extends Cost {
  /** Folder name, or null for sessions without one (shown as 未识别项目). */
  name: string | null;
  sessions: number;
  sessionsStarted: number;
  tokens: number;
  tokenSplit: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number } | null;
  agents: { agentId: string; tokens: number; costUsd: number }[];
  topModels: ProjectModel[];
}

export interface OtherProjects {
  count: number;
  costUsd: number;
  tokens: number;
}

export interface ProjectsReport {
  /** Null for 所有时间. */
  days: number | null;
  totals: Cost;
  projects: ProjectRow[];
  other: OtherProjects | null;
}

export const projectLabel = (name: string | null) => name || UNKNOWN_PROJECT;

export function normalizeOtherProjects(value: unknown): OtherProjects | null {
  const record = asRecord(value);
  const count = asNumber(record.count);
  return count > 0 ? { count, costUsd: asNumber(record.costUsd), tokens: asNumber(record.tokens) } : null;
}

export function normalizeProject(value: unknown): ProjectRow {
  const record = asRecord(value);
  const split = asRecord(record.tokenSplit);
  const tokens = typeof record.tokens === "object" && record.tokens ? asNumber(asRecord(record.tokens).total) : asNumber(record.tokens);
  return {
    ...normalizeCost(record),
    name: asOptionalString(record.name),
    sessions: asNumber(record.sessions),
    sessionsStarted: asNumber(record.sessionsStarted, asNumber(record.sessions)),
    tokens,
    tokenSplit: Object.keys(split).length
      ? {
          input: asNumber(split.input),
          output: asNumber(split.output),
          cacheRead: asNumber(split.cacheRead),
          cacheWrite: asNumber(split.cacheWrite),
          cacheWrite1h: asNumber(split.cacheWrite1h),
        }
      : null,
    agents: asArray(record.agents)
      .map((item) => {
        const agent = asRecord(item);
        return { agentId: asString(agent.agentId), tokens: asNumber(agent.tokens), costUsd: asNumber(agent.costUsd) };
      })
      .filter((agent) => agent.agentId),
    topModels: asArray(record.topModels)
      .map((item) => {
        const model = asRecord(item);
        return { model: asString(model.model), name: asString(model.name, asString(model.model)), costUsd: asNumber(model.costUsd) };
      })
      .filter((model) => model.model),
  };
}

/** Most expensive first, then by tokens; folders without a name sort like any other project. */
export function sortProjects(projects: ProjectRow[]): ProjectRow[] {
  return [...projects].sort(
    (left, right) =>
      (right.costUsd || 0) - (left.costUsd || 0) || right.tokens - left.tokens || projectLabel(left.name).localeCompare(projectLabel(right.name)),
  );
}

export function normalizeProjectList(value: unknown): ProjectRow[] {
  return sortProjects(asArray(value).map(normalizeProject));
}

export function normalizeProjectsReport(raw: unknown, days: number | null = 30): ProjectsReport {
  const record = asRecord(raw);
  return {
    days: record.windowDays === null || days === null ? null : asNumber(record.windowDays, days),
    totals: normalizeCost(record.totals),
    projects: normalizeProjectList(record.projects),
    other: normalizeOtherProjects(record.other),
  };
}

/** "Claude Opus 5.5、GPT-6.1 Sol" — the models a project spent most on. */
export const topModelNames = (project: Pick<ProjectRow, "topModels">, count = 2) =>
  project.topModels
    .slice(0, count)
    .map((model) => model.name)
    .join("、");
