import { asArray, asOptionalString, asRecord, asString } from "./parse";
import { normalizeRemedy, type Remedy } from "./remedy";

/**
 * Agent 软件: the installed version of each agent app or CLI against the latest published one.
 * GET /api/agent-versions (checked once a day; "立即检查" posts /api/agent-versions/check).
 */

export type AgentVersionStatus = "up-to-date" | "update-available" | "unknown" | "error";

export interface AgentVersion {
  agentId: string;
  name: string;
  installed: { version: string; source: string | null; path: string | null } | null;
  latest: { version: string; source: string | null; url: string | null; releasedAt: string | null; notesUrl: string | null } | null;
  status: AgentVersionStatus;
  error: string | null;
  remedy: Remedy | null;
}

export interface AgentVersionsReport {
  checkedAt: string | null;
  nextCheckAt: string | null;
  offline: boolean;
  agents: AgentVersion[];
}

const STATUSES: AgentVersionStatus[] = ["up-to-date", "update-available", "unknown", "error"];

export const AGENT_VERSION_LABELS: Record<AgentVersionStatus, string> = {
  "update-available": "有新版本",
  "up-to-date": "已是最新",
  unknown: "无法判断",
  error: "检查失败",
};

export const AGENT_VERSION_TONES: Record<AgentVersionStatus, "info" | "ok" | "mute" | "danger"> = {
  "update-available": "info",
  "up-to-date": "ok",
  unknown: "mute",
  error: "danger",
};

/** Where a version number comes from, in plain words. Unknown ids show as given. */
const SOURCE_LABELS: Record<string, string> = {
  npm: "官方 npm",
  "npm-registry": "官方 npm",
  "app-update": "应用更新源",
  appcast: "应用更新源",
  sparkle: "应用更新源",
  "update-feed": "应用更新源",
  github: "GitHub 发布页",
  "github-release": "GitHub 发布页",
  homebrew: "Homebrew",
  brew: "Homebrew",
  pypi: "PyPI",
  website: "官网",
  "app-bundle": "应用信息",
  bundle: "应用信息",
  cli: "命令行 --version",
  binary: "命令行 --version",
  "package-json": "安装目录",
};

export function versionSourceLabel(source: string | null): string | null {
  if (!source) return null;
  return SOURCE_LABELS[source.toLowerCase()] || source;
}

const ORDER: Record<AgentVersionStatus, number> = { "update-available": 0, error: 1, unknown: 2, "up-to-date": 3 };

function normalizeAgent(value: unknown): AgentVersion | null {
  const record = asRecord(value);
  const agentId = asString(record.agentId);
  if (!agentId) return null;
  const installed = asRecord(record.installed);
  const latest = asRecord(record.latest);
  const status = asString(record.status) as AgentVersionStatus;
  return {
    agentId,
    name: asString(record.name, agentId),
    installed: asString(installed.version)
      ? { version: asString(installed.version), source: asOptionalString(installed.source), path: asOptionalString(installed.path) }
      : null,
    latest: asString(latest.version)
      ? {
          version: asString(latest.version),
          source: asOptionalString(latest.source),
          url: asOptionalString(latest.url),
          releasedAt: asOptionalString(latest.releasedAt),
          notesUrl: asOptionalString(latest.notesUrl),
        }
      : null,
    status: STATUSES.includes(status) ? status : "unknown",
    error: asOptionalString(record.error),
    remedy: normalizeRemedy(record.remedy),
  };
}

export function normalizeAgentVersions(raw: unknown): AgentVersionsReport {
  const record = asRecord(raw);
  const agents = asArray(record.agents)
    .map(normalizeAgent)
    .filter((agent): agent is AgentVersion => Boolean(agent))
    .sort((left, right) => ORDER[left.status] - ORDER[right.status]);
  return {
    checkedAt: asOptionalString(record.checkedAt),
    nextCheckAt: asOptionalString(record.nextCheckAt),
    offline: record.offline === true,
    agents,
  };
}

/** For the sidebar badge and the home hint. */
export function agentsWithUpdates(report: AgentVersionsReport | undefined | null, among?: readonly string[]): AgentVersion[] {
  if (!report) return [];
  return report.agents.filter((agent) => agent.status === "update-available" && (!among || among.includes(agent.agentId)));
}

/** Apps without commands update themselves: "在 Codex 里检查更新". */
export const inAppHint = (name: string) => `在 ${name} 里检查更新`;
