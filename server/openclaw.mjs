import { lstat, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { envFor, expandUserPath, parseYamlSafe, readAppBundle, readJson5File } from "./config-files.mjs";
import { safeIdentifier } from "./config-mask.mjs";
import { frontmatterBlock } from "./frontmatter.mjs";
import {
  compactHomePath,
  exists,
  isWithin,
  object,
  readBoundedJson,
  readBoundedText,
  realpathOrNull,
  text,
} from "./fs-safe.mjs";
import { capabilityId } from "./workbuddy-experts.mjs";

/**
 * OpenClaw and OpenClaw distributions (QClaw), read-only.
 *
 * Mirrors OpenClaw 2026.4 skill loading: roots are scanned one level deep
 * (<root>/<name>/SKILL.md, or <root>/skills/<name>/SKILL.md when nested), symlinks whose
 * real path escapes the root are skipped by the product, and for the same skill name
 * later sources win: extraDirs < bundled < <stateDir>/skills < ~/.agents/skills <
 * <workspace>/.agents/skills < <workspace>/skills. Credentials (auth profiles, device
 * auth, paired devices, gateway/channel tokens, provider keys) are never read.
 */

const WORKSPACE_FILES = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "TOOLS.md", "HEARTBEAT.md", "MEMORY.md"];
const SENSITIVE_STATE_FILES = ["credentials", "auth-profiles.json", "identity/device-auth.json", "devices/paired.json"];
const CHILD_LIMIT = 500;
const SESSION_FILE_LIMIT = 4_000_000;
const SESSION_FILES_SCANNED = 30;
const WINDOW_MS = 30 * 86_400_000;

export const OPENCLAW_PRODUCTS = {
  openclaw: { id: "openclaw", name: "OpenClaw", shortName: "OCL", color: "#e8836b" },
  qclaw: { id: "qclaw", name: "QClaw", shortName: "QC", color: "#6fa8f5" },
};

const QCLAW_APP_SUPPORT = (homeDirectory) => path.join(homeDirectory, "Library", "Application Support", "QClaw");

async function readRuntimePackage(directory) {
  if (!directory) return null;
  const pkg = await readBoundedJson(path.join(directory, "package.json"), 512_000);
  return pkg.status === "ok" && object(pkg.value).name === "openclaw"
    ? { dir: directory, version: text(String(object(pkg.value).version || ""), 40) || null }
    : null;
}

