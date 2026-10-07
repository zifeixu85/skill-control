import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { dumpYaml, expandUserPath, parseYamlSafe } from "./config-files.mjs";
import { maskConfig } from "./config-mask.mjs";
import {
  compactHomeInText,
  compactHomePath,
  isSensitiveFileName,
  isWithin,
  MASK,
  object,
  readBoundedText,
  readTextPrefix,
  resolveInside,
  scrubTokens,
} from "./fs-safe.mjs";
import { hermesCronJobs, hermesHomeFor, listHermesProfiles } from "./hermes.mjs";
import { raccoonMemoryEntries, resolveRaccoonInstall } from "./office-raccoon.mjs";
import { openClawAgents, resolveOpenClawInstall } from "./openclaw.mjs";

/**
 * Per-agent persona, memory, identity, rule and instruction files (read-only). Listing
 * returns opaque ids; reading re-validates the file: real path inside its root, regular
 * file, bounded and FIFO-safe, never a credential file. Content is redacted free text, or
 * default-deny masked YAML / JSON.
 */

export const AGENT_FILE_LIMIT = 512 * 1024;
const LIST_LIMIT = 200;
const NEWEST_LIMIT = 50;
const REGISTRY_LIMIT = 5_000;

const LANGUAGES = new Map([
  [".md", "md"],
  [".mdc", "md"],
  [".markdown", "md"],
  [".yaml", "yaml"],
  [".yml", "yaml"],
  [".json", "json"],
]);

/** Workspace files OpenClaw loads, and what each one is for. */
const OPENCLAW_WORKSPACE_FILES = [
  ["AGENTS.md", "instructions"],
  ["SOUL.md", "persona"],
  ["IDENTITY.md", "identity"],
  ["USER.md", "user"],
  ["TOOLS.md", "tools"],
  ["HEARTBEAT.md", "heartbeat"],
  ["BOOTSTRAP.md", "bootstrap"],
  ["BOOT.md", "bootstrap"],
  ["MEMORY.md", "memory"],
];

const registry = new Map();

const fileId = (agentId, absolutePath) =>
  createHash("sha256").update(`agent-file\0${agentId}\0${absolutePath}`).digest("hex").slice(0, 24);

const languageOf = (name) => LANGUAGES.get(path.extname(name).toLowerCase()) || "text";

const kindForName = (name) => {
  const upper = name.toUpperCase();
  if (upper === "SOUL.MD") return "persona";
  if (upper === "IDENTITY.MD") return "identity";
  if (upper === "USER.MD") return "user";
  if (upper === "LESSONS.MD") return "lessons";
  if (upper === "TOOLS.MD") return "tools";
  if (/^(?:MEMORY|MEMORY_SUMMARY|RAW_MEMORIES)\.MD$/u.test(upper)) return "memory";
  if (/^(?:AGENTS|CLAUDE|GEMINI)(?:\.OVERRIDE)?\.MD$/u.test(upper)) return "instructions";
  return "other";
};

/**
 * One file inside `root`, or null when it is missing, sensitive or escapes the root. A
 * `virtual` entry ({ key, name }) lists one part of a file (e.g. one memory entry inside a
 * settings file) under its own id; its `render` returns Markdown text.
 */
async function fileEntry(root, relativePath, { agentId, kind, homes, render = null, note = null, virtual = null }) {
  // A virtual entry only ever shows what its renderer picks out, never the file itself.
  if (!(virtual && render) && isSensitiveFileName(relativePath)) return null;
  const realFile = await resolveInside(root, relativePath);
  if (!realFile) return null;
  let info;
  try {
    info = await lstat(realFile);
  } catch {
    return null;
  }
  if (!info.isFile()) return null;
  const absolutePath = path.join(root, relativePath);
  const name = virtual?.name || path.basename(relativePath);
  const id = fileId(agentId, virtual ? `${absolutePath}#${virtual.key}` : absolutePath);
  if (registry.size >= REGISTRY_LIMIT) registry.clear();
  registry.set(id, { agentId, root, relativePath, name, render, virtual: Boolean(virtual && render), language: virtual ? "md" : render ? "json" : languageOf(name) });
  return {
    id,
    name,
    kind: kind || kindForName(name),
    size: virtual?.size ?? info.size,
    modifiedAt: virtual?.modifiedAt || new Date(info.mtimeMs).toISOString(),
    displayPath: compactHomePath(absolutePath, homes),
    ...(note ? { note } : {}),
  };
}

