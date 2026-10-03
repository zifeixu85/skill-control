import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  compactHomePath,
  exists,
  findSkillDirectoryNames,
  homeVariants,
  identifier,
  isWithin,
  mcpTransport,
  object,
  readBoundedJson,
  readStatusMessage,
  realpathOrNull,
  resolveInside,
  safeSegment,
  splitPluginKey,
  text,
} from "./fs-safe.mjs";

/**
 * Read-only Claude Code plugin discovery from ~/.claude/plugins metadata.
 * Install paths must resolve inside ~/.claude/plugins; MCP definitions are reduced to names.
 */

const METADATA_LIMIT = 2_000_000;
const MANIFEST_LIMIT = 256_000;
const COMPONENT_LIMIT = 300;
const PLUGIN_LIMIT = 300;
const SCOPES = new Set(["user", "local", "project", "managed"]);

async function markdownNames(root, boundary, { recursive = false, separator = ":" } = {}) {
  const names = [];
  async function visit(directory, prefix, depth) {
    if (names.length >= COMPONENT_LIMIT) return;
    const realDirectory = await realpathOrNull(directory);
    if (!realDirectory || !isWithin(boundary, realDirectory)) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (names.length >= COMPONENT_LIMIT || entry.name.startsWith(".")) continue;
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        names.push(`${prefix}${entry.name.slice(0, -3)}`);
      } else if (recursive && entry.isDirectory() && depth < 2) {
        await visit(path.join(directory, entry.name), `${prefix}${entry.name}${separator}`, depth + 1);
      }
    }
  }
  await visit(root, "", 0);
  return names;
}

function declaredPaths(value, fallback) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string").slice(0, 16);
  if (typeof value === "string") return [value];
  return [fallback];
}

async function collectMarkdown(installRoot, declared, fallback, options) {
  const names = new Set();
  for (const relative of declaredPaths(declared, fallback)) {
    const resolved = await resolveInside(installRoot, relative);
    if (!resolved) continue;
    if (resolved.toLowerCase().endsWith(".md")) {
      names.add(path.basename(resolved, path.extname(resolved)));
    } else {
      for (const name of await markdownNames(resolved, installRoot, options)) names.add(name);
    }
  }
  return [...names];
}

async function pluginComponents(installRoot, manifest) {
  const skills = new Set();
  for (const relative of declaredPaths(manifest.skills, "./skills")) {
    const resolved = await resolveInside(installRoot, relative);
    if (!resolved) continue;
    for (const name of await findSkillDirectoryNames(resolved, installRoot, { limit: COMPONENT_LIMIT })) {
      skills.add(name);
    }
  }
  if (Array.isArray(manifest.skills) || typeof manifest.skills === "string") {
    const defaultSkills = await resolveInside(installRoot, "./skills");
    if (defaultSkills) {
      for (const name of await findSkillDirectoryNames(defaultSkills, installRoot, { limit: COMPONENT_LIMIT })) {
        skills.add(name);
      }
    }
  }

  let mcpSource = null;
  if (manifest.mcpServers && typeof manifest.mcpServers === "object") {
    mcpSource = manifest.mcpServers;
  } else {
    const resolved = await resolveInside(
      installRoot,
      typeof manifest.mcpServers === "string" ? manifest.mcpServers : ".mcp.json",
    );
    const parsed = resolved ? await readBoundedJson(resolved, MANIFEST_LIMIT) : null;
    mcpSource = parsed?.status === "ok" ? parsed.value : null;
  }
  const servers = object(object(mcpSource).mcpServers);
  const mcpEntries = Object.keys(servers).length ? servers : object(mcpSource);
  const mcpServers = Object.entries(mcpEntries)
    .slice(0, COMPONENT_LIMIT)
    .filter(([name]) => identifier(name))
    .map(([name, config]) => ({ name: identifier(name), transport: mcpTransport(config) }));

  const hooks =
    Boolean(manifest.hooks && typeof manifest.hooks === "object") ||
    (typeof manifest.hooks === "string" && Boolean(await resolveInside(installRoot, manifest.hooks))) ||
    Boolean(await resolveInside(installRoot, "hooks/hooks.json"));

  return {
    skills: [...skills].sort((left, right) => left.localeCompare(right)),
    agents: (await collectMarkdown(installRoot, manifest.agents, "./agents")).sort(),
    commands: (await collectMarkdown(installRoot, manifest.commands, "./commands", { recursive: true })).sort(),
    mcpServers,
    apps: [],
    hooks,
  };
}

function enabledState(scope, id, enabledPlugins, settingsValid) {
  // Only user-scope enablement is readable from ~/.claude/settings.json; project and local
  // scopes live in project files that this scanner deliberately does not open.
  if (scope !== "user" || !settingsValid) return "unknown";
  const value = enabledPlugins[id];
  return typeof value === "boolean" ? value : "unknown";
}

