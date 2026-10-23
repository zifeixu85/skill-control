import { lstat, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { applicationDirectoriesFor, expandUserPath, readAppBundle, readYamlFile } from "./config-files.mjs";
import { isTokenLike, MASK } from "./config-mask.mjs";
import {
  compactHomeInText,
  compactHomePath,
  exists,
  hostnameOf,
  isWithin,
  multilineText,
  object,
  readBoundedJson,
  realpathOrNull,
  scrubTokens,
  text,
} from "./fs-safe.mjs";
import { capabilityId } from "./workbuddy-experts.mjs";

/**
 * 办公小浣熊 (SenseTime Office Raccoon), an Electron app with a local agent ("box-agent").
 * App data: ~/Library/Application Support/office-raccoon (settings.json holds
 * systemSetting.localAgentWorkspaceDir and memoryEntries); agent workspace: ~/.box-agent
 * (skills/, config/{config.yaml,mcp.json,expert-profiles.json,skill-settings.json,
 * workspaces.json}, memory/). config/auth.json is never read.
 *
 * Skills, verified against the app (v1.0.17): it lists ~/.box-agent/skills with
 * readdir(withFileTypes) and keeps only `entry.isDirectory()` entries that contain a
 * SKILL.md, so symlinked skill folders and plain .md files are not loaded; names in
 * config/skill-settings.json `disabledSkillNames` are switched off. Library tier: copy only
 * (no links). Bundled skills live inside the app (read-only).
 */

export const RACCOON = { id: "office-raccoon", name: "办公小浣熊", shortName: "浣", color: "#f2b56b" };
export const RACCOON_APP = { names: ["办公小浣熊.app"], bundleIds: ["com.sensetime.desktop.raccoon"] };
const SETTINGS_LIMIT = 4_000_000;
const PROFILES_LIMIT = 4_000_000;
const SKILL_LIMIT = 500;
const EXPERT_LIMIT = 200;
const MEMORY_ENTRY_LIMIT = 200;
const SKILL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;

export const raccoonAppDataDir = (homeDirectory = homedir()) => path.join(homeDirectory, "Library", "Application Support", "office-raccoon");

/** The installed app bundle (verified bundle id), or null. */
export async function findRaccoonApp(homeDirectory = homedir(), directories = applicationDirectoriesFor(homeDirectory)) {
  for (const directory of directories) {
    for (const name of RACCOON_APP.names) {
      const appPath = path.join(directory, name);
      const bundle = await readAppBundle(appPath).catch(() => null);
      if (bundle && RACCOON_APP.bundleIds.includes(bundle.bundleId)) return { appPath, ...bundle };
    }
  }
  return null;
}

/**
 * App data, workspace and version. The workspace comes from settings.json
 * (systemSetting.localAgentWorkspaceDir) and is only honoured inside the home directory.
 */
export async function resolveRaccoonInstall(homeDirectory = homedir(), { applicationDirectories: directories } = {}) {
  const appDataDir = raccoonAppDataDir(homeDirectory);
  const settingsRead = await readBoundedJson(path.join(appDataDir, "settings.json"), SETTINGS_LIMIT);
  const settings = settingsRead.status === "ok" ? object(settingsRead.value) : {};
  const system = object(settings.systemSetting);
  const configured = typeof system.localAgentWorkspaceDir === "string" ? expandUserPath(system.localAgentWorkspaceDir, { homeDirectory }) : null;
  const fallback = path.join(homeDirectory, ".box-agent");
  const workspaceDir = configured && isWithin(homeDirectory, configured) ? configured : fallback;
  const app = await findRaccoonApp(homeDirectory, directories);
  const hasData = await exists(appDataDir);
  const hasWorkspace = await exists(workspaceDir);
  const warnings = [];
  if (configured && workspaceDir !== configured) warnings.push("办公小浣熊配置的工作目录不在主目录内，已改用默认位置 ~/.box-agent。");
  return {
    available: Boolean(app || hasData || hasWorkspace),
    app,
    version: app?.version || null,
    appDataDir,
    settingsPath: path.join(appDataDir, "settings.json"),
    settingsStatus: settingsRead.status,
    settings,
    system,
    workspaceDir,
    skillsDir: path.join(workspaceDir, "skills"),
    configDir: path.join(workspaceDir, "config"),
    builtinSkillsDir: app ? path.join(app.appPath, "Contents", "Resources", "box-agent-runtime", "bin", "_internal", "box_agent", "skills") : null,
    warnings,
  };
}

/** `disabledSkillNames` from config/skill-settings.json (names only). */
export async function raccoonDisabledSkills(install) {
  const read = await readBoundedJson(path.join(install.configDir, "skill-settings.json"), SETTINGS_LIMIT);
  const list = object(read.value).disabledSkillNames;
  return new Set(Array.isArray(list) ? list.filter((name) => typeof name === "string" && SKILL_NAME.test(name)) : []);
}

/** One level of skill folders, as the app reads them: real folders with a SKILL.md; links are reported, not followed. */
async function discoverRaccoonSkills(root) {
  const entries = (await readdir(root, { withFileTypes: true }).catch(() => []))
    .filter((entry) => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, SKILL_LIMIT);
  const found = [];
  for (const entry of entries) {
    const skillPath = path.join(root, entry.name);
    const realPath = await realpathOrNull(skillPath);
    if (!realPath || !(await stat(realPath).catch(() => null))?.isDirectory()) continue;
    if (!(await exists(path.join(skillPath, "SKILL.md")))) continue;
    found.push({ skillPath, realPath, linked: entry.isSymbolicLink() });
  }
  return found;
}

/** Skill adapter: user skills (writable, copy only) and the app's bundled skills (read-only). */
export async function raccoonSkillSources(homeDirectory = homedir()) {
  const install = await resolveRaccoonInstall(homeDirectory);
  if (!install.available) return { available: false, sources: [], warnings: [], installRoot: null };
  const disabled = await raccoonDisabledSkills(install);
  const linked = { count: 0 };
  const source = (directory, details) => ({
    path: directory,
    readOnly: Boolean(details.readOnly),
    label: details.label,
    precedence: details.precedence,
    scope: "global",
    firstWins: false,
    discover: () => discoverRaccoonSkills(directory),
    annotate: async (instance, skillPath, found) => {
      Object.assign(instance, { source: details.source, sourceLabel: details.label });
      if (details.readOnly) Object.assign(instance, { readOnly: true, managed: true });
      if (found?.linked) {
        instance.hiddenByProduct = "symlink-not-followed";
        linked.count += 1;
      }
      if (disabled.has(instance.name) || disabled.has(path.basename(skillPath))) instance.disabled = true;
    },
  });
  const sources = [source(install.skillsDir, { source: "office-raccoon-user", label: "", precedence: 2 })];
  if (install.builtinSkillsDir) sources.push(source(install.builtinSkillsDir, { source: "office-raccoon-bundled", label: "内置", readOnly: true, precedence: 1 }));
  return {
    available: true,
    sources,
    installRoot: install.skillsDir,
    copyOnly: true,
    refuseInstall: null,
    warnings: install.warnings,
    linkWarnings: linked,
    install: { version: install.version, managedBy: [] },
  };
}

// ---------------------------------------------------------------------------
// Experts and teams (config/expert-profiles.json; *.bak-* backups are ignored)

const isoOrNull = (value) => (typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null);
const list = (value, limit = 100) => (Array.isArray(value) ? value.filter((item) => typeof item === "string").slice(0, limit) : []);
const skillNames = (...lists) => [...new Set(lists.flat().filter((name) => SKILL_NAME.test(name)))].slice(0, 100);
const clean = (value, homes, limit) => text(scrubTokens(compactHomeInText(String(value ?? ""), homes)), limit);

function profileMarkdown(profile, { isTeam, homes }) {
  const lines = [`# ${clean(profile.name || profile.id, homes, 120)}`, ""];
  const add = (label, value) => {
    if (value) lines.push(`**${label}**：${value}`, "");
  };
  const bullets = (label, values) => {
    const items = list(values, 50);
    if (items.length) lines.push(`## ${label}`, "", ...items.map((item) => `- ${clean(item, homes, 600)}`), "");
  };
  add("角色", clean(profile.role || profile.teamPersona, homes, 400));
  add("说明", clean(profile.description, homes, 2_000));
  add("开场提示", clean(profile.starterPrompt, homes, 2_000));
  bullets("指令", profile.instructions);
  bullets("可见规则", profile.visibleRules);
  if (isTeam) {
    const members = [object(profile.leader), ...(Array.isArray(profile.members) ? profile.members : []).map(object)].filter((member) => member.name);
    if (members.length) {
      lines.push("## 成员", "");
      for (const member of members.slice(0, 50)) {
        const skills = skillNames(list(member.defaultSkills));
        lines.push(`- ${clean(member.name, homes, 80)}（${clean(member.role, homes, 120)}）${skills.length ? `：${skills.join("、")}` : ""}`);
      }
      lines.push("");
    }
    bullets("工作流", profile.workflow);
    bullets("质量关卡", profile.qualityGates);
  }
  add("输出格式", clean(profile.outputFormat, homes, 2_000));
  return multilineText(scrubTokens(lines.join("\n")), 60_000);
}

function expertItem(profile, { isTeam, install, homes, available, profilesPath }) {
  const id = text(profile.id, 128) || "unknown";
  const members = isTeam
    ? [object(profile.leader), ...(Array.isArray(profile.members) ? profile.members : []).map(object)]
        .filter((member) => member.name)
        .slice(0, 50)
        .map((member, index) => ({
          id: `${id}:${index}`,
          name: text(member.id || member.name, 80),
          displayName: clean(member.name, homes, 80),
          profession: clean(member.role, homes, 80),
          description: clean(member.role, homes, 400),
          skills: skillNames(list(member.defaultSkills)),
          leader: index === 0 && Boolean(object(profile.leader).name),
          filePath: null,
          avatar: null,
        }))
    : [];
  const required = skillNames(list(profile.requiredSkills));
  const defaults = skillNames(list(profile.defaultSkills), members.flatMap((member) => member.skills));
  const optional = skillNames(list(profile.optionalSkills));
  const skills = skillNames(required, defaults, optional);
  const missingSkills = skills.filter((name) => !available.has(name));
  const markdown = profileMarkdown(profile, { isTeam, homes });
  return {
    id: capabilityId(RACCOON.id, `${profilesPath}:${isTeam ? "team" : "expert"}:${id}`),
    productId: RACCOON.id,
    productName: RACCOON.name,
    productShortName: RACCOON.shortName,
    productColor: RACCOON.color,
    kind: isTeam ? "expert-team" : "expert",
    kindLabel: isTeam ? "专家团" : "专家",
    origin: profile.source === "user" ? "mine" : "builtin",
    originLabel: profile.source === "user" ? "我的专家" : "内置",
    name: id,
    displayName: clean(profile.name || id, homes, 80),
    description: clean(profile.description || profile.teamPersona, homes, 2_000) || "暂无专家说明",
    profession: clean(profile.role, homes, 80),
    version: text(profile.revision, 64),
    category: "",
    tags: [isTeam && profile.executionMode ? text(profile.executionMode, 40) : ""].filter(Boolean),
    defaultPrompt: clean(profile.starterPrompt, homes, 2_000) || null,
    quickPrompts: [],
    skills,
    skillDependencies: { required, default: defaults.filter((name) => !required.includes(name)), optional, missing: missingSkills },
    members,
    memberCount: members.length,
    fileCount: 1,
    connectorCount: 0,
    skillCount: skills.length,
    avatar: null,
    packaged: false,
    installed: true,
    inUse: true,
    installedVersion: text(profile.revision, 64) || null,
    used: null,
    model: "",
    sourcePath: compactHomePath(profilesPath, homes),
    createdAt: isoOrNull(profile.createdAt),
    updatedAt: isoOrNull(profile.updatedAt),
    primaryFilePath: "profile.md",
    modifiedAt: typeof profile.updatedAt === "string" && !Number.isNaN(Date.parse(profile.updatedAt)) ? new Date(profile.updatedAt).toISOString() : new Date().toISOString(),
    rootPath: install.configDir,
    allowedFiles: new Set(),
    virtualFiles: new Map([["profile.md", markdown]]),
  };
}

/** Experts view product: experts and teams with their skill dependencies. */
export async function scanRaccoonExperts(homeDirectory = homedir(), { install: given = null } = {}) {
  const install = given || (await resolveRaccoonInstall(homeDirectory));
  const homes = [homeDirectory, homedir()];
  const profilesPath = path.join(install.configDir, "expert-profiles.json");
  const product = {
    id: RACCOON.id,
    name: RACCOON.name,
    shortName: RACCOON.shortName,
    color: RACCOON.color,
    kindLabel: "专家 / 专家团",
    sourcePath: compactHomePath(profilesPath, homes),
    available: false,
    catalogCount: 0,
    itemCount: 0,
    memberCount: 0,
    items: [],
    warnings: [],
    assets: new Map(),
  };
  if (!install.available) return product;
  const read = await readBoundedJson(profilesPath, PROFILES_LIMIT);
  if (read.status !== "ok") {
    if (read.status !== "missing") product.warnings.push("办公小浣熊的专家配置无法读取，已跳过。");
    return product;
  }
  const value = object(read.value);
  const userSkills = (await discoverRaccoonSkills(install.skillsDir)).filter((item) => !item.linked).map((item) => path.basename(item.skillPath));
  const bundled = install.builtinSkillsDir ? (await discoverRaccoonSkills(install.builtinSkillsDir)).map((item) => path.basename(item.skillPath)) : [];
  const available = new Set([...userSkills, ...bundled]);
  const experts = (Array.isArray(value.experts) ? value.experts : []).slice(0, EXPERT_LIMIT).map(object);
  const teams = (Array.isArray(value.teams) ? value.teams : []).slice(0, EXPERT_LIMIT).map(object);
  for (const profile of experts) product.items.push(expertItem(profile, { isTeam: false, install, homes, available, profilesPath }));
  for (const profile of teams) product.items.push(expertItem(profile, { isTeam: true, install, homes, available, profilesPath }));
  const backups = (await readdir(install.configDir).catch(() => [])).filter((name) => name.startsWith("expert-profiles.json.bak-")).length;
  if (backups) product.backupCount = backups;
  product.available = product.items.length > 0;
  product.catalogCount = product.items.length;
  product.itemCount = product.items.length;
  product.memberCount = product.items.reduce((sum, item) => sum + item.memberCount, 0);
  return product;
}

// ---------------------------------------------------------------------------
// Settings rows (safe scalars only; config.yaml api_key and auth.json are never shown)

const safeName = (value) => {
  if (typeof value !== "string" || !value.trim()) return "未设置";
  const trimmed = value.trim();
  return /^[\p{L}\p{N}][\p{L}\p{N}._:/ -]{0,63}$/u.test(trimmed) && !trimmed.split(/[-._:/ ]+/u).some(isTokenLike) ? trimmed : MASK;
};
const yesNo = (value) => (value === true ? "是" : value === false ? "否" : "未设置");

export async function raccoonSettingsDetail(homeDirectory = homedir(), homes = [homeDirectory]) {
  const install = await resolveRaccoonInstall(homeDirectory);
  if (!install.available) return null;
  const config = await readYamlFile(path.join(install.configDir, "config.yaml"));
  const value = config.status === "ok" ? object(config.value) : {};
  const mcp = await readBoundedJson(path.join(install.configDir, "mcp.json"), SETTINGS_LIMIT);
  const workspaces = await readBoundedJson(path.join(install.configDir, "workspaces.json"), SETTINGS_LIMIT);
  const disabled = await raccoonDisabledSkills(install);
  const system = install.system;
  const imageGeneration = object(value.image_generation);
  const rows = [
    ["应用版本", install.version || "未找到应用"],
    ["工作目录", compactHomePath(install.workspaceDir, homes)],
    ["模型", safeName(value.model)],
    ["服务提供方", safeName(value.provider)],
    ["接口地址", value.api_base ? hostnameOf(String(value.api_base)) || MASK : "未设置"],
    ["API 密钥", value.api_key ? "已配置（不显示）" : "未配置"],
    ["最大输出 tokens", Number.isFinite(Number(value.max_output_tokens)) ? Number(value.max_output_tokens) : "未设置"],
    ["记忆", yesNo(system.enableMemory ?? value.enable_memory)],
    ["记忆回溯天数", Number.isFinite(Number(system.memoryRecallDays ?? value.memory_recall_days)) ? Number(system.memoryRecallDays ?? value.memory_recall_days) : "未设置"],
    ["允许导入 OpenClaw 记忆", yesNo(system.allowOpenClawMemoryImport)],
    ["文件访问范围", safeName(system.fileAccessScope)],
    ["额外允许的目录", Array.isArray(system.customAllowedDirectories) ? `${system.customAllowedDirectories.length} 个` : "无"],
    ["图片生成", Object.keys(imageGeneration).length ? `已配置${imageGeneration.model ? `（${safeName(imageGeneration.model)}）` : ""}` : "未配置"],
    ["MCP 服务", mcp.status === "ok" ? Object.keys(object(object(mcp.value).mcpServers)).filter((name) => /^[\w.@:-]{1,80}$/u.test(name)).join("、") || "无" : "未配置"],
    ["停用的技能", disabled.size ? [...disabled].join("、") : "无"],
    ["工作区", Array.isArray(object(workspaces.value).workspaces) ? `${workspaces.value.workspaces.length} 个` : "无"],
    ["设置里的记忆条目", Array.isArray(install.settings.memoryEntries) ? `${install.settings.memoryEntries.length} 条` : "无"],
  ];
  return {
    title: "办公小浣熊配置",
    location: compactHomePath(path.join(install.configDir, "config.yaml"), homes),
    rows: rows.map(([label, rowValue]) => ({ label, value: multilineText(scrubTokens(compactHomeInText(String(rowValue), homes)), 4_000) })),
  };
}

/** memoryEntries from settings.json, newest first, as short redacted Markdown documents. */
export function raccoonMemoryEntries(install, homes) {
  const entries = Array.isArray(install.settings.memoryEntries) ? install.settings.memoryEntries.slice(0, MEMORY_ENTRY_LIMIT).map(object) : [];
  return entries
    .filter((entry) => typeof entry.content === "string" && entry.content.trim())
    .map((entry, index) => ({
      entry,
      key: typeof entry.id === "string" && /^[\w-]{1,80}$/u.test(entry.id) ? entry.id : `entry-${index}`,
      updatedAt: typeof entry.updatedAt === "string" && !Number.isNaN(Date.parse(entry.updatedAt)) ? new Date(entry.updatedAt).toISOString() : null,
    }))
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    .map(({ entry, key, updatedAt }, index) => ({
      key,
      updatedAt,
      markdown: [
        `# 记忆条目 ${index + 1}`,
        "",
        `来源：${text(entry.source, 40) || "未知"}${entry.createdAt ? ` · 创建 ${text(entry.createdAt, 40)}` : ""}${entry.updatedAt ? ` · 更新 ${text(entry.updatedAt, 40)}` : ""}`,
        "",
        multilineText(compactHomeInText(entry.content, homes), 20_000),
        "",
      ].join("\n"),
    }));
}

/** Whether a path is a plain file (for listings). */
export async function isPlainFile(filePath) {
  return Boolean((await lstat(filePath).catch(() => null))?.isFile());
}