/** Files directly inside (or up to `depth` below) a directory, newest first. */
async function listFiles(root, directory, { pattern, depth = 0, limit = LIST_LIMIT }) {
  const found = [];
  async function walk(relativeDirectory, level) {
    if (found.length >= limit * 4) return;
    let entries;
    try {
      entries = await readdir(path.join(root, relativeDirectory), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.slice(0, 2_000)) {
      if (entry.name.startsWith(".")) continue;
      const relative = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory() && level < depth) await walk(relative, level + 1);
      else if ((entry.isFile() || entry.isSymbolicLink()) && pattern.test(entry.name)) {
        try {
          found.push({ relative, mtimeMs: (await lstat(path.join(root, relative))).mtimeMs });
        } catch {
          // Removed while listing.
        }
      }
    }
  }
  await walk(directory, 0);
  return found.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, limit).map((item) => item.relative);
}

async function group(id, label, root, relativePaths, options) {
  const files = [];
  for (const relativePath of relativePaths) {
    const entry = await fileEntry(root, relativePath, options);
    if (entry) files.push(entry);
  }
  return files.length ? { id, label, ...(options.note ? { note: options.note } : {}), files } : null;
}

/**
 * Declarative groups: known persona and memory file names (`files`) plus bounded scans of
 * known subfolders (`scan: { dir, pattern, depth, limit }`), all relative to `root`.
 */
async function specGroups(root, specs, options) {
  const groups = [];
  for (const spec of specs) {
    const relativePaths = [
      ...(spec.files || []),
      ...(spec.scan ? await listFiles(root, spec.scan.dir, { pattern: spec.scan.pattern, depth: spec.scan.depth || 0, limit: spec.scan.limit || NEWEST_LIMIT }) : []),
    ];
    groups.push(await group(spec.id, spec.label, root, relativePaths, { ...options, ...(spec.kind ? { kind: spec.kind } : {}), ...(spec.note ? { note: spec.note } : {}) }));
  }
  return groups;
}

async function codexGroups(homeDirectory, homes) {
  const root = path.join(homeDirectory, ".codex");
  const options = { agentId: "codex", homes };
  return [
    await group("instructions", "全局指令", root, ["AGENTS.md", "AGENTS.override.md"], options),
    await group("rules", "命令规则", root, await listFiles(root, "rules", { pattern: /\.rules$/u }), { ...options, kind: "rules" }),
    await group("memories", "记忆", root, await listFiles(root, "memories", { pattern: /\.md$/u }), { ...options, kind: "memory" }),
    await group(
      "memory-summaries",
      "会话记忆摘要（最近 50 个）",
      root,
      await listFiles(root, path.join("memories", "rollout_summaries"), { pattern: /\.md$/u, limit: NEWEST_LIMIT }),
      { ...options, kind: "memory" },
    ),
  ];
}

