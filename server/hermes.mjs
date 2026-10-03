import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { envFor, expandUserPath, readAppBundle, readYamlFile } from "./config-files.mjs";
import { maskConfig, safeIdentifier } from "./config-mask.mjs";
import { frontmatterBlock, readYamlScalar } from "./frontmatter.mjs";
import {
  compactHomePath,
  exists,
  hostnameOf,
  isSensitiveFileName,
  isWithin,
  object,
  readBoundedJson,
  readBoundedText,
  realpathOrNull,
  text,
} from "./fs-safe.mjs";
import { capabilityId } from "./workbuddy-experts.mjs";

/**
 * Hermes Agent (Nous Research), read-only.
 *
 * Mirrors Hermes' own skill discovery (agent/skill_utils.py, v0.20): $HERMES_HOME/skills
 * is walked recursively following symlinks, skipping metadata/VCS/dependency dirs and
 * the support dirs (references/templates/assets/scripts) of a skill; `_org/<id>` only
 * for the id in `_org/.active_org`; `skills.external_dirs` are extra roots, and the
 * first skill with a given name wins. `.env`, `auth.json` and channel directories are
 * never opened.
 */

const EXCLUDED_DIRS = new Set([
  ".git", ".github", ".hub", ".archive", ".venv", "venv", "node_modules", "site-packages",
  "__pycache__", ".tox", ".nox", ".pytest_cache", ".mypy_cache", ".ruff_cache",
]);
const SUPPORT_DIRS = new Set(["references", "templates", "assets", "scripts"]);
const ORG_DIR = "_org";
const WALK_BUDGET = 5_000;
const WALK_DEPTH = 8;
const USAGE_LIMIT = 4_000_000;
const ACTIVITY_WINDOW_DAYS = 30;

export function hermesHomeFor(homeDirectory = homedir()) {
  const configured = envFor(homeDirectory, "HERMES_HOME");
  return configured
    ? expandUserPath(configured, { homeDirectory })
    : path.join(homeDirectory, ".hermes");
}

const nameSet = (value) =>
  new Set(
    (Array.isArray(value) ? value : typeof value === "string" ? [value] : [])
      .filter((item) => typeof item === "string" && item.trim())
      .map((item) => item.trim()),
  );

async function readBundledManifest(skillsDir) {
  const read = await readBoundedText(path.join(skillsDir, ".bundled_manifest"), 1_000_000);
  if (read.status !== "ok") return new Set();
  return new Set(
    read.text
      .split("\n")
      .map((line) => line.split(":", 1)[0].trim())
      .filter((name) => /^[\w.-]{1,128}$/u.test(name)),
  );
}

async function readHubNames(skillsDir) {
  const read = await readBoundedJson(path.join(skillsDir, ".hub", "lock.json"), 4_000_000);
  if (read.status !== "ok") return new Set();
  return new Set(Object.keys(object(object(read.value).installed)).filter((name) => /^[\w.-]{1,128}$/u.test(name)));
}

async function readActiveOrg(skillsDir) {
  const read = await readBoundedText(path.join(skillsDir, ORG_DIR, ".active_org"), 4_096);
  const value = read.status === "ok" ? read.text.trim() : "";
  return /^[\w.-]{1,128}$/u.test(value) ? value : null;
}

/** skills/.usage.json → Map(name → usage). Only counters, timestamps and state are kept. */
async function readUsage(skillsDir) {
  const read = await readBoundedJson(path.join(skillsDir, ".usage.json"), USAGE_LIMIT);
  const usage = new Map();
  if (read.status !== "ok") return { usage, status: read.status };
  for (const [name, raw] of Object.entries(object(read.value)).slice(0, 10_000)) {
    const entry = object(raw);
    usage.set(name, {
      count: Number(entry.use_count) || 0,
      viewCount: Number(entry.view_count) || 0,
      patchCount: Number(entry.patch_count) || 0,
      lastUsedAt: typeof entry.last_used_at === "string" ? text(entry.last_used_at, 40) : null,
      lastViewedAt: typeof entry.last_viewed_at === "string" ? text(entry.last_viewed_at, 40) : null,
      state: safeIdentifier(entry.state) || null,
      pinned: entry.pinned === true,
      createdBy: safeIdentifier(entry.created_by) || null,
      archivedAt: typeof entry.archived_at === "string" ? text(entry.archived_at, 40) : null,
    });
  }
  return { usage, status: "ok" };
}

