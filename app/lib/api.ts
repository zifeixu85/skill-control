import { normalizeAgentFile, normalizeAgentFiles, normalizeAgentTools } from "./agent-extras";
import { normalizeAgentVersions, normalizeUpdateJob, normalizeUpdatePlan, normalizeUpdateResult } from "./agent-versions";
import { normalizeDiscovery } from "./discovery";
import { normalizeSecrets } from "./secrets";
import { normalizeTotals } from "./totals";
import { resolveApiBase } from "./api-base";
import { normalizeCliApply, normalizeCliInventory, normalizeCliPlan } from "./cli-tools";
import { normalizeModelsReport } from "./cost";
import { normalizeHealthReport } from "./health";
import { normalizePricing } from "./pricing";
import { normalizeProjectsReport } from "./projects";
import { normalizeHistory, normalizeRestorePlan, normalizeTrash, normalizeUninstallPlan } from "./history";
import { normalizeAutoLink, normalizeLibrary, normalizeLibraryApply, normalizeLibraryPlan, type AutoLinkScope, type LibraryAction } from "./library";
import { normalizeInstallPlan, normalizeInstallResult } from "./install-plan";
import { normalizeDiffFile, normalizeSkillDiff } from "./skill-diff";
import { normalizeCompanion, normalizeLauncher } from "./integration";
import {
  normalizeApply,
  normalizeChanges,
  normalizeCheckJob,
  normalizePlan,
  normalizeUpdates,
  type ConflictChoice,
} from "./updates";
import type {
  AgentActivity,
  CapabilityCatalog,
  ConfigDetail,
  FileContent,
  FileListing,
  ImportedSkill,
  IntegrationsData,
  ManagerConfig,
  ScanData,
  SyncMode,
  SyncPlan,
} from "./types";
import {
  normalizeAgentUsage,
  normalizeSkillUsage,
  normalizeUsageStatus,
  normalizeUsageSummary,
} from "./usage";

declare global {
  interface Window {
    skillManagerDesktop?: {
      apiBase?: string;
      openExternal?: (url: string) => Promise<unknown>;
      /** Resolves true when copied (the packaged app can't use navigator.clipboard). */
      copyText?: (text: string) => Promise<boolean>;
    };
  }
}

/** Only referenced through `process.env.NEXT_PUBLIC_…`, which Vite inlines at build time. */
function developmentApiBase(): string | undefined {
  try {
    return process.env.NEXT_PUBLIC_SKILL_MANAGER_API_BASE;
  } catch {
    return undefined;
  }
}

function isDevelopment(): boolean {
  try {
    return process.env.NODE_ENV !== "production";
  } catch {
    return false;
  }
}

let cachedBase: string | null = null;

export function apiBase(): string {
  if (typeof window === "undefined") {
    return resolveApiBase({ development: false });
  }
  cachedBase ||= resolveApiBase({
    desktopBase: window.skillManagerDesktop?.apiBase,
    envBase: developmentApiBase(),
    development: isDevelopment(),
  });
  return cachedBase;
}

export class ApiError extends Error {
  readonly status: number;
  /** The route itself does not exist on this service version. */
  readonly unsupported: boolean;
  /** No answer within the time limit; for a write the outcome is unknown. */
  readonly timedOut: boolean;
  /** Machine-readable reason from the service (e.g. "stale-plan"); null from older services. */
  readonly code: string | null;
  /** The rest of the error body (e.g. `skills` with code "multiple-skills"). */
  readonly details: Record<string, unknown>;

  constructor(message: string, status: number, unsupported = false, timedOut = false, code: string | null = null, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.unsupported = unsupported;
    this.timedOut = timedOut;
    this.code = code;
    this.details = details;
  }
}

/** Time limits per call type, so no state can hang forever. */
export const TIMEOUTS = {
  read: 120_000,
  plan: 30_000,
  updatePlan: 90_000,
  apply: 120_000,
  updateApply: 360_000,
  /** Several steps of up to 5 minutes each. */
  agentUpdate: 900_000,
} as const;