async function claudeGroups(homeDirectory, homes) {
  const root = path.join(homeDirectory, ".claude");
  const options = { agentId: "claude", homes };
  const projectMemories = [];
  for (const project of (await listDirectoryNames(path.join(root, "projects"))).slice(0, 200)) {
    for (const relative of await listFiles(root, path.join("projects", project, "memory"), { pattern: /\.md$/u, limit: 20 })) {
      projectMemories.push(relative);
    }
  }
  return [
    await group("instructions", "全局指令", root, ["CLAUDE.md"], { ...options, kind: "instructions" }),
    await group("memories", "项目记忆", root, projectMemories.slice(0, NEWEST_LIMIT), { ...options, kind: "memory" }),
    await group("rules", "规则", root, await listFiles(root, "rules", { pattern: /\.md$/u, depth: 4 }), { ...options, kind: "rules" }),
    await group("agents", "子代理", root, await listFiles(root, "agents", { pattern: /\.md$/u }), { ...options, kind: "other" }),
    await group("commands", "命令", root, await listFiles(root, "commands", { pattern: /\.md$/u, depth: 1 }), { ...options, kind: "other" }),
  ];
}

const PERSONA_FILES = ["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md", "AGENTS.md"];

/**
 * WorkBuddy keeps a global persona in ~/.workbuddy and, in newer versions, one per account
 * in user-<id>-personal/. No setting says which one is active, so both are listed.
 */
async function workBuddyGroups(homeDirectory, homes) {
  const root = path.join(homeDirectory, ".workbuddy");
  const accounts = (await listDirectoryNames(root)).filter((name) => /^user-[\w-]{1,80}-personal$/u.test(name)).slice(0, 5);
  const options = { agentId: "workbuddy", homes };
  const accountNote = "按账号保存的人格与记忆。没有设置标明哪一份生效，较新版本的 WorkBuddy 通常用账号目录这一份。";
  return [
    ...(await specGroups(root, [{ id: "identity", label: accounts.length ? "身份与记忆（全局）" : "身份与记忆", files: PERSONA_FILES, ...(accounts.length ? { note: "早期版本的全局文件；下方还有按账号保存的一份。" } : {}) }], options)),
    ...(await specGroups(
      root,
      accounts.map((account, index) => ({
        id: index ? `account-${index}` : "account",
        label: accounts.length > 1 ? `身份与记忆（账号 ${index + 1}）` : "身份与记忆（账号）",
        files: PERSONA_FILES.slice(0, 4).map((name) => path.join(account, name)),
        note: accountNote,
      })),
      options,
    )),
    ...(await specGroups(
      root,
      [
        { id: "memory", label: "记忆", kind: "memory", scan: { dir: "memory", pattern: /\.md$/u } },
        { id: "automations", label: "自动化记忆", kind: "memory", scan: { dir: "automations", pattern: /^memory\.md$/u, depth: 1 } },
        { id: "plans", label: "计划", kind: "other", scan: { dir: "plans", pattern: /\.md$/u } },
      ],
      options,
    )),
  ];
}

/** 办公小浣熊: the agent workspace's memory folder, plus memory entries kept in the app's settings. */
async function raccoonGroups(homeDirectory, homes) {
  const install = await resolveRaccoonInstall(homeDirectory);
  if (!install.available) return [];
  const root = install.workspaceDir;
  const options = { agentId: "office-raccoon", homes };
  const groups = await specGroups(
    root,
    [
      { id: "memory", label: "记忆", kind: "memory", files: ["memory/MEMORY.md", "memory/memory_summary.md", "memory/CONTEXT.archive.md"] },
      { id: "memory-context", label: "记忆上下文", kind: "memory", scan: { dir: path.join("memory", "context"), pattern: /\.(?:md|json)$/u, depth: 1 } },
      { id: "memory-v2", label: "记忆（v2）", kind: "memory", scan: { dir: path.join("memory", "v2"), pattern: /\.(?:md|json)$/u, depth: 2 } },
    ],
    options,
  );
  const entries = raccoonMemoryEntries(install, homes);
  const files = [];
  for (const [index, entry] of entries.entries()) {
    const render = async () => {
      const current = raccoonMemoryEntries(await resolveRaccoonInstall(homeDirectory), homes).find((item) => item.key === entry.key);
      return current ? current.markdown : "这条记忆已不存在，请刷新文件列表。";
    };
    const file = await fileEntry(install.appDataDir, "settings.json", {
      ...options,
      kind: "memory",
      render,
      virtual: { key: entry.key, name: `记忆条目 ${index + 1}.md`, size: Buffer.byteLength(entry.markdown), modifiedAt: entry.updatedAt },
    });
    if (file) files.push(file);
  }
  if (files.length) groups.push({ id: "settings-memory", label: "应用设置里的记忆条目", note: "来自应用设置（settings.json 的 memoryEntries），已做脱敏。", files });
  return groups;
}

