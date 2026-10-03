import { createHash } from "node:crypto";
import { lstat, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  exists,
  findSkillDirectoryNames,
  identifier,
  isWithin,
  listDirectories,
  mcpTransport,
  object,
  readBoundedJson,
  readBoundedToml,
  readStatusMessage,
  realpathOrNull,
  resolveInside,
  safeSegment,
  splitPluginKey,
  text,
} from "./fs-safe.mjs";

/**
 * Read-only Codex plugin and connector discovery.
 * Never returns config values, MCP headers/env/URLs, marketplace sources or raw parser errors.
 */

const CONFIG_LIMIT = 2_000_000;
const MANIFEST_LIMIT = 256_000;
const COMPONENT_LIMIT = 200;
const PLUGIN_LIMIT = 300;
const TOOLS_CACHE_LIMIT = 20_000_000;
const TOOL_NAME_LIMIT = 20;
const ASSET_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".svg"]);
const ASSET_FIELDS = ["logo", "logoDark", "composerIcon"];

const assetId = (pluginId, version, field) =>
  createHash("sha256")
    .update(`codex-plugin:${pluginId}:${version}:${field}`)
    .digest("hex")
    .slice(0, 24);

function homepageOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.origin : "";
  } catch {
    return "";
  }
}

async function selectVersion(pluginDirectory) {
  // Every version directory is ranked before any truncation of the reported list.
  const versions = await listDirectories(pluginDirectory, 500);
  const realPluginDirectory = await realpathOrNull(pluginDirectory);
  const candidates = [];
  for (const version of versions) {
    const versionPath = path.join(pluginDirectory, version.name);
    const realVersionPath = await realpathOrNull(versionPath);
    if (!realPluginDirectory || !realVersionPath || !isWithin(realPluginDirectory, realVersionPath)) {
      continue;
    }
    let mtimeMs = 0;
    try {
      mtimeMs = (await lstat(versionPath)).mtimeMs;
    } catch {
      continue;
    }
    candidates.push({ ...version, path: versionPath, mtimeMs });
  }
  // Real directories win over aliases such as `latest`; then newest mtime, then name.
  candidates.sort(
    (left, right) =>
      Number(left.isSymlink) - Number(right.isSymlink) ||
      right.mtimeMs - left.mtimeMs ||
      right.name.localeCompare(left.name, undefined, { numeric: true }),
  );
  return {
    versions: versions.map((version) => version.name).slice(0, 50),
    selected: candidates[0] || null,
  };
}

function readMcpNames(value) {
  const servers = object(object(value).mcpServers);
  const source = Object.keys(servers).length ? servers : object(value);
  return Object.entries(source)
    .slice(0, COMPONENT_LIMIT)
    .filter(([name]) => identifier(name))
    .map(([name, config]) => ({ name: identifier(name), transport: mcpTransport(config) }));
}

async function readComponentJson(versionRoot, declared, fallback) {
  const relative = typeof declared === "string" ? declared : fallback;
  if (!relative) return null;
  const resolved = await resolveInside(versionRoot, relative);
  if (!resolved) return null;
  const result = await readBoundedJson(resolved, MANIFEST_LIMIT);
  return result.status === "ok" ? result.value : null;
}

async function pluginComponents(versionRoot, manifest) {
  const skillSources = Array.isArray(manifest.skills)
    ? manifest.skills
    : [typeof manifest.skills === "string" ? manifest.skills : "./skills"];
  const skills = new Set();
  for (const relative of skillSources.slice(0, 16)) {
    const resolved = await resolveInside(versionRoot, relative);
    if (!resolved) continue;
    for (const name of await findSkillDirectoryNames(resolved, versionRoot, { limit: COMPONENT_LIMIT })) {
      skills.add(name);
    }
  }

  const mcpServers =
    manifest.mcpServers && typeof manifest.mcpServers === "object"
      ? readMcpNames(manifest.mcpServers)
      : readMcpNames(await readComponentJson(versionRoot, manifest.mcpServers, ".mcp.json"));

  const appsManifest = await readComponentJson(versionRoot, manifest.apps, ".app.json");
  const apps = Object.entries(object(object(appsManifest).apps))
    .slice(0, COMPONENT_LIMIT)
    .map(([key, value]) => ({ key: identifier(key), connectorId: identifier(object(value).id) || null }))
    .filter((app) => app.key);

  let hooks = Boolean(manifest.hooks && typeof manifest.hooks === "object");
  if (!hooks && typeof manifest.hooks === "string") {
    hooks = Boolean(await resolveInside(versionRoot, manifest.hooks));
  }
  if (!hooks) {
    hooks = Boolean(
      (await resolveInside(versionRoot, "hooks/hooks.json")) ||
        (await resolveInside(versionRoot, "hooks.json")),
    );
  }
  return {
    skills: [...skills].sort((left, right) => left.localeCompare(right)),
    mcpServers,
    apps,
    hooks,
  };
}

