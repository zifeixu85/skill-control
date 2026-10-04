import { normalizeAgentFile, normalizeAgentFiles, normalizeAgentTools } from "./agent-extras";
import { resolveApiBase } from "./api-base";
import { normalizeHealthReport } from "./health";
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

  constructor(message: string, status: number, unsupported = false) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.unsupported = unsupported;
  }
}

const ROUTE_MISSING = "接口不存在。";

async function errorFrom(response: Response): Promise<ApiError> {
  let message = `本地服务返回了错误（${response.status}）。`;
  try {
    const payload = (await response.json()) as { error?: unknown };
    if (typeof payload?.error === "string" && payload.error) message = payload.error;
  } catch {
    // Non-JSON error bodies keep the generic message.
  }
  return new ApiError(message, response.status, response.status === 404 && message === ROUTE_MISSING);
}

function url(pathname: string, params?: Record<string, string | number | boolean | null | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== null && value !== undefined && value !== "") search.set(key, String(value));
  }
  const query = search.toString();
  return `${apiBase()}${pathname}${query ? `?${query}` : ""}`;
}

async function send(target: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(target, init);
  } catch {
    throw new ApiError("连不上本地服务。请确认 Skill Control 正在运行。", 0);
  }
  if (!response.ok) throw await errorFrom(response);
  return response;
}

async function getJson<T>(pathname: string, params?: Parameters<typeof url>[1]): Promise<T> {
  const response = await send(url(pathname, params));
  return (await response.json()) as T;
}

async function sendJson<T>(
  method: "POST" | "PUT",
  pathname: string,
  body: unknown,
  confirm = false,
): Promise<T> {
  const response = await send(url(pathname), {
    method,
    headers: {
      "content-type": "application/json",
      ...(confirm ? { "x-skill-manager-confirm": "yes" } : {}),
    },
    body: JSON.stringify(body),
  });
  return (await response.json()) as T;
}

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
    sendJson<SyncPlan>("POST", "/api/sync", { ...input, dryRun: true }),
  executeSync: (input: { sourceInstanceId: string; targetAgentIds: string[]; mode: SyncMode }) =>
    sendJson<SyncPlan>("POST", "/api/sync", { ...input, dryRun: false, confirm: true }, true),
  planImport: (importId: string, targetAgentIds: string[]) =>
    sendJson<SyncPlan>("POST", "/api/import-install", { importId, targetAgentIds, dryRun: true }),
  executeImport: (importId: string, targetAgentIds: string[]) =>
    sendJson<SyncPlan>(
      "POST",
      "/api/import-install",
      { importId, targetAgentIds, dryRun: false, confirm: true },
      true,
    ),
  async importSkill(file: File): Promise<ImportedSkill> {
    const response = await send(url("/api/import-skill"), {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-skill-filename": encodeURIComponent(file.name),
      },
      body: file,
    });
    return (await response.json()) as ImportedSkill;
  },
  async exportSkill(instanceId: string, format: "skill" | "zip"): Promise<Blob> {
    const response = await send(url("/api/export-skill", { instanceId, format }));
    return response.blob();
  },
  reveal: (instanceId: string) => sendJson<{ ok: boolean }>("POST", "/api/reveal", { instanceId }),
  async fetchBlob(target: string): Promise<Blob> {
    const response = await send(target);
    return response.blob();
  },

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
    normalizePlan(await sendJson<unknown>("POST", "/api/updates/plan", choice ? { unitKey, choice } : { unitKey })),
  applyUpdate: async (planId: string) =>
    normalizeApply(await sendJson<unknown>("POST", "/api/updates/apply", { planId, confirm: true }, true)),
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