/** Locates state dir, config and runtime for generic OpenClaw or QClaw. */
export async function resolveOpenClawInstall(kind, homeDirectory = homedir()) {
  const install = {
    kind,
    homeDirectory,
    available: false,
    stateDir: null,
    configPath: null,
    config: {},
    configStatus: "missing",
    runtime: null,
    appVersion: null,
    managedBy: [],
    warnings: [],
  };
  const insideHome = (value) => typeof value === "string" && path.isAbsolute(value) && isWithin(homeDirectory, path.resolve(value));
  if (kind === "qclaw") {
    const meta = await readBoundedJson(path.join(homeDirectory, ".qclaw", "qclaw.json"), 512_000);
    const value = meta.status === "ok" ? object(meta.value) : {};
    // Only the paths are used; guid, sessionId and gateway URLs are identifiers and are not read further.
    install.stateDir = insideHome(value.stateDir) ? path.resolve(value.stateDir) : path.join(homeDirectory, ".qclaw");
    install.configPath = insideHome(value.configPath) ? path.resolve(value.configPath) : path.join(install.stateDir, "openclaw.json");
    const openclawMjs = object(value.cli).openclawMjs;
    install.runtime = await readRuntimePackage(
      typeof openclawMjs === "string" && path.isAbsolute(openclawMjs) ? path.dirname(openclawMjs) : null,
    );
    if (!install.runtime) {
      install.runtime = await readRuntimePackage(path.join(QCLAW_APP_SUPPORT(homeDirectory), "openclaw", "node_modules", "openclaw"));
    }
    // Detection relies on QClaw's own files; the app bundle only adds its version.
    install.available = meta.status === "ok" || (await exists(path.join(install.stateDir, "openclaw.json")));
    const app = install.available && process.platform === "darwin" ? await readAppBundle("/Applications/QClaw.app") : null;
    install.appVersion = app?.bundleId === "com.tencent.qclaw" ? app.version : null;
  } else {
    const configuredState = envFor(homeDirectory, "OPENCLAW_STATE_DIR");
    const candidates = configuredState
      ? [expandUserPath(configuredState, { homeDirectory })]
      : [".openclaw", ".clawdbot", ".moltbot"].map((name) => path.join(homeDirectory, name));
    for (const candidate of candidates) {
      if (candidate && (await exists(candidate))) {
        install.stateDir = candidate;
        break;
      }
    }
    if (!install.stateDir) return install;
    const configuredConfig = envFor(homeDirectory, "OPENCLAW_CONFIG_PATH");
    install.configPath = configuredConfig
      ? expandUserPath(configuredConfig, { homeDirectory })
      : path.join(install.stateDir, "openclaw.json");
    if (homeDirectory === homedir()) {
      for (const candidate of ["/opt/homebrew/lib/node_modules/openclaw", "/usr/local/lib/node_modules/openclaw", path.join(homeDirectory, ".npm-global", "lib", "node_modules", "openclaw")]) {
        install.runtime = await readRuntimePackage(candidate);
        if (install.runtime) break;
      }
    }
    install.available = true;
  }
  const config = await readJson5File(install.configPath);
  install.configStatus = config.status;
  if (config.status === "ok") install.config = object(config.value);
  else if (config.status !== "missing") install.warnings.push(`${OPENCLAW_PRODUCTS[kind].name} 配置文件无法解析，已按默认设置读取。`);
  install.version = text(String(object(install.config.meta).lastTouchedVersion || ""), 40) || install.runtime?.version || null;
  // Tools that write into this state dir leave recognisable markers.
  const agentsMd = await readBoundedText(path.join(install.stateDir, "AGENTS.md"), 512_000);
  if (
    (agentsMd.status === "ok" && agentsMd.text.includes("<!-- lumiclaw:begin -->")) ||
    (await exists(path.join(install.stateDir, "LUMICLAW.md"))) ||
    (await exists(path.join(install.stateDir, ".lumiclaw")))
  ) {
    install.managedBy.push("LumiClaw");
  }
  if (object(object(install.config.plugins).entries)["vibe-island"]) install.managedBy.push("Vibe Island");
  return install;
}

/** Agents declared in config (agents.list or agents.entries), or the implied "main". */
export function openClawAgents(install) {
  const agents = object(install.config.agents);
  const defaults = object(agents.defaults);
  let declared = Array.isArray(agents.list)
    ? agents.list.map((entry) => object(entry))
    : Object.entries(object(agents.entries)).map(([id, entry]) => ({ id, ...object(entry) }));
  declared = declared.filter((entry) => typeof entry.id === "string" && /^[\w.-]{1,64}$/u.test(entry.id)).slice(0, 100);
  const implied = declared.length === 0;
  if (implied) declared = [{ id: "main", default: true }];
  const defaultId = (declared.find((entry) => entry.default === true) || declared[0]).id;
  const defaultWorkspace =
    (typeof defaults.workspace === "string" && expandUserPath(defaults.workspace, { homeDirectory: install.homeDirectory })) ||
    path.join(install.stateDir, "workspace");
  return declared.map((entry) => ({
    ...entry,
    implied,
    isDefault: entry.id === defaultId,
    workspace:
      (typeof entry.workspace === "string" && expandUserPath(entry.workspace, { homeDirectory: install.homeDirectory })) ||
      (entry.id === defaultId ? defaultWorkspace : path.join(install.stateDir, `workspace-${entry.id}`)),
  }));
}