/** Hermes-faithful recursive discovery; returns { skillPath, realPath } deduped by real path. */
export async function discoverHermesSkills(root, { activeOrg = null, includeExcluded = false } = {}) {
  const results = [];
  const seen = new Set();
  let budget = WALK_BUDGET;
  const realRoot = await realpathOrNull(root);
  if (!realRoot) return results;
  async function visit(directory, depth) {
    if (budget <= 0 || depth > WALK_DEPTH) return;
    budget -= 1;
    const realDirectory = await realpathOrNull(directory);
    if (!realDirectory || seen.has(`dir:${realDirectory}`)) return;
    seen.add(`dir:${realDirectory}`);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    const hasSkill = depth > 0 && entries.some((entry) => entry.name === "SKILL.md" && (entry.isFile() || entry.isSymbolicLink()));
    if (hasSkill && !seen.has(`skill:${realDirectory}`)) {
      seen.add(`skill:${realDirectory}`);
      results.push({ skillPath: directory, realPath: realDirectory });
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (!includeExcluded && EXCLUDED_DIRS.has(entry.name)) continue;
      if (hasSkill && SUPPORT_DIRS.has(entry.name)) continue;
      if (depth === 0 && entry.name === ORG_DIR && !activeOrg) continue;
      if (depth === 1 && path.basename(directory) === ORG_DIR && entry.name !== activeOrg) continue;
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          if (!(await stat(child)).isDirectory()) continue;
        } catch {
          continue;
        }
      }
      await visit(child, depth + 1);
    }
  }
  await visit(root, 0);
  return results;
}

/** Parsed Hermes home: config, skill provenance sets, usage and profiles. */
export async function loadHermesHome(hermesHome, { homeDirectory = homedir(), profile = null } = {}) {
  const skillsDir = path.join(hermesHome, "skills");
  const state = {
    available: await exists(hermesHome),
    hermesHome,
    skillsDir,
    profile,
    config: {},
    configStatus: "missing",
    externalDirs: [],
    bundledNames: new Set(),
    hubNames: new Set(),
    disabled: new Set(),
    platformDisabled: new Map(),
    usage: new Map(),
    usageStatus: "missing",
    activeOrg: null,
    warnings: [],
  };
  if (!state.available) return state;
  const config = await readYamlFile(path.join(hermesHome, "config.yaml"));
  state.configStatus = config.status;
  if (config.status === "ok") state.config = object(config.value);
  else if (config.status !== "missing") state.warnings.push("Hermes config.yaml 无法解析，已按默认设置读取技能。");
  const skillsConfig = object(state.config.skills);
  state.disabled = nameSet(skillsConfig.disabled);
  for (const [platform, names] of Object.entries(object(skillsConfig.platform_disabled)).slice(0, 50)) {
    for (const name of nameSet(names)) {
      state.platformDisabled.set(name, [...(state.platformDisabled.get(name) || []), text(platform, 40)]);
    }
  }
  const rawExternal = typeof skillsConfig.external_dirs === "string" ? [skillsConfig.external_dirs] : skillsConfig.external_dirs;
  const realLocal = await realpathOrNull(skillsDir);
  for (const entry of (Array.isArray(rawExternal) ? rawExternal : []).slice(0, 32)) {
    const resolved = expandUserPath(String(entry), { homeDirectory, base: hermesHome });
    const real = resolved ? await realpathOrNull(resolved) : null;
    if (!real || real === realLocal || state.externalDirs.includes(real)) continue;
    if ((await stat(real).catch(() => null))?.isDirectory()) state.externalDirs.push(real);
  }
  [state.bundledNames, state.hubNames, state.activeOrg] = await Promise.all([
    readBundledManifest(skillsDir),
    readHubNames(skillsDir),
    readActiveOrg(skillsDir),
  ]);
  const usage = await readUsage(skillsDir);
  state.usage = usage.usage;
  state.usageStatus = usage.status;
  return state;
}