async function singleFileGroups(agentId, homeDirectory, homes) {
  if (agentId === "gemini") {
    const root = path.join(homeDirectory, ".gemini");
    return [await group("instructions", "全局指令", root, ["GEMINI.md", "AGENTS.md"], { agentId, homes, kind: "instructions" })];
  }
  if (agentId === "cursor") {
    const root = path.join(homeDirectory, ".cursor");
    return [await group("rules", "规则", root, await listFiles(root, "rules", { pattern: /\.(?:mdc|md)$/u, depth: 2 }), { agentId, homes, kind: "rules" })];
  }
  return [];
}

async function listDirectoryNames(directory) {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && /^[\w.@-]{1,128}$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Hermes cron jobs without prompts, errors or delivery targets. */
async function renderHermesCron(absolutePath) {
  const jobs = await hermesCronJobs(path.dirname(path.dirname(absolutePath)));
  return { note: "只显示任务名称、计划、状态和技能；提示词与投递目标已省略。", jobs };
}

async function hermesGroups(homeDirectory, homes, profileName) {
  const hermesHome = hermesHomeFor(homeDirectory);
  const profiles = [{ name: "default", root: hermesHome }, ...(await listHermesProfiles(hermesHome))];
  const profile = profiles.find((item) => item.name === (profileName || "default"));
  if (!profile) return { groups: [], profiles: profiles.map((item) => item.name) };
  const root = profile.root;
  const options = { agentId: "hermes", homes };
  const memories = await listFiles(root, "memories", { pattern: /\.md$/u });
  return {
    profiles: profiles.map((item) => item.name),
    profile: profile.name,
    groups: [
      await group("persona", "人格与指令", root, ["SOUL.md", "AGENTS.md", "profile.yaml"], options),
      await group("memories", "记忆", root, memories, options),
      await group("cron", "定时任务", root, [path.join("cron", "jobs.json")], { ...options, kind: "other", render: renderHermesCron }),
    ],
  };
}

const OPENCLAW_AGENT_LIMIT = 30;

/**
 * OpenClaw / QClaw: every agent's workspace (agents.defaults.workspace, agents.list[].
 * workspace; default ~/.openclaw/workspace) with its memory/YYYY-MM-DD.md files, the
 * agents/<id>/ folders (LESSONS.md …, bounded) and the global files including LumiClaw's
 * .lumiclaw/*.md. With an `agent` parameter only that agent's groups are listed.
 */
async function openClawGroups(kind, homeDirectory, homes, agentIdParam) {
  const install = await resolveOpenClawInstall(kind, homeDirectory);
  if (!install.available) return { groups: [], agents: [] };
  const configured = openClawAgents(install);
  const stateAgentDirs = await listDirectoryNames(path.join(install.stateDir, "agents"));
  const agentIds = [...new Set([...configured.map((agent) => agent.id), ...stateAgentDirs])].slice(0, OPENCLAW_AGENT_LIMIT);
  if (agentIdParam && !agentIds.includes(agentIdParam)) return { groups: [], agents: agentIds };
  const shown = agentIdParam ? [agentIdParam] : agentIds;
  const single = shown.length === 1;
  const options = { agentId: kind, homes };
  const lumiclaw = install.managedBy.includes("LumiClaw") ? "由 LumiClaw 写入" : null;
  const groups = [];
  const workspaces = new Set();
  for (const id of shown) {
    const selected = configured.find((agent) => agent.id === id);
    const suffix = single ? "" : `:${id}`;
    const prefix = single ? "" : `${id} · `;
    // A configured workspace is only read inside the home directory, and listed once.
    const workspace = selected?.workspace ? path.resolve(selected.workspace) : null;
    if (workspace && isWithin(homeDirectory, workspace) && !workspaces.has(workspace)) {
      workspaces.add(workspace);
      groups.push(
        await group(`workspace${suffix}`, `${prefix}工作区文件`, workspace, OPENCLAW_WORKSPACE_FILES.map(([name]) => name), options),
        await group(`memory${suffix}`, `${prefix}记忆（最近 50 个）`, workspace, await listFiles(workspace, "memory", { pattern: /\.md$/u, limit: NEWEST_LIMIT }), {
          ...options,
          kind: "memory",
        }),
      );
    }
    if (stateAgentDirs.includes(id)) {
      groups.push(
        await group(`agent-state${suffix}`, `${prefix}Agent 目录文件`, install.stateDir, await listFiles(install.stateDir, path.join("agents", id), { pattern: /\.md$/u, depth: 1, limit: NEWEST_LIMIT }), {
          ...options,
          note: lumiclaw,
        }),
      );
    }
  }
  // The defaults workspace (agents.defaults.workspace, else <state>/workspace) even when no listed agent uses it.
  const configuredDefault = object(object(install.config.agents).defaults).workspace;
  const defaultWorkspace = (typeof configuredDefault === "string" && expandUserPath(configuredDefault, { homeDirectory })) || path.join(install.stateDir, "workspace");
  if (!agentIdParam && isWithin(homeDirectory, defaultWorkspace) && !workspaces.has(defaultWorkspace)) {
    groups.push(
      await group("workspace:default", "默认工作区 · 工作区文件", defaultWorkspace, OPENCLAW_WORKSPACE_FILES.map(([name]) => name), options),
      await group("memory:default", "默认工作区 · 记忆（最近 50 个）", defaultWorkspace, await listFiles(defaultWorkspace, "memory", { pattern: /\.md$/u, limit: NEWEST_LIMIT }), { ...options, kind: "memory" }),
    );
  }
  groups.push(
    await group("state", "全局文件", install.stateDir, ["AGENTS.md", "LUMICLAW.md"], { ...options, note: lumiclaw }),
    await group("lumiclaw", "LumiClaw 任务", install.stateDir, await listFiles(install.stateDir, ".lumiclaw", { pattern: /\.md$/u, limit: NEWEST_LIMIT }), { ...options, note: lumiclaw }),
  );
  return { groups, agents: agentIds, ...(agentIdParam ? { agentId: agentIdParam } : {}) };
}

/**
 * GET /api/agent-files: groups of existing files for one agent. Hermes takes a profile,
 * OpenClaw and QClaw take an agent id; both list the available choices.
 */
export async function listAgentFiles(agentId, { homeDirectory = homedir(), homes = [homeDirectory], profile = null, agent = null } = {}) {
  let result;
  switch (agentId) {
    case "codex":
      result = { groups: await codexGroups(homeDirectory, homes) };
      break;
    case "claude":
      result = { groups: await claudeGroups(homeDirectory, homes) };
      break;
    case "workbuddy":
      result = { groups: await workBuddyGroups(homeDirectory, homes) };
      break;
    case "office-raccoon":
      result = { groups: await raccoonGroups(homeDirectory, homes) };
      break;
    case "hermes":
      result = await hermesGroups(homeDirectory, homes, profile);
      break;
    case "openclaw":
    case "qclaw":
      result = await openClawGroups(agentId, homeDirectory, homes, agent);
      break;
    default:
      result = { groups: await singleFileGroups(agentId, homeDirectory, homes) };
  }
  return { agentId, ...result, groups: result.groups.filter(Boolean) };
}

export const AGENT_FILE_AGENTS = ["codex", "claude", "workbuddy", "gemini", "cursor", "hermes", "openclaw", "qclaw", "office-raccoon"];

/** Re-lists every agent, profile and OpenClaw agent so ids survive a service restart. */
async function rebuildRegistry(homeDirectory, homes) {
  for (const agentId of AGENT_FILE_AGENTS) {
    const listing = await listAgentFiles(agentId, { homeDirectory, homes }).catch(() => null);
    for (const profile of listing?.profiles || []) {
      await listAgentFiles(agentId, { homeDirectory, homes, profile }).catch(() => null);
    }
    for (const agent of listing?.agents || []) {
      await listAgentFiles(agentId, { homeDirectory, homes, agent }).catch(() => null);
    }
  }
}

const countMasks = (value) => String(value).split(MASK).length - 1;

function redactText(value, homes) {
  const cleaned = compactHomeInText(String(value), homes)
    .replace(/\p{Cf}/gu, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ");
  const scrubbed = scrubTokens(cleaned);
  return { text: scrubbed, redactions: Math.max(0, countMasks(scrubbed) - countMasks(cleaned)) };
}

function structured(value, homes, language) {
  const masked = maskConfig(value, { homes });
  const body = language === "yaml" ? dumpYaml(masked) : `${JSON.stringify(masked, null, 2)}\n`;
  return { text: compactHomeInText(body, homes), redactions: countMasks(body) };
}

export class AgentFileError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** GET /api/agent-file: one listed file, redacted. */
export async function readAgentFile(id, { homeDirectory = homedir(), homes = [homeDirectory] } = {}) {
  if (!/^[a-f0-9]{24}$/u.test(String(id || ""))) throw new AgentFileError(404, "找不到这个文件。");
  if (!registry.has(id)) await rebuildRegistry(homeDirectory, homes);
  const entry = registry.get(id);
  if (!entry) throw new AgentFileError(404, "找不到这个文件，请刷新文件列表。");
  if (!entry.virtual && isSensitiveFileName(entry.relativePath)) throw new AgentFileError(403, "这类文件不会开放预览。");
  const realFile = await resolveInside(entry.root, entry.relativePath);
  if (!realFile) throw new AgentFileError(404, "文件已不存在或指向了允许范围之外。");
  const base = { name: entry.name, language: entry.language };
  if (entry.render) {
    // Renderers emit an allow-listed summary (or Markdown text); it is scrubbed, not value-masked.
    const rendered = await entry.render(realFile);
    if (typeof rendered === "string") return { ...base, language: "md", ...redactText(rendered, homes), truncated: false };
    return { ...base, ...redactText(`${JSON.stringify(rendered, null, 2)}\n`, homes), truncated: false };
  }
  if (entry.language === "yaml" || entry.language === "json") {
    const read = await readBoundedText(realFile, AGENT_FILE_LIMIT);
    if (read.status === "ok") {
      let parsed = null;
      try {
        parsed = entry.language === "json" ? JSON.parse(read.text) : parseYamlSafe(read.text);
      } catch {
        parsed = null;
      }
      if (parsed && typeof parsed === "object") return { ...base, ...structured(parsed, homes, entry.language), truncated: false };
    }
    if (read.status !== "too-large" && read.status !== "ok") throw new AgentFileError(404, "文件无法安全读取。");
    // Unparseable or oversized structured files fall back to redacted text.
  }
  const prefix = await readTextPrefix(realFile, AGENT_FILE_LIMIT);
  if (prefix.status !== "ok") throw new AgentFileError(404, "文件无法安全读取。");
  return {
    ...base,
    // Structured files that could not be parsed are shown as redacted text.
    language: entry.language === "md" ? "md" : "text",
    ...redactText(prefix.text, homes),
    truncated: Boolean(prefix.truncated),
  };
}

/** Test hook: forget every listed id. */
export function clearAgentFileRegistry() {
  registry.clear();
}