/** One-level discovery, honouring a nested `skills/` folder like the product does. */
export async function discoverOpenClawSkills(root) {
  const realRoot = await realpathOrNull(root);
  if (!realRoot) return [];
  let base = root;
  const nested = path.join(root, "skills");
  if ((await stat(nested).catch(() => null))?.isDirectory()) {
    const children = await readdir(nested, { withFileTypes: true }).catch(() => []);
    for (const child of children.slice(0, 100)) {
      if (await exists(path.join(nested, child.name, "SKILL.md"))) {
        base = nested;
        break;
      }
    }
  }
  const realBase = await realpathOrNull(base);
  const entries = (await readdir(base, { withFileTypes: true }).catch(() => []))
    .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith("."))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, CHILD_LIMIT);
  const results = [];
  for (const entry of entries) {
    const skillPath = path.join(base, entry.name);
    const realPath = await realpathOrNull(skillPath);
    if (!realPath || !(await stat(realPath).catch(() => null))?.isDirectory()) continue;
    if (!(await exists(path.join(skillPath, "SKILL.md")))) continue;
    results.push({ skillPath, realPath, escaped: !isWithin(realBase, realPath) });
  }
  return results;
}

function requirementsFrom(source) {
  const frontmatter = parseYamlSafe(frontmatterBlock(source));
  const metadata = object(object(frontmatter).metadata);
  const block = object(metadata.openclaw || metadata.clawdbot || metadata.clawdis);
  if (!Object.keys(block).length) return null;
  const requires = object(block.requires);
  const list = (value) =>
    (Array.isArray(value) ? value : [])
      .filter((item) => typeof item === "string")
      .map((item) => safeIdentifier(item) || "••••••")
      .slice(0, 30);
  return {
    bins: list(requires.bins),
    anyBins: list(requires.anyBins),
    env: list(requires.env),
    config: list(requires.config),
    os: list(block.os),
    emoji: typeof block.emoji === "string" ? text(block.emoji, 8) : null,
    install: (Array.isArray(block.install) ? block.install : [])
      .map((item) => safeIdentifier(object(item).kind) || null)
      .filter(Boolean)
      .slice(0, 10),
  };
}

function sourceKind(install, directory, homeDirectory) {
  const resolved = path.resolve(directory);
  const qclawSupport = path.join(QCLAW_APP_SUPPORT(homeDirectory), "openclaw", "config", "skills");
  if (resolved === path.join(homeDirectory, ".agents", "skills")) return { source: "agents-skills-personal", label: "~/.agents/skills" };
  if (install.kind === "qclaw" && resolved === qclawSupport) return { source: "qclaw-config", label: "QClaw 内置配置", readOnly: true, managed: true };
  if (install.kind === "qclaw" && resolved === path.join(install.stateDir, "skills")) return { source: "qclaw-remote", label: "QClaw 同步", readOnly: true, managed: true };
  if (install.kind === "qclaw" && resolved === path.join(install.stateDir, "skillhub-skills")) return { source: "skillhub", label: "SkillHub", readOnly: true, managed: true };
  return { source: "openclaw-extra", label: "额外目录" };
}

async function qclawRemoteMeta(install) {
  if (install.kind !== "qclaw") return new Map();
  const meta = await readBoundedJson(path.join(install.stateDir, "skills", ".remote-skills-meta.json"), 2_000_000);
  const skills = meta.status === "ok" ? object(object(meta.value).skills) : {};
  return new Map(
    Object.entries(skills).slice(0, 2_000).map(([name, raw]) => [
      name,
      {
        version: text(String(object(raw).version ?? ""), 40) || null,
        type: safeIdentifier(object(raw).type) || null,
        installMode: safeIdentifier(object(raw).install_mode) || null,
        effectScope: safeIdentifier(object(raw).effect_scope) || null,
      },
    ]),
  );
}