async function pluginAssets(pluginId, version, versionRoot, info, assets) {
  const result = {};
  for (const field of ASSET_FIELDS) {
    result[field] = null;
    const relative = info[field];
    if (typeof relative !== "string" || !ASSET_EXTENSIONS.has(path.extname(relative).toLowerCase())) {
      continue;
    }
    const resolved = await resolveInside(versionRoot, relative);
    if (!resolved) continue;
    const id = assetId(pluginId, version, field);
    assets.set(id, {
      root: versionRoot,
      relativePath: path.relative(versionRoot, path.resolve(versionRoot, relative)),
    });
    result[field] = id;
  }
  return result;
}

function emptyPlugin(id, name, marketplace, enabled, configured) {
  return {
    id,
    key: `codex:${id}`,
    agentId: "codex",
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
    version: "",
    versions: [],
    enabled,
    configured,
    installed: false,
    scope: "user",
    source: "codex-plugin-cache",
    manifestStatus: "missing",
    components: { skills: [], mcpServers: [], apps: [], hooks: false },
    logo: null,
    logoDark: null,
    composerIcon: null,
  };
}

async function describePlugin({ id, name, marketplace, enabled, configured, cacheRoot, realCacheRoot, assets, roots, warnings }) {
  const plugin = emptyPlugin(id, name, marketplace, enabled, configured);
  const pluginDirectory = path.join(cacheRoot, marketplace, name);
  if (!(await exists(pluginDirectory))) return plugin;
  const realPluginDirectory = await realpathOrNull(pluginDirectory);
  if (!realCacheRoot || !realPluginDirectory || !isWithin(realCacheRoot, realPluginDirectory)) {
    warnings.push(`插件 ${id} 指向缓存目录之外，已跳过。`);
    return null;
  }
  const { versions, selected } = await selectVersion(pluginDirectory);
  plugin.versions = versions;
  if (!selected) return plugin;
  const versionRoot = await realpathOrNull(selected.path);
  roots.set(id, versionRoot);
  plugin.installed = true;
  plugin.version = selected.name;

  const manifestPath = await resolveInside(versionRoot, ".codex-plugin/plugin.json");
  const manifestResult = manifestPath
    ? await readBoundedJson(manifestPath, MANIFEST_LIMIT)
    : { status: "missing" };
  plugin.manifestStatus = manifestResult.status;
  if (manifestResult.status !== "ok") {
    const message = readStatusMessage(`插件 ${id} 的清单`, manifestResult.status);
    if (message) warnings.push(message);
    return plugin;
  }
  const manifest = object(manifestResult.value);
  const info = object(manifest.interface);
  plugin.version = text(manifest.version, 64) || selected.name;
  plugin.displayName = text(info.displayName, 80) || text(manifest.name, 80) || name;
  plugin.shortDescription = text(info.shortDescription, 240) || text(manifest.description, 240);
  plugin.longDescription = text(info.longDescription, 1_200);
  plugin.category = text(info.category, 60);
  plugin.developerName = text(info.developerName, 80) || text(object(manifest.author).name, 80);
  plugin.brandColor = /^#[0-9a-f]{3,8}$/iu.test(String(info.brandColor || "")) ? info.brandColor : null;
  plugin.capabilities = (Array.isArray(info.capabilities) ? info.capabilities : [])
    .map((item) => text(item, 40))
    .filter(Boolean)
    .slice(0, 8);
  plugin.keywords = (Array.isArray(manifest.keywords) ? manifest.keywords : [])
    .map((item) => text(item, 40))
    .filter(Boolean)
    .slice(0, 12);
  plugin.license = text(manifest.license, 40);
  plugin.homepage = homepageOrigin(manifest.homepage);
  plugin.components = await pluginComponents(versionRoot, manifest);
  Object.assign(plugin, await pluginAssets(id, plugin.version, versionRoot, info, assets));
  return plugin;
}

async function listCachedPluginKeys(cacheRoot) {
  const keys = [];
  for (const marketplace of await listDirectories(cacheRoot)) {
    for (const plugin of await listDirectories(path.join(cacheRoot, marketplace.name))) {
      keys.push(`${plugin.name}@${marketplace.name}`);
    }
  }
  return keys;
}