async function describeInstall({ id, name, marketplace, entry, homes, realPluginsRoot, enabledPlugins, settingsValid, warnings }) {
  const scope = SCOPES.has(entry.scope) ? entry.scope : "unknown";
  const installPath = typeof entry.installPath === "string" ? path.resolve(entry.installPath) : "";
  const realInstall = installPath ? await realpathOrNull(installPath) : null;
  if (!realInstall || !realPluginsRoot || !isWithin(realPluginsRoot, realInstall)) {
    warnings.push(`Claude Code 插件 ${id} 的安装目录不在 ~/.claude/plugins 内，已跳过。`);
    return null;
  }
  const projectPath =
    typeof entry.projectPath === "string" && path.isAbsolute(entry.projectPath)
      ? compactHomePath(entry.projectPath, homes)
      : null;
  const plugin = {
    id,
    key: `claude:${createHash("sha256").update(`${id}:${scope}:${projectPath || ""}`).digest("hex").slice(0, 16)}`,
    agentId: "claude",
    name,
    marketplace,
    displayName: name,
    shortDescription: "",
    longDescription: "",
    category: "",
    developerName: "",
    brandColor: null,
    capabilities: [],
    keywords: [],
    license: "",
    homepage: "",
    version: text(entry.version, 64),
    versions: [],
    enabled: enabledState(scope, id, enabledPlugins, settingsValid),
    configured: true,
    installed: true,
    scope,
    projectPath,
    installedAt: text(entry.installedAt, 40) || null,
    lastUpdated: text(entry.lastUpdated, 40) || null,
    source: "claude-plugins",
    manifestStatus: "missing",
    components: { skills: [], agents: [], commands: [], mcpServers: [], apps: [], hooks: false },
    logo: null,
    logoDark: null,
    composerIcon: null,
  };
  const manifestPath = await resolveInside(realInstall, ".claude-plugin/plugin.json");
  const manifestResult = manifestPath
    ? await readBoundedJson(manifestPath, MANIFEST_LIMIT)
    : { status: "missing" };
  plugin.manifestStatus = manifestResult.status;
  if (!["ok", "missing"].includes(manifestResult.status)) {
    warnings.push(readStatusMessage(`Claude Code 插件 ${id} 的清单`, manifestResult.status));
  }
  const manifest = manifestResult.status === "ok" ? object(manifestResult.value) : {};
  plugin.displayName = text(manifest.name, 80) || name;
  plugin.shortDescription = text(manifest.description, 400);
  plugin.developerName = text(object(manifest.author).name, 80);
  plugin.license = text(manifest.license, 40);
  plugin.keywords = (Array.isArray(manifest.keywords) ? manifest.keywords : [])
    .map((item) => text(item, 40))
    .filter(Boolean)
    .slice(0, 12);
  if (!plugin.version || plugin.version === "unknown") {
    plugin.version = text(manifest.version, 64) || plugin.version;
  }
  plugin.components = await pluginComponents(realInstall, manifest);
  return plugin;
}

export async function scanClaudePlugins(homeDirectory = homedir()) {
  const homes = await homeVariants(homeDirectory);
  const claudeRoot = path.join(homeDirectory, ".claude");
  const pluginsRoot = path.join(claudeRoot, "plugins");
  const result = { available: false, agentId: "claude", plugins: [], marketplaces: [], warnings: [] };
  if (!(await exists(pluginsRoot))) return result;
  result.available = true;

  const installed = await readBoundedJson(path.join(pluginsRoot, "installed_plugins.json"), METADATA_LIMIT);
  if (installed.status !== "ok") {
    if (installed.status !== "missing") {
      result.warnings.push(readStatusMessage("Claude Code installed_plugins.json", installed.status));
    }
    return result;
  }
  const settings = await readBoundedJson(path.join(claudeRoot, "settings.json"), METADATA_LIMIT);
  if (!["ok", "missing"].includes(settings.status)) {
    result.warnings.push(readStatusMessage("Claude Code settings.json", settings.status));
  }
  const enabledPlugins = settings.status === "ok" ? object(object(settings.value).enabledPlugins) : {};
  const known = await readBoundedJson(path.join(pluginsRoot, "known_marketplaces.json"), METADATA_LIMIT);
  if (known.status === "ok") {
    result.marketplaces = Object.entries(object(known.value))
      .filter(([name]) => safeSegment(name))
      .slice(0, 50)
      .map(([name, value]) => {
        const sourceType = object(object(value).source).source;
        return {
          name,
          sourceType: ["github", "git", "url", "directory", "file", "local"].includes(sourceType)
            ? sourceType
            : "unknown",
        };
      });
  }

  const realPluginsRoot = await realpathOrNull(pluginsRoot);
  const entries = Object.entries(object(object(installed.value).plugins)).slice(0, PLUGIN_LIMIT);
  for (const [id, installs] of entries) {
    const parsed = splitPluginKey(id);
    if (!parsed) continue;
    for (const entry of (Array.isArray(installs) ? installs : []).slice(0, 16)) {
      const plugin = await describeInstall({
        id,
        ...parsed,
        entry: object(entry),
        homes,
        realPluginsRoot,
        enabledPlugins,
        settingsValid: settings.status === "ok",
        warnings: result.warnings,
      });
      if (plugin) result.plugins.push(plugin);
    }
  }
  return result;
}