/**
 * Skill sources for scanAll, with OpenClaw's precedence. QClaw sources are all
 * read-only: QClaw syncs and cleans its skill folders itself.
 */
export async function openClawSkillSources(kind, homeDirectory = homedir()) {
  const install = await resolveOpenClawInstall(kind, homeDirectory);
  if (!install.available) return { available: false, sources: [], warnings: [], installRoot: null };
  const readOnlyProduct = kind === "qclaw";
  const skillsConfig = object(install.config.skills);
  const entries = object(skillsConfig.entries);
  const remote = await qclawRemoteMeta(install);
  const allowTargets = (Array.isArray(object(skillsConfig.load).allowSymlinkTargets) ? object(skillsConfig.load).allowSymlinkTargets : [])
    .map((value) => expandUserPath(String(value), { homeDirectory }))
    .filter(Boolean);
  const agents = openClawAgents(install);
  const descriptors = [];
  const add = (directory, details) => {
    if (!directory) return;
    const resolved = path.resolve(directory);
    const existing = descriptors.find((item) => item.path === resolved && item.scope === details.scope);
    if (existing && existing.precedence >= details.precedence) return;
    if (existing) descriptors.splice(descriptors.indexOf(existing), 1);
    descriptors.push({ path: resolved, ...details });
  };
  const extraDirs = Array.isArray(object(skillsConfig.load).extraDirs) ? object(skillsConfig.load).extraDirs : [];
  for (const directory of extraDirs.slice(0, 32)) {
    const resolved = expandUserPath(String(directory), { homeDirectory });
    if (resolved) add(resolved, { ...sourceKind(install, resolved, homeDirectory), precedence: 0, scope: "global" });
  }
  if (install.runtime) {
    add(path.join(install.runtime.dir, "skills"), { source: "openclaw-bundled", label: "内置", readOnly: true, managed: true, precedence: 1, scope: "global" });
  }
  const managedDir = path.join(install.stateDir, "skills");
  add(managedDir, { ...(kind === "qclaw" ? sourceKind(install, managedDir, homeDirectory) : { source: "openclaw-managed", label: "" }), precedence: 2, scope: "global" });
  add(path.join(homeDirectory, ".agents", "skills"), { source: "agents-skills-personal", label: "~/.agents/skills", precedence: 3, scope: "global" });
  for (const agent of agents) {
    add(path.join(agent.workspace, ".agents", "skills"), { source: "agents-skills-project", label: `工作区 ${agent.id}`, precedence: 4, scope: agent.id });
    add(path.join(agent.workspace, "skills"), { source: "openclaw-workspace", label: `工作区 ${agent.id}`, precedence: 5, scope: agent.id });
  }
  const escapeWarnings = { count: 0 };
  const sources = descriptors
    .filter((descriptor) => descriptor.path)
    .map((descriptor) => ({
      path: descriptor.path,
      readOnly: readOnlyProduct || Boolean(descriptor.readOnly),
      label: descriptor.label,
      precedence: descriptor.precedence,
      scope: descriptor.scope,
      scopes: descriptor.scope === "global" ? agents.map((agent) => agent.id) : [descriptor.scope],
      firstWins: false,
      discover: async () => {
        const found = await discoverOpenClawSkills(descriptor.path);
        return found.map((item) => ({
          ...item,
          escaped: item.escaped && !allowTargets.some((target) => isWithin(target, item.realPath)),
        }));
      },
      annotate: async (instance, skillPath, found) => {
        Object.assign(instance, { source: descriptor.source, sourceLabel: descriptor.label || instance.sourceLabel });
        if (descriptor.managed) instance.managed = true;
        if (readOnlyProduct || descriptor.readOnly) instance.readOnly = true;
        if ((await exists(path.join(skillPath, ".clawhub", "origin.json"))) || (await exists(path.join(skillPath, ".clawdhub", "origin.json")))) {
          Object.assign(instance, { source: "clawhub", sourceLabel: "ClawHub", readOnly: true, managed: true });
        }
        if (found?.escaped) {
          instance.hiddenByProduct = "symlink-escape";
          escapeWarnings.count += 1;
        }
        const entry = object(entries[instance.name] || entries[instance.directoryName]);
        if (entry.enabled === false) instance.disabled = true;
        const remoteMeta = remote.get(instance.directoryName) || remote.get(instance.name);
        if (remoteMeta && descriptor.source === "qclaw-remote") instance.remote = remoteMeta;
        const skillFile = await readBoundedText(path.join(skillPath, "SKILL.md"), 65_536);
        const requirements = skillFile.status === "ok" ? requirementsFrom(skillFile.text) : null;
        if (requirements) instance.requirements = requirements;
      },
    }));
  return {
    available: true,
    sources,
    installRoot: readOnlyProduct ? null : managedDir,
    copyOnly: true,
    refuseInstall: readOnlyProduct ? "QClaw 的技能由 QClaw 同步管理，请在 QClaw 里安装。" : null,
    warnings: install.warnings,
    escapeWarnings,
    install,
  };
}

