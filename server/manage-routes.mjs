import path from "node:path";
import { createCliManager, fixesFor } from "./cli-fixes.mjs";
import { inventoryCliTools, isKnownAiCommand } from "./cli-inventory.mjs";
import { AGENT_PATH_SOURCES, detectCliTools } from "./cli-tools.mjs";
import { object, readBoundedJson } from "./fs-safe.mjs";
import { createLibraryService } from "./library-service.mjs";
import { createRestoreService } from "./restore-service.mjs";
import { defaultSearchDirectories, findCommand } from "./path-lookup.mjs";
import { runCommand } from "./update-apply.mjs";

/**
 * Library and CLI tool routes. Reads are open to the app; every write needs a plan from
 * this process, `confirm: true` and the `x-skill-manager-confirm: yes` header, and all
 * routes are same-site only.
 */

export const MANAGE_ROUTES = [
  "/api/library",
  "/api/library/plan",
  "/api/library/apply",
  "/api/library/restore",
  "/api/cli-tools",
  "/api/cli-tools/plan",
  "/api/cli-tools/apply",
  "/api/history",
  "/api/history/plan-restore",
  "/api/history/apply-restore",
  "/api/skills/plan-uninstall",
  "/api/skills/apply-uninstall",
  "/api/trash",
  "/api/trash/restore",
];

class RouteError extends Error {
  constructor(statusCode, message, code = statusCode === 400 ? "invalid-request" : null) {
    super(message);
    this.statusCode = statusCode;
    if (code) this.code = code;
  }
}

const ACTIONS = ["adopt", "link", "unlink", "disable", "remove", "batch"];

/**
 * `context`: { homeDirectory, homes, stateDirectory, backupDirectory, historyFile, getConfig,
 *   getScan, getAgents, materialize, commandDirectories, readBody, afterWrite, json }
 */
