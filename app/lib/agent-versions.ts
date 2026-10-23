import { asArray, asOptionalString, asRecord, asString } from "./parse";
import { normalizeRemedy, type Remedy } from "./remedy";

/**
 * Agent 软件: the installed version of each agent app or CLI against the latest published one.
 * GET /api/agent-versions (checked once a day; "立即检查" posts /api/agent-versions/check).
 */

export type AgentVersionStatus = "up-to-date" | "update-available" | "unknown" | "error";

export interface AgentVersion {
  /** Row id, e.g. "codex-cli" / "codex-app" (one Agent can have several). */
  id: string;
  agentId: string;
  name: string;
  /** The copy that runs (first on PATH) when several are installed. */
  active: boolean;
  /** Why there is no comparison, from the service. */
  reason: string | null;
  /** A desktop app the service can open (open -b) so it checks for updates itself. */
  openApp: boolean;
  downloadUrl: string | null;
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
    id: asString(record.id) || agentId,
    agentId,
    name: asString(record.name, agentId),
    active: record.active !== false,
    reason: asOptionalString(record.reason),
    openApp: Boolean(asRecord(record.openApp).bundleId) || record.openApp === true,
    downloadUrl: asOptionalString(record.downloadUrl),
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

/** One-click update (POST /api/agent-versions/plan → apply). Programs and args stay server-side. */
export interface AgentUpdatePlan {
  planId: string;
  expiresAt: string | null;
  title: string;
  steps: { display: string }[];
  effects: string[];
  afterCheck: string | null;
}

export interface AgentUpdateResult {
  ok: boolean;
  steps: { display: string; exitCode: number | null; output: string }[];
  version: { before: string | null; after: string | null };
  historyId: string | null;
}

export function normalizeUpdatePlan(raw: unknown): AgentUpdatePlan | null {
  const record = asRecord(raw);
  const planId = asString(record.planId);
  if (!planId) return null;
  const afterCheck = record.afterCheck;
  return {
    planId,
    expiresAt: asOptionalString(record.expiresAt),
    title: asString(record.title, "更新"),
    steps: asArray(record.steps)
      .map((item) => ({ display: asString(asRecord(item).display) }))
      .filter((step) => step.display),
    effects: asArray(record.effects).map((item) => asString(item)).filter(Boolean),
    afterCheck: typeof afterCheck === "string" ? afterCheck || null : afterCheck ? asString(asRecord(afterCheck).display) || "完成后重新检查版本" : null,
  };
}

export function normalizeUpdateResult(raw: unknown): AgentUpdateResult {
  const record = asRecord(raw);
  const version = asRecord(record.version);
  return {
    ok: record.ok === true,
    steps: asArray(record.steps).map((item) => {
      const step = asRecord(item);
      return {
        display: asString(step.display),
        exitCode: typeof step.exitCode === "number" ? step.exitCode : null,
        output: asString(step.output),
      };
    }),
    version: { before: asOptionalString(version.before), after: asOptionalString(version.after) },
    historyId: asOptionalString(record.historyId),
  };
}

/** The agent-update action on a version's remedy, if the service offers one. */
export const oneClickUpdate = (agent: AgentVersion) => (agent.remedy?.action?.kind === "agent-update" ? agent.remedy.action.id || agent.id : null);

/** A one-click update running in the background (GET /api/agent-versions/jobs/:id). */
export interface AgentUpdateJob {
  id: string;
  status: "running" | "done" | "error";
  /** Steps finished and steps in total, when the service says. */
  done: number | null;
  total: number | null;
  /** What is running now. */
  step: string | null;
  startedAt: number | null;
  result: AgentUpdateResult | null;
  error: string | null;
  /** The last ~2 KB of output, scrubbed by the service. */
  outputTail: string | null;
}

export function normalizeUpdateJob(raw: unknown, fallbackId = ""): AgentUpdateJob {
  const record = asRecord(raw);
  const statusText = asString(record.status || record.state).toLowerCase();
  const status: AgentUpdateJob["status"] = /done|finish|success|complete|ok/u.test(statusText) ? "done" : /error|fail/u.test(statusText) ? "error" : "running";
  const steps = asArray(record.steps).map(asRecord);
  const finishedSteps = steps.filter((step) => typeof step.exitCode === "number").length;
  // `step` is the running step's index (or its text in older services).
  const index = typeof record.step === "number" ? record.step : null;
  const doneCount = typeof record.done === "number" ? record.done : index !== null ? index : steps.length ? finishedSteps : null;
  const total = typeof record.total === "number" ? record.total : steps.length || null;
  const current = asRecord(record.current);
  const step =
    (typeof record.step === "string" ? record.step : null) ||
    asOptionalString(current.display) ||
    (doneCount !== null && steps[doneCount] ? asOptionalString(steps[doneCount].display) : null);
  const started = Date.parse(asString(record.startedAt));
  const version = asRecord(record.version);
  const result =
    status === "running"
      ? null
      : record.result
        ? normalizeUpdateResult(record.result)
        : {
            ok: status === "done",
            steps: steps.map((item) => ({
              display: asString(item.display),
              exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
              output: asString(item.output),
            })),
            version: { before: asOptionalString(version.before), after: asOptionalString(version.after) },
            historyId: null,
          };
  return {
    id: asString(record.jobId || record.id, fallbackId),
    status,
    done: doneCount,
    total,
    step,
    startedAt: Number.isFinite(started) ? started : null,
    result,
    error: asOptionalString(record.error) || (status === "error" ? asOptionalString(asRecord(record.result).error) : null),
    outputTail: asOptionalString(record.outputTail),
  };
}