const ROUTE_MISSING = "接口不存在。";
const ERROR_CODE = /^[a-z][a-z0-9-]{1,40}$/u;

async function errorFrom(response: Response): Promise<ApiError> {
  let message = `本地服务返回了错误（${response.status}）。`;
  let code: string | null = null;
  let details: Record<string, unknown> = {};
  try {
    const payload = (await response.json()) as { error?: unknown; code?: unknown };
    if (typeof payload?.error === "string" && payload.error) message = payload.error;
    if (typeof payload?.code === "string" && ERROR_CODE.test(payload.code)) code = payload.code;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      details = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "error" && key !== "code"));
    }
  } catch {
    // Non-JSON error bodies keep the generic message.
  }
  const unsupported = response.status === 404 && (code === "route-missing" || (code === null && message === ROUTE_MISSING));
  return new ApiError(message, response.status, unsupported, false, code, details);
}

function url(pathname: string, params?: Record<string, string | number | boolean | null | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== null && value !== undefined && value !== "") search.set(key, String(value));
  }
  const query = search.toString();
  return `${apiBase()}${pathname}${query ? `?${query}` : ""}`;
}

function networkError(timedOut: boolean, timeoutMs: number): ApiError {
  return timedOut
    ? new ApiError(`本地服务 ${Math.round(timeoutMs / 1000)} 秒没有响应。`, 0, false, true)
    : new ApiError("连不上本地服务。请确认 Skill Control 正在运行。", 0);
}

/** One request with a time limit that also covers reading the body. */
async function send<T>(
  target: string,
  init: RequestInit,
  timeoutMs: number,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(target, { ...init, signal: controller.signal });
    } catch {
      throw networkError(controller.signal.aborted, timeoutMs);
    }
    if (!response.ok) throw await errorFrom(response);
    try {
      return await read(response);
    } catch (error) {
      if (controller.signal.aborted) throw networkError(true, timeoutMs);
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }
}

const json = <T>(response: Response) => response.json() as Promise<T>;

function getJson<T>(pathname: string, params?: Parameters<typeof url>[1]): Promise<T> {
  return send(url(pathname, params), {}, TIMEOUTS.read, json<T>);
}

function sendJson<T>(
  method: "POST" | "PUT",
  pathname: string,
  body: unknown,
  options: { confirm?: boolean; timeout?: number } = {},
): Promise<T> {
  return send(
    url(pathname),
    {
      method,
      headers: {
        "content-type": "application/json",
        ...(options.confirm ? { "x-skill-manager-confirm": "yes" } : {}),
      },
      body: JSON.stringify(body),
    },
    options.timeout ?? TIMEOUTS.read,
    json<T>,
  );
}

const PLAN = { timeout: TIMEOUTS.plan };
const WRITE = { confirm: true, timeout: TIMEOUTS.apply };

const force = (value?: boolean) => (value ? { force: 1 } : undefined);

const isList = (value: unknown) => Array.isArray(value);

/** Guards the core payloads so a mismatched service shows one clear message, not TypeErrors. */
function expectShape<T>(value: unknown, what: string, ...lists: string[]): T {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (!record || !lists.every((key) => isList(record[key]))) {
    throw new ApiError(`服务版本不匹配：本地服务返回的${what}格式和界面不一致。请把 Skill Control 更新到同一版本。`, 200);
  }
  return value as T;
}

