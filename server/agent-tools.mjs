import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { maskPermissionRule } from "./agent-settings.mjs";
import { readYamlFile } from "./config-files.mjs";
import { maskCommandLine, safeIdentifier } from "./config-mask.mjs";
import { parseFrontmatter } from "./frontmatter.mjs";
import {
  compactHomeInText,
  isSensitiveFileName,
  object,
  readBoundedJson,
  readBoundedToml,
  readTextPrefix,
  resolveInside,
  scrubTokens,
  text,
} from "./fs-safe.mjs";
import { expandToolsets, readHermesToolsets } from "./hermes-toolsets.mjs";
import { hermesHomeFor } from "./hermes.mjs";
import { resolveOpenClawInstall } from "./openclaw.mjs";

/**
 * GET /api/agent-tools: what an agent can call — feature flags, toolsets, MCP servers,
 * connectors, plugin commands, subagents and permission rules. Names and short,
 * redacted descriptions only; tool lists come from caches the agent itself wrote.
 */

const ITEM_LIMIT = 300;
const DESCRIPTION_LIMIT = 300;
const NO_TOOL_CACHE = "未缓存工具清单";

const describe = (value) => text(scrubTokens(String(value ?? "").replace(/\s+/gu, " ")), DESCRIPTION_LIMIT);
const item = (name, kind, { description = "", enabled = null, tools = null } = {}) => ({
  name: text(String(name), 160),
  description: describe(description),
  kind,
  enabled,
  ...(tools ? { tools: tools.slice(0, 50).map((tool) => text(String(tool), 80)) } : {}),
});
const groupOf = (id, label, source, items) =>
  items.length ? { id, label, source, items: items.slice(0, ITEM_LIMIT) } : null;

function mcpItems(integrations, agentId) {
  return (integrations?.mcpServers || [])
    .filter((server) => server.agentId === agentId && server.scope !== "project")
    .map((server) =>
      item(server.name, "mcp", {
        enabled: server.enabled,
        description: [server.transport, server.host, NO_TOOL_CACHE].filter(Boolean).join(" · "),
      }),
    );
}

function pluginItems(integrations, agentId) {
  const items = [];
  for (const plugin of (integrations?.plugins || []).filter((entry) => entry.agentId === agentId)) {
    const components = plugin.components || {};
    const enabled = plugin.enabled === true ? true : plugin.enabled === false ? false : null;
    for (const [list, label, kind] of [
      [components.commands, "插件命令", "plugin-command"],
      [components.skills, "插件技能", "plugin-command"],
      [components.agents, "插件子代理", "subagent"],
    ]) {
      for (const name of (Array.isArray(list) ? list : []).slice(0, 50)) {
        items.push(item(`${plugin.id}:${name}`, kind, { enabled, description: `${label} · ${plugin.displayName}` }));
      }
    }
    const extras = [
      components.channels?.length ? `频道：${components.channels.join("、")}` : "",
      components.mcpServers?.length ? `MCP：${components.mcpServers.map((server) => server.name).join("、")}` : "",
    ].filter(Boolean);
    if (extras.length) items.push(item(plugin.displayName, "feature", { enabled, description: extras.join("；") }));
  }
  return items;
}

/** Markdown definitions (subagents, commands): name and description from frontmatter. */
async function markdownItems(root, directory, kind, prefix = "") {
  let entries;
  try {
    entries = await readdir(path.join(root, directory), { withFileTypes: true });
  } catch {
    return [];
  }
  const items = [];
  for (const entry of entries.filter((value) => value.name.endsWith(".md")).slice(0, ITEM_LIMIT)) {
    const relative = path.join(directory, entry.name);
    if (isSensitiveFileName(relative)) continue;
    const real = await resolveInside(root, relative);
    if (!real) continue;
    const head = await readTextPrefix(real, 16_000);
    if (head.status !== "ok") continue;
    const parsed = parseFrontmatter(head.text, entry.name.replace(/\.md$/u, ""));
    items.push(item(`${prefix}${parsed.name}`, kind, { description: parsed.description }));
  }
  return items.sort((left, right) => left.name.localeCompare(right.name));
}

async function codexTools(homeDirectory, homes, integrations) {
  const config = await readBoundedToml(path.join(homeDirectory, ".codex", "config.toml"), 2_000_000);
  const value = config.status === "ok" ? object(config.value) : {};
  const features = Object.entries(object(value.features))
    .filter(([name, enabled]) => typeof enabled === "boolean" && /^[\w.-]{1,64}$/u.test(name))
    .map(([name, enabled]) => item(name, "feature", { enabled }));
  const connectors = (integrations?.connectors || []).map((connector) =>
    item(connector.name, "connector", {
      enabled: true,
      description: `${connector.toolCount} 个工具${connector.toolNames.length ? `：${connector.toolNames.join("、")}` : ""}`,
      tools: connector.toolNames,
    }),
  );
  return {
    groups: [
      groupOf("features", "功能开关", "~/.codex/config.toml", features),
      groupOf("connectors", "已连接应用", "~/.codex/cache/codex_apps_tools", connectors),
      groupOf("mcp", "MCP 服务", "~/.codex/config.toml", mcpItems(integrations, "codex")),
      groupOf("plugins", "插件提供的技能与命令", "Codex 插件", pluginItems(integrations, "codex")),
    ],
    notes: ["MCP 服务的工具清单只在 Agent 运行时获取，本地没有缓存。"],
  };
}