// ---------------------------------------------------------------------------
// Capabilities, MCP, plugins, settings and activity

function parseIdentity(source) {
  const fields = {};
  for (const line of source.split("\n").slice(0, 200)) {
    const match = line.match(/^\s*[-*]\s*\*{0,2}(Name|Emoji|Vibe|Creature|Theme)\*{0,2}\s*[:：]\s*(.{1,200})$/iu);
    if (match) fields[match[1].toLowerCase()] = text(match[2].replace(/[*_`]/gu, ""), 120);
  }
  return fields;
}

export async function scanOpenClawAgents(kind, homeDirectory = homedir()) {
  const product = OPENCLAW_PRODUCTS[kind];
  const install = await resolveOpenClawInstall(kind, homeDirectory);
  const homes = [homeDirectory, homedir()];
  const base = {
    id: product.id,
    name: product.name,
    shortName: product.shortName,
    color: product.color,
    kindLabel: "Agent",
    sourcePath: install.stateDir ? compactHomePath(install.stateDir, homes) : "",
    available: false,
    catalogCount: 0,
    itemCount: 0,
    memberCount: 0,
    items: [],
    managedBy: install.managedBy,
  };
  if (!install.available) return base;
  const defaults = object(object(install.config.agents).defaults);
  const items = [];
  for (const agent of openClawAgents(install)) {
    const files = [];
    for (const fileName of WORKSPACE_FILES) {
      const info = await lstat(path.join(agent.workspace, fileName)).catch(() => null);
      if (info?.isFile()) files.push({ name: fileName, size: info.size });
    }
    const identityRead = files.some((file) => file.name === "IDENTITY.md")
      ? await readBoundedText(path.join(agent.workspace, "IDENTITY.md"), 256_000)
      : null;
    const identity = identityRead?.status === "ok" ? parseIdentity(identityRead.text) : {};
    const model = object(agent.model).primary || (typeof agent.model === "string" ? agent.model : object(defaults.model).primary);
    items.push({
      id: capabilityId(kind, `${install.stateDir}:${agent.id}`),
      productId: kind,
      productName: product.name,
      productShortName: product.shortName,
      productColor: product.color,
      kind: "agent",
      kindLabel: agent.isDefault ? "默认 Agent" : "Agent",
      origin: "agent",
      originLabel: product.name,
      name: agent.id,
      displayName: text(identity.name || (typeof agent.name === "string" ? agent.name : object(agent.identity).name) || agent.id, 80),
      emoji: identity.emoji || null,
      description: text(identity.vibe || "", 400) || `${product.name} Agent ${agent.id}`,
      profession: "",
      version: install.version || "",
      tags: [agent.isDefault ? "默认" : "", agent.implied ? "隐含" : ""].filter(Boolean),
      members: [],
      memberCount: 0,
      fileCount: files.length,
      connectorCount: 0,
      skillCount: Array.isArray(agent.skills) ? agent.skills.length : 0,
      skillsAllowlist: Array.isArray(agent.skills) ? agent.skills.map((name) => safeIdentifier(String(name)) || "••••••").slice(0, 100) : null,
      model: safeIdentifier(model) || "",
      heartbeat: Boolean(agent.heartbeat || defaults.heartbeat),
      subagents: Boolean(agent.subagents),
      sandbox: Boolean(agent.sandbox),
      isDefault: agent.isDefault,
      implied: agent.implied,
      workspacePath: compactHomePath(agent.workspace, homes),
      workspaceFiles: files,
      managedBy: install.managedBy,
      sourcePath: compactHomePath(agent.workspace, homes),
      primaryFilePath: files[0]?.name || null,
      modifiedAt: new Date().toISOString(),
      rootPath: agent.workspace,
      allowedFiles: new Set(files.map((file) => file.name)),
      virtualFiles: new Map(),
    });
  }
  return { ...base, available: true, catalogCount: items.length, itemCount: items.length, items };
}

export async function openClawMcpEntries(kind, homeDirectory = homedir()) {
  const install = await resolveOpenClawInstall(kind, homeDirectory);
  if (!install.available || install.configStatus !== "ok") return { entries: [], warnings: install.warnings };
  const homes = [homeDirectory, homedir()];
  return {
    entries: Object.entries(object(object(install.config.mcp).servers))
      .slice(0, 300)
      .filter(([name]) => /^[\p{L}\p{N}_.:@ -]{1,160}$/u.test(name))
      .map(([name, value]) => ({
        name,
        config: object(value),
        agentId: kind,
        scope: "user",
        projectPath: null,
        source: compactHomePath(install.configPath, homes),
        format: "json",
      })),
    warnings: install.warnings,
  };
}

async function pluginDirectories(directory) {
  const found = [];
  if (await exists(path.join(directory, "openclaw.plugin.json"))) return [directory];
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.slice(0, 300)) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const child = path.join(directory, entry.name);
    if (await exists(path.join(child, "openclaw.plugin.json"))) found.push(child);
  }
  return found;
}

export async function scanOpenClawPlugins(kind, homeDirectory = homedir()) {
  const install = await resolveOpenClawInstall(kind, homeDirectory);
  const result = { available: false, agentId: kind, plugins: [], marketplaces: [], warnings: [], roots: new Map() };
  if (!install.available) return result;
  result.available = true;
  const pluginsConfig = object(install.config.plugins);
  const allow = new Set(Array.isArray(pluginsConfig.allow) ? pluginsConfig.allow : []);
  const deny = new Set(Array.isArray(pluginsConfig.deny) ? pluginsConfig.deny : []);
  const entries = object(pluginsConfig.entries);
  const sources = [];
  if (install.runtime) sources.push({ directory: path.join(install.runtime.dir, "extensions"), source: "openclaw-bundled" });
  sources.push({ directory: path.join(install.stateDir, "extensions"), source: "openclaw-extension" });
  for (const agent of openClawAgents(install)) {
    sources.push({ directory: path.join(agent.workspace, ".openclaw", "extensions"), source: "openclaw-workspace" });
  }
  for (const loadPath of (Array.isArray(object(pluginsConfig.load).paths) ? object(pluginsConfig.load).paths : []).slice(0, 20)) {
    const resolved = expandUserPath(String(loadPath), { homeDirectory });
    if (resolved) sources.push({ directory: resolved, source: "openclaw-load-path" });
  }
  const seen = new Set();
  for (const { directory, source } of sources) {
    for (const pluginDir of await pluginDirectories(directory)) {
      const real = await realpathOrNull(pluginDir);
      if (!real || seen.has(real)) continue;
      seen.add(real);
      const manifest = await readBoundedJson(path.join(real, "openclaw.plugin.json"), 256_000);
      if (manifest.status !== "ok") continue;
      const value = object(manifest.value);
      const id = /^[\w.@/-]{1,128}$/u.test(String(value.id || "")) ? String(value.id) : path.basename(real);
      const pkg = await readBoundedJson(path.join(real, "package.json"), 256_000);
      const entry = object(entries[id]);
      const enabled =
        pluginsConfig.enabled === false || deny.has(id)
          ? false
          : typeof entry.enabled === "boolean"
            ? entry.enabled
            : allow.has(id)
              ? true
              : "unknown";
      const key = `${kind}:${source}:${id}`;
      result.roots.set(key, real);
      result.plugins.push({
        id,
        key,
        agentId: kind,
        kind: "plugin",
        name: id,
        marketplace: source,
        displayName: text(value.name, 80) || id,
        shortDescription: text(value.description, 400),
        longDescription: "",
        category: "",
        developerName: "",
        brandColor: null,
        capabilities: [],
        keywords: [],
        license: "",
        homepage: "",
        version: pkg.status === "ok" ? text(String(object(pkg.value).version || ""), 40) : "",
        versions: [],
        enabled,
        configured: id in entries || allow.has(id) || deny.has(id),
        installed: true,
        scope: "user",
        projectPath: null,
        source,
        manifestStatus: "ok",
        components: {
          skills: Array.isArray(value.skills) ? value.skills.map((item) => text(String(item), 80)).slice(0, 50) : [],
          mcpServers: [],
          apps: [],
          hooks: false,
          channels: Array.isArray(value.channels) ? value.channels.map((item) => safeIdentifier(String(item)) || "••••••").slice(0, 20) : [],
        },
        logo: null,
        logoDark: null,
        composerIcon: null,
      });
    }
  }
  return result;
}

export async function openClawSettingsDetail(kind, homeDirectory = homedir(), homes = [homeDirectory]) {
  const install = await resolveOpenClawInstall(kind, homeDirectory);
  if (!install.available) return null;
  const product = OPENCLAW_PRODUCTS[kind];
  const config = install.config;
  const agents = openClawAgents(install);
  const skillsConfig = object(config.skills);
  const pluginsConfig = object(config.plugins);
  const gateway = object(config.gateway);
  const channels = Object.entries(object(config.channels)).map(
    ([name, value]) => `${safeIdentifier(name) || "••••••"}${object(value).enabled === false ? "（停用）" : ""}`,
  );
  const sensitive = [];
  for (const relative of SENSITIVE_STATE_FILES) {
    if (await exists(path.join(install.stateDir, relative))) sensitive.push(relative);
  }
  const remote = kind === "qclaw" ? await readBoundedJson(path.join(install.stateDir, "skills", ".remote-skills-meta.json"), 2_000_000) : null;
  const row = (label, value) => ({ label, value: String(value ?? "无") });
  const extraDirs = (Array.isArray(object(skillsConfig.load).extraDirs) ? object(skillsConfig.load).extraDirs : [])
    .map((value) => expandUserPath(String(value), { homeDirectory }))
    .filter(Boolean)
    .map((value) => compactHomePath(value, homes));
  return {
    title: `${product.name} 配置`,
    location: compactHomePath(install.configPath, homes),
    rows: [
      row("版本", [install.version && `配置 ${install.version}`, install.runtime?.version && `运行时 ${install.runtime.version}`, install.appVersion && `应用 ${install.appVersion}`].filter(Boolean).join("，") || "未知"),
      row("状态目录", compactHomePath(install.stateDir, homes)),
      row("由谁写入", install.managedBy.join("、") || "未发现其他管理工具"),
      row("默认模型", safeIdentifier(object(object(object(config.agents).defaults).model).primary) || "未设置"),
      row("Agent", agents.map((agent) => `${agent.id}${agent.isDefault ? "（默认）" : ""}${agent.implied ? "（未声明，按 main 处理）" : ""}`).join("、")),
      row("工作区", agents.map((agent) => compactHomePath(agent.workspace, homes)).join("、")),
      row("技能额外目录", extraDirs.join("、") || "无"),
      row("已停用技能", Object.values(object(skillsConfig.entries)).filter((entry) => object(entry).enabled === false).length),
      row(
        "插件",
        `${pluginsConfig.enabled === false ? "全部停用" : "启用"}；配置 ${Object.keys(object(pluginsConfig.entries)).length} 个，允许 ${Array.isArray(pluginsConfig.allow) ? pluginsConfig.allow.length : 0} 个，拒绝 ${Array.isArray(pluginsConfig.deny) ? pluginsConfig.deny.length : 0} 个`,
      ),
      row("频道", channels.join("、") || "无"),
      row(
        "网关",
        `${safeIdentifier(gateway.mode) || "默认"}；绑定 ${safeIdentifier(gateway.bind) || "默认"}；端口 ${Number.isInteger(gateway.port) ? gateway.port : "默认"}；认证 ${safeIdentifier(object(gateway.auth).mode) || "未设置"}`,
      ),
      row("MCP 数", Object.keys(object(object(config.mcp).servers)).length),
      row("凭据文件", sensitive.length ? `${sensitive.join("、")}（只检测存在，不读取内容）` : "无"),
      ...(remote?.status === "ok"
        ? [row("技能同步", `${Object.keys(object(object(remote.value).skills)).length} 个远程技能；最近同步 ${text(String(object(remote.value).last_sync || ""), 40) || "未知"}`)]
        : []),
    ],
  };
}

/** sessions.json token totals for the last 30 days, plus inferred per-skill reads. */
export async function readOpenClawActivity(kind, homeDirectory = homedir(), { now = Date.now() } = {}) {
  const install = await resolveOpenClawInstall(kind, homeDirectory);
  const result = { available: false, sessions30d: 0, tokens30d: 0, costUsd30d: 0, lastActiveAt: null, skillReads: new Map(), warnings: [] };
  if (!install.available) return result;
  let latest = 0;
  let scanned = 0;
  for (const agent of openClawAgents(install)) {
    const sessionsDir = path.join(install.stateDir, "agents", agent.id, "sessions");
    const store = await readBoundedJson(path.join(sessionsDir, "sessions.json"), 20_000_000);
    if (store.status !== "ok") continue;
    result.available = true;
    for (const raw of Object.values(object(store.value)).slice(0, 20_000)) {
      const entry = object(raw);
      const updated = Number(entry.updatedAt) || 0;
      latest = Math.max(latest, updated);
      if (updated < now - WINDOW_MS) continue;
      result.sessions30d += 1;
      result.tokens30d += Number(entry.totalTokens) || (Number(entry.inputTokens) || 0) + (Number(entry.outputTokens) || 0);
      result.costUsd30d += Number(entry.estimatedCostUsd) || 0;
      if (scanned < SESSION_FILES_SCANNED && typeof entry.sessionId === "string" && /^[\w-]{1,128}$/u.test(entry.sessionId)) {
        scanned += 1;
        const transcript = await readBoundedText(path.join(sessionsDir, `${entry.sessionId}.jsonl`), SESSION_FILE_LIMIT);
        if (transcript.status !== "ok") continue;
        for (const match of transcript.text.matchAll(/skills[\\/]{1,2}([\w.-]{1,128})[\\/]{1,2}SKILL\.md/gu)) {
          result.skillReads.set(match[1], (result.skillReads.get(match[1]) || 0) + 1);
        }
      }
    }
  }
  result.costUsd30d = Math.round(result.costUsd30d * 100) / 100;
  result.lastActiveAt = latest ? new Date(latest).toISOString() : null;
  if (!result.available && (await exists(path.join(install.stateDir, "agents")))) {
    result.warnings.push(`${OPENCLAW_PRODUCTS[kind].name} 没有可读取的会话记录。`);
  }
  return result;
}