export const api = {
  scan: async (refresh?: boolean) =>
    expectShape<ScanData>(await getJson<unknown>("/api/scan", force(refresh)), "技能扫描", "skills", "agents"),
  config: async () => expectShape<ManagerConfig>(await getJson<unknown>("/api/config"), "配置", "agents", "visibleAgentIds"),
  saveConfig: async (config: ManagerConfig) =>
    expectShape<ManagerConfig>(await sendJson<unknown>("PUT", "/api/config", config), "配置", "agents", "visibleAgentIds"),
  integrations: async (refresh?: boolean) =>
    expectShape<IntegrationsData>(
      await getJson<unknown>("/api/integrations", force(refresh)),
      "插件与 MCP",
      "plugins",
      "connectors",
      "mcpServers",
      "mcpMatrix",
    ),
  capabilities: async (refresh?: boolean) =>
    expectShape<CapabilityCatalog>(await getJson<unknown>("/api/capabilities", force(refresh)), "专家", "products"),
  activity: (refresh?: boolean) => getJson<AgentActivity>("/api/agents/activity", force(refresh)),
  configDetail: (kind: string, id: string, instance?: string) =>
    getJson<ConfigDetail>("/api/config-detail", { kind, id, instance }),

  skillFiles: (instanceId: string) => getJson<FileListing>("/api/skill-files", { instanceId }),
  skillFile: (instanceId: string, path: string) =>
    getJson<FileContent>("/api/skill-file", { instanceId, path }),
  capabilityFiles: (capabilityId: string) =>
    getJson<FileListing>("/api/capability-files", { capabilityId }),
  capabilityFile: (capabilityId: string, path: string) =>
    getJson<FileContent>("/api/capability-file", { capabilityId, path }),
  importFile: (importId: string, path: string) => getJson<FileContent>("/api/import-file", { importId, path }),

  planSync: (input: { sourceInstanceId: string; targetAgentIds: string[]; mode: SyncMode }) =>
    sendJson<SyncPlan>("POST", "/api/sync", { ...input, dryRun: true }, PLAN),
  executeSync: (input: { sourceInstanceId: string; targetAgentIds: string[]; mode: SyncMode }) =>
    sendJson<SyncPlan>("POST", "/api/sync", { ...input, dryRun: false, confirm: true }, WRITE),
  planImport: (importId: string, targetAgentIds: string[]) =>
    sendJson<SyncPlan>("POST", "/api/import-install", { importId, targetAgentIds, dryRun: true }, PLAN),
  executeImport: (importId: string, targetAgentIds: string[]) =>
    sendJson<SyncPlan>(
      "POST",
      "/api/import-install",
      { importId, targetAgentIds, dryRun: false, confirm: true },
      WRITE,
    ),
  /**
   * v0.3: one install flow for every entry point. `source` is { importId } | { instanceId } |
   * { library }; scope "primary" | "agents" | "agent-only"; the service picks library or per-Agent.
   */
  planInstall: async (body: { source: Record<string, string>; scope: string; agentIds?: string[]; choices?: Record<string, string> }) =>
    normalizeInstallPlan(await sendJson<unknown>("POST", "/api/install/plan", body, PLAN)),
  applyInstall: async (planId: string) => normalizeInstallResult(await sendJson<unknown>("POST", "/api/install/apply", { planId, confirm: true }, WRITE)),
  /** A .skill / .zip package; `root` picks one skill when the package holds several (409 multiple-skills). */
  importSkill: (file: File, root?: string | null) =>
    send(
      url("/api/import-skill"),
      {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-skill-filename": encodeURIComponent(file.name),
          ...(root ? { "x-skill-root": encodeURIComponent(root) } : {}),
        },
        body: file,
      },
      TIMEOUTS.read,
      json<ImportedSkill>,
    ),
  /** v0.3 desktop: a folder the user picked in the system dialog (full path), staged like a package. */
  importFolder: (path: string, root?: string | null) =>
    sendJson<ImportedSkill>("POST", "/api/import-folder", { path, ...(root ? { root } : {}) }),
  exportSkill: (instanceId: string, format: "skill" | "zip") =>
    send(url("/api/export-skill", { instanceId, format }), {}, TIMEOUTS.read, (response) => response.blob()),
  reveal: (instanceId: string) => sendJson<{ ok: boolean }>("POST", "/api/reveal", { instanceId }),
  /** 版本不同: which files differ between two copies of one skill (left = newer). */
  skillDiff: async (leftInstanceId: string, rightInstanceId: string) =>
    normalizeSkillDiff(await getJson<unknown>("/api/skill-diff", { leftInstanceId, rightInstanceId })),
  skillDiffFile: async (leftInstanceId: string, rightInstanceId: string, path: string) =>
    normalizeDiffFile(await getJson<unknown>("/api/skill-diff-file", { leftInstanceId, rightInstanceId, path })),
  /** 设置 → 数据与隐私: open ~/.agent-skill-manager in the file manager (v0.3). */
  revealDataDir: () => sendJson<{ ok: boolean; opened?: boolean; path?: string }>("POST", "/api/reveal", { target: "data-dir" }),
  fetchBlob: (target: string) => send(target, {}, TIMEOUTS.read, (response) => response.blob()),

  // Endpoints added by newer services; callers feature-detect `ApiError.unsupported`.
  agentFiles: async (agent: string, options: { profile?: string | null; agentId?: string | null } = {}) =>
    normalizeAgentFiles(
      await getJson<unknown>("/api/agent-files", {
        agent,
        profile: options.profile,
        agentId: options.agentId,
      }),
    ),
  agentFile: async (id: string) => normalizeAgentFile(await getJson<unknown>("/api/agent-file", { id })),
  agentTools: async (agent: string) =>
    normalizeAgentTools(await getJson<unknown>("/api/agent-tools", { agent })),
  usageSummary: async (days: number | "all" = 30) =>
    normalizeUsageSummary(await getJson<unknown>("/api/usage/summary", { days }), days === "all" ? null : days),
  usageSkill: async (name: string, days = 90) =>
    normalizeSkillUsage(await getJson<unknown>("/api/usage/skill", { name, days }), name),
  usageAgent: async (id: string, days = 90) =>
    normalizeAgentUsage(await getJson<unknown>("/api/usage/agent", { id, days }), id),
  usageStatus: async () => normalizeUsageStatus(await getJson<unknown>("/api/usage/status")),
  usageModels: async (days: number | "all" = 30) =>
    normalizeModelsReport(await getJson<unknown>("/api/usage/models", { days }), days === "all" ? null : days),
  usagePricing: async () => normalizePricing(await getJson<unknown>("/api/usage/pricing")),
  usageProjects: async (days: number | "all" = 30) =>
    normalizeProjectsReport(await getJson<unknown>("/api/usage/projects", { days }), days === "all" ? null : days),
  updates: async () => normalizeUpdates(await getJson<unknown>("/api/updates")),
  checkUpdates: async (unitKeys?: string[]) =>
    normalizeCheckJob(await sendJson<unknown>("POST", "/api/updates/check", unitKeys?.length ? { unitKeys } : {})),
  checkStatus: async () => normalizeCheckJob(await getJson<unknown>("/api/updates/check-status")),
  updateChanges: async (unitKey: string) => normalizeChanges(await getJson<unknown>("/api/updates/changes", { unitKey })),
  planUpdate: async (unitKey: string, choice?: ConflictChoice) =>
    normalizePlan(
      await sendJson<unknown>("POST", "/api/updates/plan", choice ? { unitKey, choice } : { unitKey }, { timeout: TIMEOUTS.updatePlan }),
    ),
  applyUpdate: async (planId: string) =>
    normalizeApply(
      await sendJson<unknown>("POST", "/api/updates/apply", { planId, confirm: true }, { confirm: true, timeout: TIMEOUTS.updateApply }),
    ),
  library: async () => normalizeLibrary(await getJson<unknown>("/api/library")),
  libraryPlan: async (input: {
    action: LibraryAction;
    skill?: string;
    agents?: string[];
    choice?: string;
    choices?: Record<string, string>;
  }) => normalizeLibraryPlan(await sendJson<unknown>("POST", "/api/library/plan", input, PLAN)),
  libraryApply: async (planId: string) =>
    normalizeLibraryApply(await sendJson<unknown>("POST", "/api/library/apply", { planId, confirm: true }, WRITE)),
  /** 自动接入 on/off and scope; a config write, no confirm header. */
  setAutoLink: async (input: { enabled: boolean; scope: AutoLinkScope }) => {
    const raw = await sendJson<unknown>("POST", "/api/library/auto-link", input);
    return normalizeAutoLink(asRecordOf(raw).autoLink ?? raw);
  },
  /** The toast's 撤销 for one 自动接入 run; tombstones keep those pairs from coming back. */
  restoreAutoLink: async (historyId: string, skill?: string) =>
    sendJson<unknown>("POST", "/api/library/auto-link/undo", { historyId, ...(skill ? { skill } : {}), confirm: true }, WRITE),
  /** 补齐接入: the one-time plan for gaps that existed before 自动接入 was turned on (optionally some Agents only). */
  libraryCatchUpPlan: async (input: { agents?: string[]; choices?: Record<string, string> } = {}) =>
    normalizeLibraryPlan(
      await sendJson<unknown>(
        "POST",
        "/api/library/catch-up/plan",
        { ...(input.agents?.length ? { agents: input.agents } : {}), ...(input.choices && Object.keys(input.choices).length ? { choices: input.choices } : {}) },
        PLAN,
      ),
    ),
  libraryCatchUpApply: async (planId: string) =>
    normalizeLibraryApply(await sendJson<unknown>("POST", "/api/library/catch-up/apply", { planId, confirm: true }, WRITE)),
  /** 设置 → Agent 集成: the `skill-control` launcher in ~/.local/bin. */
  cliLauncher: async () => normalizeLauncher(await getJson<unknown>("/api/cli-launcher")),
  /** Writes or removes the launcher (never a file Skill Control didn't write). */
  applyCliLauncher: async (action: "install" | "uninstall") =>
    normalizeLauncher(await sendJson<unknown>("POST", `/api/cli-launcher/${action === "uninstall" ? "uninstall" : "install"}`, { confirm: true }, WRITE)),
  /** The bundled skill-control skill: in the library? who can use it? */
  companionSkill: async () => normalizeCompanion(await getJson<unknown>("/api/library/companion-skill")),
  /** Into the library, connected to the primary Agents (undoable). */
  applyCompanionSkill: async () => {
    const raw = await sendJson<unknown>("POST", "/api/library/companion-skill/install", { confirm: true }, WRITE);
    return { result: normalizeInstallResult({ mode: "library", ...asRecordOf(raw) }), status: normalizeCompanion(asRecordOf(raw).status) };
  },
  history: async (limit = 100) => normalizeHistory(await getJson<unknown>("/api/history", { limit })),
  planRestore: async (historyId: string, select?: string[] | null) =>
    normalizeRestorePlan(
      await sendJson<unknown>("POST", "/api/history/plan-restore", select ? { historyId, select } : { historyId }, PLAN),
    ),
  applyRestore: (planId: string) =>
    sendJson<Record<string, unknown>>("POST", "/api/history/apply-restore", { planId, confirm: true }, WRITE),
  planUninstall: async (skillId: string, agentId: string) =>
    normalizeUninstallPlan(await sendJson<unknown>("POST", "/api/skills/plan-uninstall", { skillId, agentId }, PLAN)),
  applyUninstall: (planId: string) =>
    sendJson<Record<string, unknown>>("POST", "/api/skills/apply-uninstall", { planId, confirm: true }, WRITE),
  trash: async () => normalizeTrash(await getJson<unknown>("/api/trash")),
  restoreTrash: (trashId: string) =>
    sendJson<{ trashId: string; name: string; path: string }>("POST", "/api/trash/restore", { trashId, confirm: true }, WRITE),
  cliTools: async () => normalizeCliInventory(await getJson<unknown>("/api/cli-tools")),
  cliPlan: async (toolId: string, fixId: string, agents?: string[]) =>
    normalizeCliPlan(
      await sendJson<unknown>("POST", "/api/cli-tools/plan", agents?.length ? { toolId, fixId, agents } : { toolId, fixId }, PLAN),
    ),
  cliApply: async (planId: string) =>
    normalizeCliApply(await sendJson<unknown>("POST", "/api/cli-tools/apply", { planId, confirm: true }, WRITE)),
  healthReport: async (refresh?: boolean) =>
    normalizeHealthReport(await getJson<unknown>("/api/health-report", force(refresh))),
  agentVersions: async () => normalizeAgentVersions(await getJson<unknown>("/api/agent-versions")),
  /** Checks now; answers with the fresh report, or null when it only acknowledged the request. */
  checkAgentVersions: async () => {
    const raw = await sendJson<unknown>("POST", "/api/agent-versions/check", {}, { timeout: TIMEOUTS.updatePlan });
    return Array.isArray((raw as { agents?: unknown } | null)?.agents) ? normalizeAgentVersions(raw) : null;
  },
  /** 一键更新: the plan first (what runs, what changes), nothing runs until apply. */
  /** null when the service answered without a plan id (never confirmable). */
  planAgentUpdate: async (id: string) => normalizeUpdatePlan(await sendJson<unknown>("POST", "/api/agent-versions/plan", { id }, PLAN)),
  applyAgentUpdate: async (planId: string) =>
    normalizeUpdateResult(
      await sendJson<unknown>("POST", "/api/agent-versions/apply", { planId, confirm: true }, { confirm: true, timeout: TIMEOUTS.agentUpdate }),
    ),
  /** Opens the user's terminal running the planned command; Skill Control doesn't wait for it. */
  applyAgentUpdateInTerminal: (planId: string) =>
    sendJson<Record<string, unknown>>("POST", "/api/agent-versions/terminal", { planId, confirm: true }, WRITE),
  /** Runs the plan in the background; poll agentUpdateJob(jobId). null when the service ran it right away or has no jobs. */
  applyAgentUpdateInBackground: async (planId: string) => {
    const raw = await sendJson<Record<string, unknown>>("POST", "/api/agent-versions/apply", { planId, confirm: true, background: true }, WRITE);
    return typeof raw?.jobId === "string" && raw.jobId ? raw.jobId : null;
  },
  agentUpdateJob: async (jobId: string) =>
    normalizeUpdateJob(await getJson<unknown>(`/api/agent-versions/jobs/${encodeURIComponent(jobId)}`), jobId),
  /** Opens a desktop app (open -b) so it checks for its own updates; changes no files. */
  openAgentApp: (id: string) => sendJson<{ opened?: boolean }>("POST", "/api/agent-versions/open", { id }),
  usageTotals: async () => normalizeTotals(await getJson<unknown>("/api/usage/totals")),
  secrets: async () => normalizeSecrets(await getJson<unknown>("/api/secrets")),
  discoverAgents: async () => normalizeDiscovery(await getJson<unknown>("/api/agents/discover")),
  acknowledgeAgents: (ids: string[]) => sendJson<unknown>("POST", "/api/agents/acknowledge", { ids }),
};

export const assetUrl = {
  skill: (instanceId: string, path: string) => url("/api/skill-asset", { instanceId, path }),
  capability: (capabilityId: string, path: string) =>
    url("/api/capability-asset", { capabilityId, path }),
  plugin: (id: string) => url("/api/plugin-asset", { id }),
  importAsset: (importId: string, path: string) => url("/api/import-asset", { importId, path }),
  expertAvatar: (id: string) => url("/api/expert-avatar", { id }),
  agentIcon: (id: string) => url("/api/agent-icon", { id }),
};

export function errorMessage(error: unknown, fallback = "操作失败。"): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

const asRecordOf = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