export async function scanCodexPlugins(homeDirectory = homedir()) {
  const codexRoot = path.join(homeDirectory, ".codex");
  const cacheRoot = path.join(codexRoot, "plugins", "cache");
  const result = {
    available: false,
    agentId: "codex",
    plugins: [],
    marketplaces: [],
    warnings: [],
    assets: new Map(),
    roots: new Map(),
  };
  if (!(await exists(codexRoot))) return result;
  result.available = true;

  const configResult = await readBoundedToml(path.join(codexRoot, "config.toml"), CONFIG_LIMIT);
  const configValid = configResult.status === "ok";
  if (!configValid && configResult.status !== "missing") {
    result.warnings.push(readStatusMessage("Codex config.toml", configResult.status));
  }
  const config = configValid ? object(configResult.value) : {};
  result.marketplaces = Object.entries(object(config.marketplaces))
    .filter(([name]) => safeSegment(name))
    .slice(0, 50)
    .map(([name, value]) => ({
      name,
      sourceType: ["local", "git", "github", "remote"].includes(object(value).source_type)
        ? object(value).source_type
        : "unknown",
    }));

  const configured = new Map();
  for (const [key, value] of Object.entries(object(config.plugins)).slice(0, PLUGIN_LIMIT)) {
    if (!splitPluginKey(key)) continue;
    const enabledValue = object(value).enabled;
    configured.set(key, typeof enabledValue === "boolean" ? enabledValue : "unknown");
  }
  const realCacheRoot = await realpathOrNull(cacheRoot);
  const cachedKeys = realCacheRoot ? await listCachedPluginKeys(cacheRoot) : [];
  const allKeys = [...new Set([...configured.keys(), ...cachedKeys])].slice(0, PLUGIN_LIMIT);

  for (const key of allKeys) {
    const { name, marketplace } = splitPluginKey(key);
    const isConfigured = configured.has(key);
    const plugin = await describePlugin({
      id: key,
      name,
      marketplace,
      // Cache presence alone never implies the plugin is enabled.
      enabled: isConfigured && configValid ? configured.get(key) : "unknown",
      configured: isConfigured,
      cacheRoot,
      realCacheRoot,
      assets: result.assets,
      roots: result.roots,
      warnings: result.warnings,
    });
    if (plugin) result.plugins.push(plugin);
  }
  const rank = (plugin) => (plugin.enabled === true ? 0 : plugin.enabled === "unknown" ? 1 : 2);
  result.plugins.sort(
    (left, right) =>
      rank(left) - rank(right) || left.displayName.localeCompare(right.displayName),
  );
  return result;
}

async function newestToolsCache(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  let newest = null;
  for (const entry of entries.slice(0, 200)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const info = await stat(path.join(directory, entry.name));
      if (!newest || info.mtimeMs > newest.mtimeMs) {
        newest = { path: path.join(directory, entry.name), mtimeMs: info.mtimeMs };
      }
    } catch {
      // Ignore files that disappear while Codex refreshes its cache.
    }
  }
  return newest;
}

export async function scanCodexConnectors(homeDirectory = homedir(), { plugins = [] } = {}) {
  const directory = path.join(homeDirectory, ".codex", "cache", "codex_apps_tools");
  const result = {
    available: false,
    agentId: "codex",
    source: "codex-cache",
    cachedAt: null,
    connectors: [],
    warnings: [],
  };
  const newest = await newestToolsCache(directory);
  if (!newest) return result;
  result.available = true;
  result.cachedAt = new Date(newest.mtimeMs).toISOString();
  const cache = await readBoundedJson(newest.path, TOOLS_CACHE_LIMIT);
  if (cache.status !== "ok") {
    result.warnings.push(readStatusMessage("Codex 连接器缓存", cache.status));
    return result;
  }
  const providers = new Map();
  for (const plugin of plugins) {
    for (const app of plugin.components?.apps || []) {
      if (!app.connectorId) continue;
      providers.set(app.connectorId, [...(providers.get(app.connectorId) || []), plugin.id]);
    }
  }
  const connectors = new Map();
  const tools = Array.isArray(object(cache.value).tools) ? cache.value.tools : [];
  for (const raw of tools.slice(0, 10_000)) {
    const tool = object(raw);
    const id = identifier(tool.connector_id);
    if (!id) continue;
    const connector = connectors.get(id) || {
      id,
      name: text(tool.connector_name, 80) || id,
      namespace: identifier(tool.tool_namespace) || null,
      description: text(tool.namespace_description, 600),
      toolCount: 0,
      toolNames: [],
      providedByPlugins: [...new Set(providers.get(id) || [])],
      source: "codex-cache",
      cachedAt: result.cachedAt,
    };
    connector.toolCount += 1;
    const inner = object(tool.tool);
    const toolName = text(inner.title, 80) || text(inner.name, 80) || text(tool.tool_name, 80);
    if (toolName && connector.toolNames.length < TOOL_NAME_LIMIT) connector.toolNames.push(toolName);
    connectors.set(id, connector);
  }
  result.connectors = [...connectors.values()].sort(
    (left, right) => right.toolCount - left.toolCount || left.name.localeCompare(right.name),
  );
  return result;
}
