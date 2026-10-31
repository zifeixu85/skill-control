import path from "node:path";
import { createCliManager, fixesFor } from "./cli-fixes.mjs";
import { inventoryCliTools, isKnownAiCommand } from "./cli-inventory.mjs";
import { AGENT_PATH_SOURCES, detectCliTools } from "./cli-tools.mjs";
import { object, readBoundedJson } from "./fs-safe.mjs";
import { agentPathSource } from "./cli-tools.mjs";
import { bundledCompanion, COMPANION_NAME, companionStatus } from "./companion-skill.mjs";
import { installLauncher, launcherStatus, uninstallLauncher } from "./cli-launcher.mjs";
import { createInstallService, INSTALL_SCOPES } from "./install-service.mjs";
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
  // v0.3: auto-link, catch-up, installs through the library, companion skill, CLI launcher.
  "/api/library/auto-link",
  "/api/library/auto-link/run",
  "/api/library/auto-link/undo",
  "/api/library/catch-up/plan",
  "/api/library/catch-up/apply",
  "/api/install/plan",
  "/api/install/apply",
  "/api/library/companion-skill",
  "/api/library/companion-skill/install",
  "/api/cli-launcher",
  "/api/cli-launcher/install",
  "/api/cli-launcher/uninstall",
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
 *   getScan, getAgents, materialize, commandDirectories, readBody, afterWrite, json,
 *   saveAutoLinkSettings(autoLink), autoLink: { disabled, noWatch, debounceMs, watchImpl },
 *   install: { resolveSource(source), perAgent: { plan, apply } }, launcher: { target, binDirectory } }
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
    saveAutoLinkSettings: context.saveAutoLinkSettings,
    autoLink: { ...(context.autoLink || {}), onRun: async () => context.afterWrite?.() },
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
    // Undoing a link or removing one by hand writes an auto-link tombstone.
    onLinksChanged: (changes) => library.autoLink.record(changes),
  });

  const installs = createInstallService({
    library,
    getConfig: context.getConfig,
    resolveSource: async (source) => {
      if (source?.bundled === COMPANION_NAME) {
        const bundled = await bundledCompanion();
        if (!bundled) throw new RouteError(404, "应用里没有随附的 skill-control 技能。", "not-found");
        return { sourcePath: bundled.path, name: COMPANION_NAME, sourceHash: bundled.hash, label: "skill-control（随附技能）" };
      }
      if (!context.install?.resolveSource) throw new RouteError(400, "缺少技能来源。");
      return context.install.resolveSource(source);
    },
    perAgent: context.install?.perAgent || {
      plan: async () => {
        throw new RouteError(409, "这里不支持各装一份。", "refused");
      },
      apply: async () => {
        throw new RouteError(409, "这里不支持各装一份。", "refused");
      },
    },
  });

  /** The login shell's PATH (newest shell snapshot), to tell whether ~/.local/bin is on it. */
  async function shellPath() {
    const source = await agentPathSource("gemini", context.homeDirectory).catch(() => null);
    return source?.path || null;
  }
  const launcherOptions = async () => ({ homeDirectory: context.homeDirectory, ...(context.launcher || {}), pathEntries: await shellPath() });

  /** The toast's "撤销": undo one auto-link run (or only one skill of it), then tombstones keep it undone. */
  async function undoAutoLink(body) {
    if (typeof body.historyId !== "string" || !/^[\w-]{1,64}$/u.test(body.historyId)) throw new RouteError(400, "历史记录无效。");
    let select = null;
    if (typeof body.skill === "string") {
      const run = (await library.autoLink.readState()).runs.find((item) => item.historyId === body.historyId);
      select = run?.items.find((item) => item.skill === body.skill)?.unitIds || [];
      if (!select.length) throw new RouteError(404, "这次自动接入里没有这个技能。", "not-found");
    }
    const plan = await restore.planRestore({ historyId: body.historyId, select });
    if (!plan.planId) throw new RouteError(409, plan.message || "没有可以撤销的改动。", "nothing-to-do");
    return restore.applyRestore({ planId: plan.planId, confirm: true });
  }

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
    "/api/library/companion-skill": async () => companionStatus({ view: await library.view(), bundled: await bundledCompanion() }),
    "/api/cli-launcher": async () => launcherStatus(await launcherOptions()),
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
    // Settings, like the rest of the config: no confirmation header. Turning it on records a baseline.
    async "/api/library/auto-link"(body) {
      if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw new RouteError(400, "enabled 必须是 true 或 false。");
      if (body.scope !== undefined && !["primary", "all"].includes(body.scope)) throw new RouteError(400, "scope 只能是 primary 或 all。");
      const settings = await library.autoLink.setSettings({ enabled: body.enabled, scope: body.scope });
      context.afterWrite?.();
      return { settings, autoLink: (await library.view()).autoLink };
    },
    async "/api/library/auto-link/run"(body, request) {
      if (body.dryRun !== true) confirmed(request, body);
      const result = await library.autoLink.run({ reason: "manual", dryRun: body.dryRun === true });
      if (body.dryRun !== true) context.afterWrite?.();
      return result;
    },
    async "/api/library/auto-link/undo"(body, request) {
      confirmed(request, body);
      const result = await undoAutoLink(body);
      context.afterWrite?.();
      return result;
    },
    async "/api/library/catch-up/plan"(body) {
      return library.autoLink.catchUpPlan({ agents: Array.isArray(body.agents) ? body.agents.filter((id) => typeof id === "string").slice(0, 24) : null, choices: object(body.choices) });
    },
    async "/api/library/catch-up/apply"(body, request) {
      confirmed(request, body);
      const result = await library.apply({ planId: body.planId, confirm: true });
      context.afterWrite?.();
      return result;
    },
    async "/api/install/plan"(body) {
      if (!INSTALL_SCOPES.includes(body.scope)) throw new RouteError(400, "安装范围 scope 只能是 primary、agents 或 agent-only。");
      const source = object(body.source);
      return installs.plan({ source, scope: body.scope, agentIds: Array.isArray(body.agentIds) ? body.agentIds : null, choices: object(body.choices) });
    },
    async "/api/install/apply"(body, request) {
      confirmed(request, body);
      const result = await installs.apply({ planId: body.planId, confirm: true });
      context.afterWrite?.();
      return result;
    },
    // "把 skill-control 技能装到常用 Agent": into the library, connected to the primary Agents.
    async "/api/library/companion-skill/install"(body, request) {
      confirmed(request, body);
      const plan = await installs.plan({ source: { bundled: COMPANION_NAME }, scope: "primary", choices: { [`replace:${COMPANION_NAME}`]: "use-new" } });
      if (!plan.planId) return { ...plan, status: await companionStatus({ view: await library.view(), bundled: await bundledCompanion() }) };
      const result = await installs.apply({ planId: plan.planId, confirm: true });
      context.afterWrite?.();
      return { ...result, status: await companionStatus({ view: await library.view(), bundled: await bundledCompanion() }) };
    },
    async "/api/cli-launcher/install"(body, request) {
      confirmed(request, body);
      return installLauncher(await launcherOptions());
    },
    async "/api/cli-launcher/uninstall"(body, request) {
      confirmed(request, body);
      return uninstallLauncher(await launcherOptions());
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

  return { handle, libraryInternal: () => library.readInternal(), detectTools, autoLink: library.autoLink };
}
