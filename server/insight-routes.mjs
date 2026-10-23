import path from "node:path";
import { listAgentFiles, readAgentFile } from "./agent-files.mjs";
import { readAgentIcon } from "./agent-icons.mjs";
import { listAgentTools } from "./agent-tools.mjs";
import { createCachedLoader } from "./cached-loader.mjs";
import { buildHealthReport } from "./health-report.mjs";
import { readMcpSources } from "./mcp-inventory.mjs";
import { createUpdateService } from "./update-service.mjs";
import { createAgentVersionService } from "./agent-versions.mjs";
import { createUsageService } from "./usage-service.mjs";
import { publicPriceTable } from "./pricing.mjs";
import { clampDays, usageForAgent, usageForSkill, usageModels, usageProjects, usageSummary, usageTotals } from "./usage-query.mjs";

/**
 * Read-only "insight" endpoints: agent files, agent tools, usage analytics, health report
 * and app icons. Every route is same-site only (see INSIGHT_ROUTES).
 */

export const INSIGHT_ROUTES = [
  "/api/agent-files",
  "/api/agent-file",
  "/api/agent-tools",
  "/api/usage/summary",
  "/api/usage/skill",
  "/api/usage/agent",
  "/api/usage/models",
  "/api/usage/projects",
  "/api/usage/totals",
  "/api/usage/pricing",
  "/api/usage/status",
  "/api/agent-versions",
  "/api/agent-versions/check",
  "/api/agent-versions/plan",
  "/api/agent-versions/apply",
  "/api/agent-versions/open",
  "/api/health-report",
  "/api/agent-icon",
  "/api/updates",
  "/api/updates/check",
  "/api/updates/check-status",
  "/api/updates/changes",
  "/api/updates/plan",
  "/api/updates/apply",
];

const HEALTH_CACHE_TTL = 5 * 60_000;
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const NAME = /^[\w.@-]{1,64}$/u;

// Offline mode (SKILL_MANAGER_UPDATES_OFFLINE=1): checks fail fast, nothing is sent.
const offlineFetch = async () => {
  throw new TypeError("offline");
};
const offlineLsRemote = async () => {
  const { TransportError } = await import("./update-transport.mjs");
  throw new TransportError("offline", "离线模式，未连接仓库。");
};

class RouteError extends Error {
  constructor(statusCode, message, code = statusCode === 400 ? "invalid-request" : null) {
    super(message);
    this.statusCode = statusCode;
    if (code) this.code = code;
  }
}

const agentParam = (value) => {
  if (!AGENT_ID.test(String(value || ""))) throw new RouteError(404, "未知的 Agent。");
  return String(value);
};
const optionalName = (value) => {
  if (value === null || value === "") return null;
  if (!NAME.test(String(value))) throw new RouteError(400, "名称格式无效。");
  return String(value);
};

/**
 * `context`: { homeDirectory, homes, stateDirectory, backupDirectory, historyFile,
 *   applicationDirectories, getScan(), getIntegrations(), getConfig(), getAgents(),
 *   listCapabilityLinks(agentId), materialize(options), readBody(request), afterWrite(),
 *   json(response, status, body, origin), image(response, asset, origin) }
 */
