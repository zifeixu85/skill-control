import path from "node:path";
import { listAgentFiles, readAgentFile } from "./agent-files.mjs";
import { readAgentIcon } from "./agent-icons.mjs";
import { listAgentTools } from "./agent-tools.mjs";
import { createCachedLoader } from "./cached-loader.mjs";
import { buildHealthReport } from "./health-report.mjs";
import { readMcpSources } from "./mcp-inventory.mjs";
import { createUsageService } from "./usage-service.mjs";
import { clampDays, usageForAgent, usageForSkill, usageSummary } from "./usage-query.mjs";

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
  "/api/usage/status",
  "/api/health-report",
  "/api/agent-icon",
];

const HEALTH_CACHE_TTL = 5 * 60_000;
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const NAME = /^[\w.@-]{1,64}$/u;

class RouteError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
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
 * `context`: { homeDirectory, homes, stateDirectory, applicationDirectories,
 *   getScan(), getIntegrations(), listCapabilityLinks(agentId), json(response, status, body, origin),
 *   image(response, asset, origin) }
 */
export function createInsightRoutes(context) {
  const usage = createUsageService({
    homeDirectory: context.homeDirectory,
    indexPath: path.join(context.stateDirectory, "usage-index.json"),
  });
  const healthLoader = createCachedLoader(
    async () => {
      const [scan, integrations, mcp] = await Promise.all([
        context.getScan(),
        context.getIntegrations(),
        readMcpSources(context.homeDirectory),
      ]);
      return buildHealthReport({
        scan,
        plugins: integrations.payload.plugins,
        mcpEntries: mcp.entries,
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
    async "/api/usage/status"() {
      usage.ensureFresh();
      return usage.status();
    },
    async "/api/health-report"(url) {
      return healthLoader.get(url.searchParams.get("force") === "1");
    },
  };

  /** Returns true when the request was handled. */
  async function handle(request, url, response, origin) {
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

  return { handle, usage };
}