export async function listHermesProfiles(hermesHome) {
  const profilesRoot = path.join(hermesHome, "profiles");
  let entries = [];
  try {
    entries = await readdir(profilesRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && /^[\w.-]{1,64}$/u.test(entry.name) && !entry.name.startsWith("."))
    .map((entry) => ({ name: entry.name, root: path.join(profilesRoot, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, 50);
}

/** Classifies one discovered Hermes skill instance. */
function annotate(instance, state, { kind, skillPath }) {
  const names = [instance.name, instance.directoryName];
  const relative = path.relative(state.skillsDir, skillPath).split(path.sep);
  if (kind === "local" && relative[0] === ORG_DIR) {
    Object.assign(instance, { source: "hermes-org", sourceLabel: "组织同步", managed: true, readOnly: true });
  } else if (kind === "local" && names.some((name) => state.hubNames.has(name))) {
    Object.assign(instance, { source: "hermes-hub", sourceLabel: "Skills Hub", managed: true, readOnly: true });
  } else if (kind === "local" && names.some((name) => state.bundledNames.has(name))) {
    Object.assign(instance, { source: "hermes-bundled", sourceLabel: "内置", managed: true });
  } else if (kind === "external") {
    Object.assign(instance, { source: "hermes-external", sourceLabel: "外部目录" });
  }
  if (state.profile) instance.profile = state.profile;
  if (names.some((name) => state.disabled.has(name))) instance.disabled = true;
  const platforms = names.flatMap((name) => state.platformDisabled.get(name) || []);
  if (platforms.length) instance.disabledOn = [...new Set(platforms)];
  const usage = names.map((name) => state.usage.get(name)).find(Boolean);
  if (usage) {
    instance.usage = {
      count: usage.count,
      lastUsedAt: usage.lastUsedAt,
      state: usage.state,
      pinned: usage.pinned,
      confidence: "recorded",
    };
  }
}

/**
 * Skill sources for scanAll: local skills (default profile), external dirs and each
 * profile's skills. First-seen wins within a profile (local before external).
 */
export async function hermesSkillSources(homeDirectory = homedir()) {
  const hermesHome = hermesHomeFor(homeDirectory);
  const state = await loadHermesHome(hermesHome, { homeDirectory });
  if (!state.available) return { available: false, sources: [], warnings: [], installRoot: null };
  const profiles = await listHermesProfiles(hermesHome);
  const profileStates = await Promise.all(
    profiles.map((profile) => loadHermesHome(profile.root, { homeDirectory, profile: profile.name })),
  );
  const sources = [];
  const add = (root, sourceState, kind, precedence) =>
    sources.push({
      path: root,
      readOnly: false,
      label: kind === "external" ? "外部目录" : sourceState.profile ? `Profile ${sourceState.profile}` : "",
      discover: () => discoverHermesSkills(root, { activeOrg: kind === "local" ? sourceState.activeOrg : null }),
      annotate: (instance, skillPath) => annotate(instance, sourceState, { kind, skillPath }),
      scope: sourceState.profile || "default",
      precedence,
      firstWins: true,
    });
  add(state.skillsDir, state, "local", 0);
  state.externalDirs.forEach((directory, index) => add(directory, state, "external", index + 1));
  for (const profileState of profileStates) {
    add(profileState.skillsDir, profileState, "local", 0);
  }
  const archived = await listHermesArchived(state);
  const version = await versionInfo(hermesHome);
  return {
    available: true,
    install: { version: version.agent || version.app, managedBy: [] },
    sources,
    installRoot: state.skillsDir,
    copyOnly: true,
    warnings: [...state.warnings, ...profileStates.flatMap((item) => item.warnings)],
    archived,
    usageAvailable: state.usageStatus === "ok",
  };
}

/** Skills the curator archived (skills/.archive): listed separately, never in status. */
export async function listHermesArchived(state) {
  const archiveRoot = path.join(state.skillsDir, ".archive");
  if (!(await exists(archiveRoot))) return [];
  const found = await discoverHermesSkills(archiveRoot, { includeExcluded: false });
  const items = [];
  for (const { skillPath } of found.slice(0, 2_000)) {
    const read = await readBoundedText(path.join(skillPath, "SKILL.md"), 65_536);
    const block = read.status === "ok" ? frontmatterBlock(read.text) : "";
    const name = text(readYamlScalar(block, "name"), 128) || text(path.basename(skillPath), 128);
    const usage = state.usage.get(name);
    items.push({
      agentId: "hermes",
      name,
      directoryName: text(path.basename(skillPath), 128),
      archived: true,
      archivedAt: usage?.archivedAt || null,
      source: "hermes-archived",
      readOnly: true,
    });
  }
  return items.sort((left, right) => left.name.localeCompare(right.name));
}

/** Hermes state.db: sessions in the last 30 days (counts and tokens only, never messages). */
export async function readHermesActivity(homeDirectory = homedir(), { now = Date.now() } = {}) {
  const hermesHome = hermesHomeFor(homeDirectory);
  const databasePath = path.join(hermesHome, "state.db");
  const result = { available: false, sessions30d: 0, tokens30d: 0, costUsd30d: 0, lastActiveAt: null, warnings: [] };
  if (!(await lstat(databasePath).catch(() => null))?.isFile()) return result;
  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch {
    result.warnings.push("当前运行环境不支持读取 Hermes 会话统计，已跳过。");
    return result;
  }
  let database;
  try {
    database = new sqlite.DatabaseSync(databasePath, { readOnly: true });
    database.exec("PRAGMA query_only = 1");
    const columns = new Set(database.prepare("PRAGMA table_info(sessions)").all().map((column) => column.name));
    if (!columns.has("started_at")) {
      result.warnings.push("Hermes 会话数据库的格式无法识别，已跳过。");
      return result;
    }
    const sum = (column) => (columns.has(column) ? `COALESCE(SUM(${column}), 0)` : "0");
    const since = (now - ACTIVITY_WINDOW_DAYS * 86_400_000) / 1000;
    const row = database
      .prepare(
        `SELECT COUNT(*) AS sessions, ${sum("input_tokens")} AS input, ${sum("output_tokens")} AS output,
                ${sum("cache_read_tokens")} AS cacheRead, ${sum("cache_write_tokens")} AS cacheWrite,
                ${sum("estimated_cost_usd")} AS cost
         FROM sessions WHERE started_at >= ?`,
      )
      .get(since);
    const latest = database.prepare("SELECT MAX(started_at) AS latest FROM sessions").get();
    Object.assign(result, {
      available: true,
      sessions30d: Number(row.sessions) || 0,
      inputTokens30d: Number(row.input) || 0,
      outputTokens30d: Number(row.output) || 0,
      cacheTokens30d: (Number(row.cacheRead) || 0) + (Number(row.cacheWrite) || 0),
      tokens30d: (Number(row.input) || 0) + (Number(row.output) || 0),
      costUsd30d: Math.round((Number(row.cost) || 0) * 100) / 100,
      lastActiveAt: latest?.latest ? new Date(Number(latest.latest) * 1000).toISOString() : null,
    });
  } catch {
    result.warnings.push("Hermes 会话数据库暂时无法读取（可能正被占用），已跳过。");
  } finally {
    try {
      database?.close();
    } catch {
      // Best effort.
    }
  }
  return result;
}

/** MCP servers from config.yaml `mcp_servers` (raw; callers must mask). */
export async function hermesMcpEntries(homeDirectory = homedir()) {
  const hermesHome = hermesHomeFor(homeDirectory);
  const config = await readYamlFile(path.join(hermesHome, "config.yaml"));
  if (config.status !== "ok") {
    return { entries: [], warnings: config.status === "missing" ? [] : ["Hermes config.yaml 无法解析，MCP 配置已跳过。"] };
  }
  const homes = [homeDirectory];
  return {
    entries: Object.entries(object(object(config.value).mcp_servers))
      .slice(0, 300)
      .filter(([name]) => /^[\p{L}\p{N}_.:@ -]{1,160}$/u.test(name))
      .map(([name, value]) => ({
        name,
        config: object(value),
        agentId: "hermes",
        scope: "user",
        projectPath: null,
        source: compactHomePath(path.join(hermesHome, "config.yaml"), homes),
        format: "yaml",
      })),
    warnings: [],
  };
}

/** ~/.hermes/plugins/<name>/plugin.yaml, enabled state from config `plugins.enabled/disabled`. */
export async function scanHermesPlugins(homeDirectory = homedir()) {
  const hermesHome = hermesHomeFor(homeDirectory);
  const pluginsRoot = path.join(hermesHome, "plugins");
  const result = { available: false, agentId: "hermes", plugins: [], marketplaces: [], warnings: [], roots: new Map() };
  let entries;
  try {
    entries = await readdir(pluginsRoot, { withFileTypes: true });
  } catch {
    return result;
  }
  result.available = true;
  const config = await readYamlFile(path.join(hermesHome, "config.yaml"));
  const pluginsConfig = config.status === "ok" ? object(object(config.value).plugins) : {};
  const enabled = nameSet(pluginsConfig.enabled);
  const disabled = nameSet(pluginsConfig.disabled);
  const realRoot = await realpathOrNull(pluginsRoot);
  for (const entry of entries.filter((item) => item.isDirectory() && /^[\w.-]{1,128}$/u.test(item.name)).slice(0, 200)) {
    const root = await realpathOrNull(path.join(pluginsRoot, entry.name));
    if (!root || !realRoot || !isWithin(realRoot, root)) continue;
    const manifest = await readYamlFile(path.join(root, "plugin.yaml"), 256_000);
    if (manifest.status === "missing") continue;
    const value = manifest.status === "ok" ? object(manifest.value) : {};
    const name = text(value.name, 80) || entry.name;
    const key = `hermes:${entry.name}`;
    result.roots.set(key, root);
    result.plugins.push({
      id: entry.name,
      key,
      agentId: "hermes",
      kind: "plugin",
      name: entry.name,
      marketplace: "local",
      displayName: name,
      shortDescription: text(value.description, 400),
      longDescription: "",
      category: "",
      developerName: text(typeof value.author === "string" ? value.author : object(value.author).name, 80),
      brandColor: null,
      capabilities: [],
      keywords: [],
      license: text(value.license, 40),
      homepage: "",
      version: text(String(value.version ?? ""), 64),
      versions: [],
      enabled: disabled.has(entry.name) ? false : enabled.has(entry.name) ? true : "unknown",
      configured: enabled.has(entry.name) || disabled.has(entry.name),
      installed: true,
      scope: "user",
      projectPath: null,
      source: "hermes-plugins",
      manifestStatus: manifest.status,
      components: {
        skills: [],
        mcpServers: [],
        apps: [],
        hooks: Boolean(value.hooks) || (await exists(path.join(root, "hooks"))),
      },
      logo: null,
      logoDark: null,
      composerIcon: null,
    });
  }
  return result;
}

const yesNo = (value) => (value === true ? "开启" : value === false ? "关闭" : "未设置");
const names = (list, limit = 30) =>
  (Array.isArray(list) ? list : [])
    .filter((item) => typeof item === "string")
    .map((item) => safeIdentifier(item) || "••••••")
    .slice(0, limit)
    .join("、") || "无";

async function directorySize(directory, limit = 2_000) {
  let total = 0;
  let count = 0;
  async function visit(current, depth) {
    if (count >= limit || depth > 4) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      count += 1;
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(child, depth + 1);
      else if (entry.isFile()) total += (await lstat(child).catch(() => null))?.size || 0;
    }
  }
  await visit(directory, 0);
  return total;
}

async function cronSummary(hermesHome) {
  const jobs = await readBoundedJson(path.join(hermesHome, "cron", "jobs.json"), 2_000_000);
  const list = jobs.status === "ok" ? object(jobs.value).jobs : null;
  return (Array.isArray(list) ? list : []).slice(0, 200).map((job) => ({
    name: text(object(job).name, 80) || "未命名任务",
    schedule: text(object(job).schedule_display || (typeof object(job).schedule === "string" ? object(job).schedule : ""), 80),
    enabled: object(job).enabled !== false,
  }));
}

async function gatewayStatus(hermesHome) {
  const pid = await exists(path.join(hermesHome, "gateway.pid"));
  const state = await readBoundedJson(path.join(hermesHome, "gateway_state.json"), 256_000);
  const status = state.status === "ok" ? safeIdentifier(object(state.value).gateway_state) : "";
  return { pidFile: pid, status: status || null };
}

async function versionInfo(hermesHome) {
  const pyproject = await readBoundedText(path.join(hermesHome, "hermes-agent", "pyproject.toml"), 256_000);
  const agent = pyproject.status === "ok" ? pyproject.text.match(/^version\s*=\s*"([0-9][\w.+-]{0,40})"/mu)?.[1] || null : null;
  const app = process.platform === "darwin" ? await readAppBundle("/Applications/Hermes.app") : null;
  return { agent, app: app?.bundleId === "com.nousresearch.hermes" ? app.version : null };
}

/** Chinese setting rows for /api/config-detail?kind=agent&id=hermes. */
const HERMES_CREDENTIAL_FILES = [".env", "auth.json"];

export async function hermesSettingsDetail(homeDirectory = homedir(), homes = [homeDirectory]) {
  const hermesHome = hermesHomeFor(homeDirectory);
  const state = await loadHermesHome(hermesHome, { homeDirectory });
  if (!state.available || state.configStatus !== "ok") return null;
  const config = state.config;
  const model = object(config.model);
  const delegation = object(config.delegation);
  const skills = object(config.skills);
  const memory = object(config.memory);
  const curator = object(config.curator);
  const approvals = object(config.approvals);
  const version = await versionInfo(hermesHome);
  const activeProfile = await readBoundedText(path.join(hermesHome, "active_profile"), 256);
  const cron = await cronSummary(hermesHome);
  const gateway = await gatewayStatus(hermesHome);
  const pluginsConfig = object(config.plugins);
  // Existence only: these files hold API keys and tokens and are never opened.
  const credentialFiles = [];
  for (const fileName of HERMES_CREDENTIAL_FILES) {
    if (await exists(path.join(hermesHome, fileName))) credentialFiles.push(fileName);
  }
  const row = (label, value) => ({ label, value: String(value ?? "无") });
  return {
    title: "Hermes Agent 配置",
    location: compactHomePath(path.join(hermesHome, "config.yaml"), homes),
    rows: [
      row("版本", [version.agent && `Agent ${version.agent}`, version.app && `桌面 ${version.app}`].filter(Boolean).join("，") || "未知"),
      row("当前 profile", activeProfile.status === "ok" ? safeIdentifier(activeProfile.text.trim()) || "default" : "default"),
      row(
        "模型",
        [safeIdentifier(model.provider), safeIdentifier(model.default)].filter(Boolean).join(" / ") +
          (hostnameOf(model.base_url) ? `（${hostnameOf(model.base_url)}）` : "") || "未设置",
      ),
      row("工具集", names(config.toolsets)),
      row("记忆", `${yesNo(memory.memory_enabled)}；provider ${safeIdentifier(memory.provider) || "内置"}`),
      row(
        "委派",
        `${yesNo(delegation.orchestrator_enabled)}；模型 ${[safeIdentifier(delegation.provider), safeIdentifier(delegation.model)].filter(Boolean).join(" / ") || "沿用主模型"}；并发 ${Number(delegation.max_concurrent_children) || "默认"}`,
      ),
      row("技能外部目录", state.externalDirs.map((directory) => compactHomePath(directory, homes)).join("、") || "无"),
      row("已停用技能数", state.disabled.size + (state.platformDisabled.size ? `（另有 ${state.platformDisabled.size} 个按平台停用）` : "")),
      row("写入审批", `技能 ${yesNo(skills.write_approval)}，记忆 ${yesNo(memory.write_approval)}`),
      row(
        "Curator 策略",
        `${yesNo(curator.enabled)}；${Number(curator.stale_after_days) || "默认"} 天未用标记为过期，${Number(curator.archive_after_days) || "默认"} 天后归档；清理内置技能 ${yesNo(curator.prune_builtins)}`,
      ),
      row("插件", `启用 ${names(pluginsConfig.enabled)}${nameSet(pluginsConfig.disabled).size ? `；停用 ${names(pluginsConfig.disabled)}` : ""}`),
      row("MCP 数", Object.keys(object(config.mcp_servers)).length),
      row("平台/网关", `${Object.keys(object(config.platforms)).map((name) => safeIdentifier(name) || "••••••").join("、") || "无"}；网关 ${gateway.status || (gateway.pidFile ? "有 pid 文件" : "未运行")}`),
      row("定时任务数", `${cron.length}（启用 ${cron.filter((job) => job.enabled).length}）`),
      row("审批模式", safeIdentifier(approvals.mode) || "默认"),
      row("凭据文件", credentialFiles.length ? `${credentialFiles.join("、")}（只检测存在，不读取内容）` : "无"),
    ],
  };
}

// ---------------------------------------------------------------------------
// Profiles for /api/capabilities

function summaryConfig(config, profileRoot, homes) {
  const pick = (source, keys) =>
    Object.fromEntries(keys.filter((key) => object(source)[key] !== undefined).map((key) => [key, object(source)[key]]));
  const model = object(config.model);
  const summary = {
    note: "仅展示非敏感配置；API Key、Token、认证与会话数据已省略。",
    profilePath: compactHomePath(profileRoot, homes),
    model: { ...pick(model, ["provider", "default"]), ...(hostnameOf(model.base_url) ? { host: hostnameOf(model.base_url) } : {}) },
    agent: pick(config.agent, ["max_turns", "reasoning_effort", "tool_use_enforcement", "disabled_toolsets"]),
    delegation: pick(config.delegation, [
      "model", "provider", "reasoning_effort", "max_iterations", "child_timeout_seconds",
      "max_concurrent_children", "max_spawn_depth", "orchestrator_enabled", "subagent_auto_approve",
      "inherit_mcp_toolsets",
    ]),
    display: pick(config.display, ["personality", "language", "interface"]),
    terminal: pick(config.terminal, ["backend", "timeout"]),
    skills: pick(config.skills, ["external_dirs", "guard_agent_created", "write_approval"]),
    memory: pick(config.memory, ["memory_enabled", "user_profile_enabled", "provider", "write_approval"]),
    plugins: pick(config.plugins, ["enabled", "disabled"]),
  };
  return Object.fromEntries(Object.entries(summary).filter(([, value]) => typeof value !== "object" || Object.keys(value).length));
}

async function createProfileCapability({ profileRoot, profileName, isDefault, homeDirectory, homes }) {
  const readOptional = async (filePath, limit = 2_000_000) => {
    if (isSensitiveFileName(path.basename(filePath))) return "";
    const result = await readBoundedText(filePath, limit);
    return result.status === "ok" ? result.text : "";
  };
  const config = await readYamlFile(path.join(profileRoot, "config.yaml"));
  const configValue = config.status === "ok" ? object(config.value) : {};
  const soulSource = await readOptional(path.join(profileRoot, "SOUL.md"));
  const metadataSource = await readOptional(path.join(profileRoot, "profile.yaml"));
  const metadataBlock = frontmatterBlock(metadataSource) || metadataSource;
  const safeConfig = maskConfig(summaryConfig(configValue, profileRoot, homes), { homes });
  const modelConfig = object(safeConfig.model);
  const agentConfig = object(safeConfig.agent);
  const delegationConfig = object(safeConfig.delegation);
  const state = await loadHermesHome(profileRoot, { homeDirectory });
  const skills = await discoverHermesSkills(state.skillsDir, { activeOrg: state.activeOrg });
  const cron = await cronSummary(profileRoot);
  const gateway = await gatewayStatus(profileRoot);
  const virtualPath = "配置摘要.json";
  const allowedFiles = new Set();
  for (const fileName of ["SOUL.md", "profile.yaml", "AGENTS.md"]) {
    if (await exists(path.join(profileRoot, fileName))) allowedFiles.add(fileName);
  }
  const referenceStats = await stat(config.status === "ok" ? path.join(profileRoot, "config.yaml") : profileRoot);
  const plugins = nameSet(object(configValue.plugins).enabled);
  return {
    id: capabilityId("hermes", profileRoot),
    productId: "hermes",
    productName: "Hermes Agent",
    productShortName: "HM",
    productColor: "#e4b86a",
    kind: "agent-profile",
    origin: "profile",
    originLabel: "Agent Profile",
    kindLabel: isDefault ? "默认 Agent" : "Agent Profile",
    name: profileName,
    displayName:
      text(readYamlScalar(metadataBlock, "displayName") || readYamlScalar(metadataBlock, "name"), 80) ||
      (isDefault ? "Hermes 默认 Agent" : profileName),
    description:
      text(readYamlScalar(metadataBlock, "description") || soulSource.replace(/[#*`>_~|]/gu, " ").replace(/\s+/gu, " "), 400) ||
      "使用 Hermes Profile、SOUL.md 与委派设置定义的本地 Agent。",
    profession: "",
    version: "",
    tags: ["SOUL.md", delegationConfig.orchestrator_enabled ? "可委派" : ""].filter(Boolean),
    members: [],
    memberCount: 0,
    fileCount: allowedFiles.size + 1,
    connectorCount: Object.keys(object(configValue.mcp_servers)).length,
    skillCount: skills.length,
    model: [modelConfig.provider, modelConfig.default].filter(Boolean).join(" / "),
    modelHost: modelConfig.host || null,
    maxTurns: agentConfig.max_turns || null,
    delegation: {
      enabled: Boolean(delegationConfig.orchestrator_enabled),
      maxConcurrentChildren: Number(delegationConfig.max_concurrent_children) || null,
      maxSpawnDepth: Number(delegationConfig.max_spawn_depth) || null,
    },
    cronJobs: cron.length,
    cronJobsEnabled: cron.filter((job) => job.enabled).length,
    memoriesBytes: await directorySize(path.join(profileRoot, "memories")),
    gateway,
    plugins: [...plugins].map((name) => safeIdentifier(name) || "••••••"),
    sourcePath: compactHomePath(profileRoot, homes),
    primaryFilePath: allowedFiles.has("SOUL.md") ? "SOUL.md" : virtualPath,
    modifiedAt: referenceStats.mtime.toISOString(),
    rootPath: profileRoot,
    allowedFiles,
    virtualFiles: new Map([[virtualPath, `${JSON.stringify(safeConfig, null, 2)}\n`]]),
  };
}

export async function scanHermesProfiles(homeDirectory = homedir()) {
  const hermesHome = hermesHomeFor(homeDirectory);
  const homes = [...new Set([homeDirectory, await realpath(homeDirectory).catch(() => homeDirectory), homedir()])];
  const empty = {
    id: "hermes",
    name: "Hermes Agent",
    shortName: "HM",
    color: "#e4b86a",
    kindLabel: "Agent Profile",
    sourcePath: compactHomePath(hermesHome, homes),
    available: false,
    catalogCount: 0,
    itemCount: 0,
    memberCount: 0,
    items: [],
  };
  if (!(await exists(hermesHome))) return empty;
  const items = [
    await createProfileCapability({ profileRoot: hermesHome, profileName: "default", isDefault: true, homeDirectory, homes }),
  ];
  for (const profile of await listHermesProfiles(hermesHome)) {
    items.push(
      await createProfileCapability({ profileRoot: profile.root, profileName: profile.name, isDefault: false, homeDirectory, homes }),
    );
  }
  return { ...empty, available: true, catalogCount: items.length, itemCount: items.length, items };
}