export function createManageRoutes(context) {
  const searchDirectories = async () => context.commandDirectories || (await defaultSearchDirectories({ homeDirectory: context.homeDirectory }));
  const library = createLibraryService({
    homeDirectory: context.homeDirectory,
    homes: context.homes,
    stateDirectory: context.stateDirectory,
    backupDirectory: context.backupDirectory,
    historyFile: context.historyFile,
    getConfig: context.getConfig,
    findCommand: async (name) => findCommand(name, await searchDirectories()),
  });

  async function launchctlPath() {
    // Read-only probe; skipped when commands are pinned (tests and sandboxes).
    if (context.commandDirectories || process.platform !== "darwin") return null;
    const result = await runCommand("/bin/launchctl", ["getenv", "PATH"], { timeoutMs: 3_000, env: { PATH: "/usr/bin:/bin" } });
    const value = String(result.stdout || "").trim();
    return result.exitCode === 0 && value ? value.split(":") : [];
  }

  async function latestVersions() {
    const cache = await readBoundedJson(path.join(context.stateDirectory, "update-cache.json"), 8_000_000);
    const fromCache = object(object(object(cache.value).facts)["lark-cli"]).upstream?.latest;
    const state = await readBoundedJson(path.join(context.homeDirectory, ".lark-cli", "update-state.json"), 64_000);
    return { "lark-cli": fromCache || object(state.value).latest_version || null };
  }

  const agentsOf = (config) => ({
    agents: (config.agents || []).map((agent) => agent.id).filter((id) => AGENT_PATH_SOURCES[id]),
    agentNames: Object.fromEntries((config.agents || []).map((agent) => [agent.id, agent.name])),
  });

  async function detectTools({ launchctl } = {}) {
    const config = await context.getConfig();
    const libraryView = await library.readInternal();
    return detectCliTools({
      homeDirectory: context.homeDirectory,
      homes: context.homes,
      searchDirectories: await searchDirectories(),
      ...agentsOf(config),
      library: libraryView,
      latest: await latestVersions(),
      launchctlPath: launchctl === undefined ? await launchctlPath() : launchctl,
    });
  }

  /** SKILL.md of every scanned skill copy (for "which skills mention this command"). */
  async function skillFiles() {
    const scan = await context.getScan().catch(() => null);
    const expand = (value) => (value === "~" ? context.homeDirectory : String(value || "").startsWith("~/") ? path.join(context.homeDirectory, value.slice(2)) : value);
    return (scan?.skills || []).flatMap((skill) =>
      (skill.instances || []).filter((instance) => typeof instance.path === "string").map((instance) => ({ file: path.join(expand(instance.path), "SKILL.md"), name: skill.name })),
    );
  }

  /** The generic inventory (v0.2 §12); system prefixes are skipped when commands are pinned. */
  async function inventory({ launchctl } = {}) {
    return inventoryCliTools({
      homeDirectory: context.homeDirectory,
      homes: context.homes,
      stateDirectory: context.stateDirectory,
      skillFiles: await skillFiles(),
      ...agentsOf(await context.getConfig()),
      launchctlPath: launchctl ?? null,
      systemPrefixes: context.commandDirectories ? [] : ["/opt/homebrew", "/usr/local"],
    });
  }

  const restore = createRestoreService({
    homeDirectory: context.homeDirectory,
    homes: context.homes,
    stateDirectory: context.stateDirectory,
    backupDirectory: context.backupDirectory,
    historyFile: context.historyFile,
    getScan: context.getScan,
    getAgents: context.getAgents,
    materialize: context.materialize,
  });

  const cli = createCliManager({
    homeDirectory: context.homeDirectory,
    homes: context.homes,
    backupDirectory: context.backupDirectory,
    historyFile: context.historyFile,
    detect: detectTools,
  });

  const INVENTORY_FIELDS = ["path", "source", "kind", "fileKind", "interpreter", "target", "links", "owner", "description", "size", "mtime", "referencedBySkills", "referencedCount", "aiRelated", "aiReasons"];

  /**
   * GET /api/cli-tools: the deep cards (lark-cli, gh, uv) first, each with the inventory
   * fields of its preferred copy, then every other inventoried command, plus summary counts.
   */
  async function publicTools() {
    const launchctl = await launchctlPath();
    const [deep, listed] = await Promise.all([
      detectTools({ launchctl }),
      inventory({ launchctl }).catch(() => ({ tools: [], summary: {} })),
    ]);
    const deepCommands = new Set(deep.map((tool) => tool.internal.descriptor.command));
    const cards = deep.map((tool) => {
      const rest = { ...tool };
      delete rest.internal;
      const command = tool.internal.descriptor.command;
      const match = listed.tools.find((item) => item.name === command);
      const fields = match
        ? Object.fromEntries(INVENTORY_FIELDS.filter((key) => key in match).map((key) => [key, match[key]]))
        : { path: rest.binaries[0]?.path || null, referencedBySkills: [], referencedCount: 0, aiRelated: isKnownAiCommand(command), aiReasons: isKnownAiCommand(command) ? ["known-ai-cli"] : [] };
      return { ...fields, ...rest, fixes: fixesFor(tool, { homes: context.homes }) };
    });
    const tools = [...cards, ...listed.tools.filter((tool) => !deepCommands.has(tool.name))];
    return {
      tools,
      summary: { ...listed.summary, total: tools.length, aiRelated: tools.filter((tool) => tool.aiRelated).length, deep: cards.length },
    };
  }

  const confirmed = (request, body) => {
    if (request.headers["x-skill-manager-confirm"] !== "yes" || body.confirm !== true) throw new RouteError(400, "需要明确确认后才能执行。", "confirm-required");
  };

  const getRoutes = {
    "/api/library": () => library.view(),
    "/api/cli-tools": () => publicTools(),
    "/api/history": (url) => restore.listHistory(url.searchParams.get("limit")),
    "/api/trash": () => restore.listTrash(),
  };
  const postRoutes = {
    async "/api/library/plan"(body) {
      if (!ACTIONS.includes(body.action)) throw new RouteError(400, "未知的操作。");
      return library.plan({
        action: body.action,
        skill: typeof body.skill === "string" ? body.skill : null,
        agents: Array.isArray(body.agents) ? body.agents.filter((id) => typeof id === "string").slice(0, 24) : null,
        choice: typeof body.choice === "string" ? body.choice : null,
        choices: object(body.choices),
        from: typeof body.from === "string" ? body.from : null,
      });
    },
    async "/api/library/apply"(body, request) {
      confirmed(request, body);
      const result = await library.apply({ planId: body.planId, confirm: true });
      context.afterWrite?.();
      return result;
    },
    async "/api/library/restore"(body, request) {
      confirmed(request, body);
      const result = await library.restore({ trashId: body.trashId });
      context.afterWrite?.();
      return result;
    },
    async "/api/cli-tools/plan"(body) {
      return cli.plan({ toolId: String(body.toolId || ""), fixId: String(body.fixId || ""), agents: Array.isArray(body.agents) ? body.agents : null });
    },
    async "/api/cli-tools/apply"(body, request) {
      confirmed(request, body);
      return cli.apply({ planId: body.planId, confirm: true });
    },
    async "/api/history/plan-restore"(body) {
      if (typeof body.historyId !== "string" || !/^[\w-]{1,64}$/u.test(body.historyId)) throw new RouteError(400, "历史记录无效。");
      const select = Array.isArray(body.select) ? body.select.filter((id) => typeof id === "string").slice(0, 500) : null;
      return restore.planRestore({ historyId: body.historyId, select });
    },
    async "/api/history/apply-restore"(body, request) {
      confirmed(request, body);
      const result = await restore.applyRestore({ planId: body.planId, confirm: true });
      context.afterWrite?.();
      return result;
    },
    async "/api/skills/plan-uninstall"(body) {
      if (typeof body.skillId !== "string" || typeof body.agentId !== "string") throw new RouteError(400, "缺少技能或 Agent。");
      return restore.planUninstall({ skillId: body.skillId, agentId: body.agentId });
    },
    async "/api/skills/apply-uninstall"(body, request) {
      confirmed(request, body);
      const result = await restore.applyUninstall({ planId: body.planId, confirm: true });
      context.afterWrite?.();
      return result;
    },
    async "/api/trash/restore"(body, request) {
      confirmed(request, body);
      const result = await restore.trashRestore({ trashId: body.trashId });
      context.afterWrite?.();
      return result;
    },
  };

  async function handle(request, url, response, origin) {
    if (request.method === "GET" && getRoutes[url.pathname]) {
      context.json(response, 200, await getRoutes[url.pathname](url), origin);
      return true;
    }
    if (request.method === "POST" && postRoutes[url.pathname]) {
      const body = await context.readBody(request);
      context.json(response, 200, await postRoutes[url.pathname](body && typeof body === "object" ? body : {}, request), origin);
      return true;
    }
    return false;
  }

  return { handle, libraryInternal: () => library.readInternal(), detectTools };
}