async function claudeTools(homeDirectory, homes, integrations) {
  const root = path.join(homeDirectory, ".claude");
  const settings = await readBoundedJson(path.join(root, "settings.json"), 2_000_000);
  const permissions = object(object(settings.status === "ok" ? settings.value : {}).permissions);
  const rules = [];
  for (const [key, enabled, label] of [["allow", true, "允许"], ["ask", null, "询问"], ["deny", false, "拒绝"]]) {
    for (const rule of (Array.isArray(permissions[key]) ? permissions[key] : []).slice(0, 200)) {
      if (typeof rule === "string") rules.push(item(maskPermissionRule(rule, homes), "permission", { enabled, description: label }));
    }
  }
  if (typeof permissions.defaultMode === "string") {
    rules.unshift(item("默认模式", "permission", { description: safeIdentifier(permissions.defaultMode) }));
  }
  return {
    groups: [
      groupOf("permissions", "权限规则", "~/.claude/settings.json", rules),
      groupOf("mcp", "MCP 服务", "~/.claude.json", mcpItems(integrations, "claude")),
      groupOf("subagents", "子代理", "~/.claude/agents", await markdownItems(root, "agents", "subagent")),
      groupOf("commands", "命令", "~/.claude/commands", await markdownItems(root, "commands", "plugin-command", "/")),
      groupOf("plugins", "插件提供的命令与子代理", "Claude Code 插件", pluginItems(integrations, "claude")),
    ],
    notes: ["MCP 服务的工具清单只在 Agent 运行时获取，本地没有缓存。"],
  };
}

/** WorkBuddy caches MCP tool lists keyed by a digest of each server's settings. */
async function workBuddyTools(homeDirectory, homes, integrations) {
  const root = path.join(homeDirectory, ".workbuddy");
  const cache = await readBoundedJson(path.join(root, "mcp-tool-list.json"), 4_000_000);
  const groups = [];
  for (const [key, tools] of Object.entries(object(object(cache.status === "ok" ? cache.value : {}).entries)).slice(0, 100)) {
    if (!Array.isArray(tools)) continue;
    const label = /^[a-f0-9]{8,64}$/u.test(key) ? key.slice(0, 8) : "未知";
    groups.push(
      groupOf(
        `mcp-${label}`,
        `MCP 工具（服务 ${label}）`,
        "~/.workbuddy/mcp-tool-list.json",
        tools.map((tool) => item(object(tool).name, "mcp", { description: object(tool).description })),
      ),
    );
  }
  const connectors = [];
  let accounts = [];
  try {
    accounts = (await readdir(path.join(root, "connectors"), { withFileTypes: true })).filter(
      (entry) => entry.isDirectory() && /^[a-f0-9-]{16,64}$/u.test(entry.name),
    );
  } catch {
    accounts = [];
  }
  for (const account of accounts.slice(0, 5)) {
    // Only connector names and their switches; header/env overrides and keys are never read out.
    const states = await readBoundedJson(path.join(root, "connectors", account.name, "connector-states.json"), 1_000_000);
    for (const [name, state] of Object.entries(object(object(states.status === "ok" ? states.value : {}).connectors)).slice(0, 100)) {
      if (!/^[\w.-]{1,64}$/u.test(name)) continue;
      connectors.push(
        item(name, "connector", {
          enabled: object(state).enabled === true,
          description: object(state).bound === true ? "已绑定账号" : "未绑定",
        }),
      );
    }
  }
  return {
    groups: [
      ...groups,
      groupOf("connectors", "连接器", "~/.workbuddy/connectors", connectors),
      groupOf("plugins", "插件提供的命令与技能", "WorkBuddy 插件", pluginItems(integrations, "workbuddy")),
    ],
    notes: groups.length ? ["WorkBuddy 按服务配置的摘要缓存工具清单，无法对应到服务名称。"] : [],
  };
}

