import { normalizeAgentFile, normalizeAgentFiles, normalizeAgentTools } from "./agent-extras";
import { resolveApiBase } from "./api-base";
import { normalizeCliApply, normalizeCliPlan, normalizeCliTools } from "./cli-tools";
import { normalizeHealthReport } from "./health";
import { normalizeHistory, normalizeRestorePlan, normalizeTrash, normalizeUninstallPlan } from "./history";
import { normalizeLibrary, normalizeLibraryApply, normalizeLibraryPlan, type LibraryAction } from "./library";
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
    skillManagerDesktop?: { apiBase?: string };
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

  constructor(message: string, status: number, unsupported = false, timedOut = false, code: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.unsupported = unsupported;
    this.timedOut = timedOut;
    this.code = code;
  }
}

/** Time limits per call type, so no state can hang forever. */
export const TIMEOUTS = {
  read: 120_000,
  plan: 30_000,
  updatePlan: 90_000,
  apply: 120_000,
  updateApply: 360_000,
} as const;

const ROUTE_MISSING = "接口不存在。";
const ERROR_CODE = /^[a-z][a-z0-9-]{1,40}$/u;

async function errorFrom(response: Response): Promise<ApiError> {
  let message = `本地服务返回了错误（${response.status}）。`;
  let code: string | null = null;
  try {
    const payload = (await response.json()) as { error?: unknown; code?: unknown };
    if (typeof payload?.error === "string" && payload.error) message = payload.error;
    if (typeof payload?.code === "string" && ERROR_CODE.test(payload.code)) code = payload.code;
  } catch {
    // Non-JSON error bodies keep the generic message.
  }
  const unsupported = response.status === 404 && (code === "route-missing" || (code === null && message === ROUTE_MISSING));
  return new ApiError(message, response.status, unsupported, false, code);
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
  importSkill: (file: File) =>
    send(
      url("/api/import-skill"),
      {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-skill-filename": encodeURIComponent(file.name),
        },
        body: file,
      },
      TIMEOUTS.read,
      json<ImportedSkill>,
    ),
  exportSkill: (instanceId: string, format: "skill" | "zip") =>
    send(url("/api/export-skill", { instanceId, format }), {}, TIMEOUTS.read, (response) => response.blob()),
  reveal: (instanceId: string) => sendJson<{ ok: boolean }>("POST", "/api/reveal", { instanceId }),
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
  usageSummary: async (days = 30) =>
    normalizeUsageSummary(await getJson<unknown>("/api/usage/summary", { days }), days),
  usageSkill: async (name: string, days = 90) =>
    normalizeSkillUsage(await getJson<unknown>("/api/usage/skill", { name, days }), name),
  usageAgent: async (id: string, days = 90) =>
    normalizeAgentUsage(await getJson<unknown>("/api/usage/agent", { id, days }), id),
  usageStatus: async () => normalizeUsageStatus(await getJson<unknown>("/api/usage/status")),
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
  cliTools: async () => normalizeCliTools(await getJson<unknown>("/api/cli-tools")),
  cliPlan: async (toolId: string, fixId: string, agents?: string[]) =>
    normalizeCliPlan(
      await sendJson<unknown>("POST", "/api/cli-tools/plan", agents?.length ? { toolId, fixId, agents } : { toolId, fixId }, PLAN),
    ),
  cliApply: async (planId: string) =>
    normalizeCliApply(await sendJson<unknown>("POST", "/api/cli-tools/apply", { planId, confirm: true }, WRITE)),
  healthReport: async (refresh?: boolean) =>
    normalizeHealthReport(await getJson<unknown>("/api/health-report", force(refresh))),
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