export function createInsightRoutes(context) {
  const versions = createAgentVersionService({
    homeDirectory: context.homeDirectory,
    homes: context.homes,
    stateDirectory: context.stateDirectory,
    ...(context.applicationDirectories ? { applicationDirectories: context.applicationDirectories } : {}),
    ...(context.commandDirectories ? { searchDirectories: context.commandDirectories, pinnedDirectories: context.commandDirectories.map((entry) => entry.directory) } : {}),
    historyFile: context.historyFile,
    offline: Boolean(context.updatesOffline),
    ...(context.updatesOffline ? { fetchImpl: offlineFetch } : {}),
  });
  const usage = createUsageService({
    homeDirectory: context.homeDirectory,
    indexPath: path.join(context.stateDirectory, "usage-index.json"),
  });
  const updates = createUpdateService({
    homeDirectory: context.homeDirectory,
    homes: context.homes,
    stateDirectory: context.stateDirectory,
    backupDirectory: context.backupDirectory,
    historyFile: context.historyFile,
    getScan: context.getScan,
    getAgents: context.getAgents,
    getConfig: context.getConfig,
    materialize: context.materialize,
    ...(context.updatesOffline ? { fetchImpl: offlineFetch, lsRemoteImpl: offlineLsRemote } : {}),
    ...(context.commandDirectories ? { searchDirectories: context.commandDirectories, restrictCommands: true } : {}),
  });
  const healthLoader = createCachedLoader(
    async () => {
      const [scan, integrations, mcp, updateStatuses, library, cliTools] = await Promise.all([
        context.getScan(),
        context.getIntegrations(),
        readMcpSources(context.homeDirectory),
        // Cached update results only: the health report never makes requests.
        updates.cachedStatuses().catch(() => []),
        context.getLibrary ? context.getLibrary().catch(() => null) : null,
        context.getCliTools ? context.getCliTools().catch(() => []) : [],
      ]);
      return buildHealthReport({
        scan,
        plugins: integrations.payload.plugins,
        mcpEntries: mcp.entries,
        updates: updateStatuses,
        library,
        cliTools,
        ...(context.commandDirectories ? { searchDirectories: context.commandDirectories } : {}),
        homeDirectory: context.homeDirectory,
        homes: context.homes,
      });
    },
    { ttlMs: HEALTH_CACHE_TTL },
  );

  const routes = {
    async "/api/agent-files"(url) {
      const agentId = agentParam(url.searchParams.get("agent"));
      const listing = await listAgentFiles(agentId, {
        homeDirectory: context.homeDirectory,
        homes: context.homes,
        profile: optionalName(url.searchParams.get("profile")),
        agent: optionalName(url.searchParams.get("agentId")),
      });
      return { ...listing, capabilities: await context.listCapabilityLinks(agentId).catch(() => []) };
    },
    async "/api/agent-file"(url) {
      return readAgentFile(url.searchParams.get("id"), { homeDirectory: context.homeDirectory, homes: context.homes });
    },
    async "/api/agent-tools"(url) {
      const agentId = agentParam(url.searchParams.get("agent"));
      const integrations = await context.getIntegrations();
      return listAgentTools(agentId, { homeDirectory: context.homeDirectory, homes: context.homes, integrations: integrations.payload });
    },
    async "/api/usage/summary"(url) {
      usage.ensureFresh();
      return { ...usageSummary(await usage.getIndex(), { days: clampDays(url.searchParams.get("days"), 30) }), status: usage.status() };
    },
    async "/api/usage/skill"(url) {
      const name = String(url.searchParams.get("name") || "").trim();
      if (!/^[\w.@:-]{1,128}$/u.test(name)) throw new RouteError(400, "技能名称格式无效。");
      usage.ensureFresh();
      return { ...usageForSkill(await usage.getIndex(), name, { days: clampDays(url.searchParams.get("days"), 90) }), status: usage.status() };
    },
    async "/api/usage/agent"(url) {
      const agentId = agentParam(url.searchParams.get("id"));
      usage.ensureFresh();
      return { ...usageForAgent(await usage.getIndex(), agentId, { days: clampDays(url.searchParams.get("days"), 90) }), status: usage.status() };
    },
    async "/api/usage/models"(url) {
      usage.ensureFresh();
      return { ...usageModels(await usage.getIndex(), { days: clampDays(url.searchParams.get("days"), 30) }), status: usage.status() };
    },
    async "/api/usage/projects"(url) {
      usage.ensureFresh();
      return { ...usageProjects(await usage.getIndex(), { days: clampDays(url.searchParams.get("days"), 30) }), status: usage.status() };
    },
    async "/api/usage/totals"() {
      usage.ensureFresh();
      return { ...usageTotals(await usage.getIndex()), status: usage.status() };
    },
    async "/api/usage/pricing"() {
      return publicPriceTable();
    },
    async "/api/agent-versions"() {
      return versions.view();
    },
    async "/api/usage/status"() {
      usage.ensureFresh();
      return usage.status();
    },
    async "/api/health-report"(url) {
      return healthLoader.get(url.searchParams.get("force") === "1");
    },
    async "/api/updates"() {
      return updates.view();
    },
    async "/api/updates/check-status"() {
      return updates.checkStatus();
    },
    async "/api/updates/changes"(url) {
      const unitKey = String(url.searchParams.get("unitKey") || "");
      if (!unitKey || unitKey.length > 600) throw new RouteError(400, "缺少更新单元。");
      return updates.changes(unitKey);
    },
  };

  const postRoutes = {
    async "/api/updates/check"(body) {
      const unitKeys = Array.isArray(body.unitKeys) ? body.unitKeys.filter((key) => typeof key === "string").slice(0, 500) : null;
      return updates.startCheck({ unitKeys });
    },
    async "/api/updates/plan"(body) {
      if (typeof body.unitKey !== "string" || !body.unitKey) throw new RouteError(400, "缺少更新单元。");
      const choice = ["keep-local", "overwrite", "save-as"].includes(body.choice) ? body.choice : null;
      return updates.plan({ unitKey: body.unitKey, choice });
    },
    // Read-only network (official registries and feeds): a plain POST with the origin checks.
    async "/api/agent-versions/check"() {
      return versions.check();
    },
    // One-click CLI update: only verified official commands, shown in the plan first.
    async "/api/agent-versions/plan"(body) {
      return versions.plan({ id: body.id });
    },
    async "/api/agent-versions/apply"(body, request) {
      if (request.headers["x-skill-manager-confirm"] !== "yes" || body.confirm !== true) {
        throw new RouteError(400, "需要明确确认后才能执行更新。", "confirm-required");
      }
      const result = await versions.apply({ planId: body.planId, confirm: true });
      context.afterWrite?.();
      return result;
    },
    // Opens a desktop app so it can update itself (no download, no file change).
    async "/api/agent-versions/open"(body) {
      return versions.openApp({ id: body.id });
    },
    async "/api/updates/apply"(body, request) {
      // Same confirmation model as sync: header + explicit confirm, plan id from this process.
      if (request.headers["x-skill-manager-confirm"] !== "yes" || body.confirm !== true) {
        throw new RouteError(400, "需要明确确认后才能执行更新。", "confirm-required");
      }
      const result = await updates.apply({ planId: body.planId, confirm: true });
      context.afterWrite?.();
      return result;
    },
  };

  /** Returns true when the request was handled. */
  async function handle(request, url, response, origin) {
    if (request.method === "POST" && postRoutes[url.pathname]) {
      const body = await context.readBody(request);
      context.json(response, 200, await postRoutes[url.pathname](body && typeof body === "object" ? body : {}, request), origin);
      return true;
    }
    if (request.method !== "GET") return false;
    if (url.pathname === "/api/agent-icon") {
      const icon = await readAgentIcon(agentParam(url.searchParams.get("id")), {
        homeDirectory: context.homeDirectory,
        cacheDirectory: path.join(context.stateDirectory, "icons"),
        applicationDirectories: context.applicationDirectories,
      });
      if (!icon) throw new RouteError(404, "没有找到这个 Agent 的应用图标。");
      context.image(response, icon, origin);
      return true;
    }
    const route = routes[url.pathname];
    if (!route) return false;
    context.json(response, 200, await route(url), origin);
    return true;
  }

  return { handle, usage, updates, versions };
}