async function hermesTools(homeDirectory, homes, integrations) {
  const hermesHome = hermesHomeFor(homeDirectory);
  const config = await readYamlFile(path.join(hermesHome, "config.yaml"));
  const value = config.status === "ok" ? object(config.value) : {};
  const enabledNames = (Array.isArray(value.toolsets) ? value.toolsets : []).filter((name) => typeof name === "string" && /^[\w.-]{1,64}$/u.test(name));
  const definitions = await readHermesToolsets(hermesHome);
  const notes = [];
  const groups = [];
  if (definitions) {
    const { active, tools } = expandToolsets(enabledNames, definitions);
    groups.push(
      groupOf(
        "toolsets",
        "工具集",
        "~/.hermes/config.yaml · hermes-agent/toolsets.py",
        [...definitions].map(([name, definition]) =>
          item(name, "toolset", { enabled: active.has(name), description: definition.description, tools: definition.tools }),
        ).sort((left, right) => Number(right.enabled) - Number(left.enabled) || left.name.localeCompare(right.name)),
      ),
      groupOf("tools", "已启用的工具", "hermes-agent/toolsets.py", [...tools].sort().map((name) => item(name, "builtin", { enabled: true }))),
    );
  } else {
    notes.push("没有找到 Hermes 源码中的工具集定义，只列出配置里启用的工具集。");
    groups.push(groupOf("toolsets", "工具集", "~/.hermes/config.yaml", enabledNames.map((name) => item(name, "toolset", { enabled: true }))));
  }
  const allowlist = (Array.isArray(value.command_allowlist) ? value.command_allowlist : [])
    .filter((entry) => typeof entry === "string")
    .slice(0, 200)
    .map((entry) => item(maskCommandLine(entry, homes), "permission", { enabled: true, description: "命令白名单" }));
  const plugins = (integrations?.plugins || [])
    .filter((plugin) => plugin.agentId === "hermes")
    .map((plugin) =>
      item(plugin.displayName, "feature", {
        enabled: plugin.enabled === true ? true : plugin.enabled === false ? false : null,
        description: `插件${plugin.version ? ` · ${plugin.version}` : ""}${plugin.shortDescription ? ` · ${plugin.shortDescription}` : ""}`,
      }),
    );
  groups.push(
    groupOf("permissions", "命令白名单", "~/.hermes/config.yaml", allowlist),
    groupOf("mcp", "MCP 服务", "~/.hermes/config.yaml", mcpItems(integrations, "hermes")),
    groupOf("plugins", "插件", "~/.hermes/plugins", plugins),
  );
  return { groups, notes };
}

const listOf = (value) => (Array.isArray(value) ? value : []).filter((entry) => typeof entry === "string").slice(0, 200);

async function openClawTools(kind, homeDirectory, homes, integrations) {
  const install = await resolveOpenClawInstall(kind, homeDirectory);
  if (!install.available) return { groups: [], notes: [] };
  const tools = object(install.config.tools);
  const policy = [];
  if (typeof tools.profile === "string") policy.push(item("工具档位", "feature", { description: safeIdentifier(tools.profile) }));
  for (const [key, enabled, label] of [["allow", true, "允许"], ["alsoAllow", true, "额外允许"], ["deny", false, "禁止"]]) {
    for (const name of listOf(tools[key])) policy.push(item(safeIdentifier(name) || "••••••", "permission", { enabled, description: label }));
  }
  for (const [section, settings] of Object.entries(object(tools)).filter(([, entry]) => entry && typeof entry === "object" && !Array.isArray(entry))) {
    if (!/^[\w.-]{1,64}$/u.test(section)) continue;
    for (const [name, entry] of Object.entries(settings).slice(0, 20)) {
      if (!/^[\w.-]{1,64}$/u.test(name) || !entry || typeof entry !== "object") continue;
      const enabled = typeof entry.enabled === "boolean" ? entry.enabled : null;
      policy.push(item(`${section}.${name}`, "feature", { enabled, description: typeof entry.provider === "string" ? safeIdentifier(entry.provider) : "" }));
    }
  }
  const browser = object(install.config.browser);
  if (Object.keys(browser).length) {
    policy.push(item("浏览器", "feature", { enabled: browser.enabled === false ? false : browser.enabled === true ? true : null }));
  }
  return {
    groups: [
      groupOf("policy", "工具策略", kind === "qclaw" ? "~/.qclaw/openclaw.json" : "~/.openclaw/openclaw.json", policy),
      groupOf("mcp", "MCP 服务", "openclaw.json · mcp.servers", mcpItems(integrations, kind)),
      groupOf("plugins", "插件", "openclaw.plugin.json", pluginItems(integrations, kind)),
    ],
    notes: ["OpenClaw 插件清单不声明具体工具，这里列出插件提供的频道与技能。"],
  };
}

export const AGENT_TOOL_AGENTS = ["codex", "claude", "workbuddy", "hermes", "openclaw", "qclaw"];

export async function listAgentTools(agentId, { homeDirectory = homedir(), homes = [homeDirectory], integrations = null } = {}) {
  const readers = {
    codex: codexTools,
    claude: claudeTools,
    workbuddy: workBuddyTools,
    hermes: hermesTools,
    openclaw: (home, homeList, payload) => openClawTools("openclaw", home, homeList, payload),
    qclaw: (home, homeList, payload) => openClawTools("qclaw", home, homeList, payload),
  };
  const reader = readers[agentId];
  const result = reader
    ? await reader(homeDirectory, homes, integrations)
    : { groups: [groupOf("mcp", "MCP 服务", "配置文件", mcpItems(integrations, agentId))], notes: [] };
  const payload = { agentId, groups: result.groups.filter(Boolean), notes: result.notes };
  // Descriptions come from third-party caches: never echo the home directory.
  return JSON.parse(compactHomeInText(JSON.stringify(payload), homes));
}
