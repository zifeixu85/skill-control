import path from "node:path";
import { isTokenLike, MASK, maskCommandLine } from "./config-mask.mjs";
import {
  multilineText,
  object,
  readBoundedJson,
  readBoundedToml,
  safeSegment,
  text,
} from "./fs-safe.mjs";

/**
 * Key settings of an Agent as Chinese rows. Only safe scalar facts and counts are read;
 * full files are never returned because they contain secrets and project lists.
 */

const CONFIG_LIMIT = 2_000_000;
const CLAUDE_STATE_LIMIT = 30_000_000;
const LIST_LIMIT = 50;

const APPROVAL = {
  never: "从不询问",
  "on-request": "需要时询问",
  "on-failure": "失败后询问",
  untrusted: "只放行已知安全命令",
};
const SANDBOX = {
  "danger-full-access": "完全访问，不使用沙箱",
  "workspace-write": "只能写当前工作区",
  "read-only": "只读",
};
const EFFORT = { minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "极高" };
const CREDENTIAL_STORE = { file: "本地文件", keyring: "系统钥匙串", auto: "自动选择" };
const CLAUDE_MODES = {
  default: "默认（逐项确认）",
  acceptEdits: "自动接受编辑",
  plan: "计划模式",
  bypassPermissions: "跳过权限确认",
  dontAsk: "不再询问",
};

const translated = (map, value) =>
  typeof value === "string" && value
    ? map[value]
      ? `${map[value]}（${text(value, 40)}）`
      : text(value, 80)
    : "未设置（使用默认）";
const yesNo = (value) => (value === true ? "是" : value === false ? "否" : "未设置");
const keysOf = (value) => Object.keys(object(value)).filter((key) => safeSegment(key) || /^[\w.-]{1,64}$/u.test(key));
const joinList = (items, empty = "无") =>
  items.length
    ? `${items.slice(0, LIST_LIMIT).join("、")}${items.length > LIST_LIMIT ? ` 等 ${items.length} 项` : ""}`
    : empty;
/** Identifiers such as model names: shown only when they do not look like tokens. */
const safeIdentifier = (value, fallback = "未设置（使用默认）") => {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const trimmed = value.trim();
  return /^[\p{L}\p{N}][\p{L}\p{N}._:/ -]{0,63}$/u.test(trimmed) &&
    !trimmed.split(/[-._:/ ]+/u).some(isTokenLike)
    ? trimmed
    : MASK;
};
const safeTheme = (value) =>
  typeof value === "string" && /^[A-Za-z][A-Za-z -]{0,31}$/u.test(value) ? value : value ? MASK : "未设置";

/** `Bash(cmd …)` → tool name + masked command; other rules keep the tool name and masked body. */
function maskPermissionRule(rule, homes) {
  const trimmed = String(rule).slice(0, 2_000).trim();
  const call = trimmed.match(/^([A-Za-z][\w-]{0,63})\(([\s\S]*)\)$/u);
  if (!call) return text(maskCommandLine(trimmed, homes), 200);
  return text(`${call[1]}(${maskCommandLine(call[2], homes)})`, 300);
}

const row = (label, value) => ({ label, value: multilineText(String(value), 4_000) });

async function codexRows(homeDirectory) {
  const configPath = path.join(homeDirectory, ".codex", "config.toml");
  const config = await readBoundedToml(configPath, CONFIG_LIMIT);
  if (config.status !== "ok") return null;
  const value = object(config.value);
  const hooks = await readBoundedJson(path.join(homeDirectory, ".codex", "hooks.json"), CONFIG_LIMIT);
  const plugins = Object.values(object(value.plugins));
  const features = Object.entries(object(value.features))
    .filter(([, enabled]) => typeof enabled === "boolean")
    .map(([name, enabled]) => `${text(name, 64)} ${enabled ? "开" : "关"}`);
  const marketplaces = Object.entries(object(value.marketplaces))
    .filter(([name]) => safeSegment(name))
    .map(([name, market]) => `${safeIdentifier(name, MASK)}（${safeIdentifier(object(market).source_type, "未知")}）`);
  const trusted = Object.values(object(value.projects)).filter(
    (project) => object(project).trust_level === "trusted",
  ).length;
  const shellVariables = keysOf(object(value.shell_environment_policy).set).length;
  return {
    title: "Codex 配置",
    location: "~/.codex/config.toml",
    rows: [
      row("模型", safeIdentifier(value.model)),
      row("推理强度", translated(EFFORT, value.model_reasoning_effort)),
      row("审批策略", translated(APPROVAL, value.approval_policy)),
      row("沙箱模式", translated(SANDBOX, value.sandbox_mode)),
      row("功能开关", joinList(features)),
      row("MCP 服务数", keysOf(value.mcp_servers).length),
      row(
        "已启用插件数",
        `${plugins.filter((plugin) => object(plugin).enabled === true).length} / ${plugins.length}`,
      ),
      row("插件市场", joinList(marketplaces)),
      row(
        "Hooks 事件",
        hooks.status === "ok" ? joinList(keysOf(object(hooks.value).hooks)) : "未配置",
      ),
      row("受信任项目数", trusted),
      row("Shell 环境变量", shellVariables ? `${shellVariables} 个（不显示值）` : "无"),
      row("MCP 凭据存储", translated(CREDENTIAL_STORE, value.mcp_oauth_credentials_store)),
    ],
  };
}

async function claudeRows(homeDirectory, homes) {
  const settings = await readBoundedJson(path.join(homeDirectory, ".claude", "settings.json"), CONFIG_LIMIT);
  if (settings.status !== "ok") return null;
  const value = object(settings.value);
  const permissions = object(value.permissions);
  const rules = (list) =>
    (Array.isArray(list) ? list : [])
      .filter((rule) => typeof rule === "string")
      .slice(0, LIST_LIMIT)
      .map((rule) => maskPermissionRule(rule, homes));
  const state = await readBoundedJson(path.join(homeDirectory, ".claude.json"), CLAUDE_STATE_LIMIT);
  const claudeState = state.status === "ok" ? object(state.value) : {};
  const projectServers = Object.values(object(claudeState.projects)).reduce(
    (sum, project) => sum + keysOf(object(project).mcpServers).length,
    0,
  );
  const statusLine = object(value.statusLine);
  const marketplaces = Object.entries(object(value.extraKnownMarketplaces))
    .filter(([name]) => safeSegment(name))
    .map(([name, market]) => `${safeIdentifier(name, MASK)}（${safeIdentifier(object(object(market).source).source, "未知")}）`);
  const rows = [
    row("允许规则", rules(permissions.allow).join("\n") || "无"),
    row("拒绝规则", rules(permissions.deny).join("\n") || "无"),
    row("询问规则", rules(permissions.ask).join("\n") || "无"),
    row("默认权限模式", translated(CLAUDE_MODES, permissions.defaultMode)),
    row("Hooks 事件", joinList(keysOf(value.hooks), "未配置")),
    row(
      "已启用插件",
      joinList(
        Object.entries(object(value.enabledPlugins))
          .filter(([, enabled]) => enabled === true)
          .map(([name]) => text(name, 128)),
      ),
    ),
    row("额外插件市场", joinList(marketplaces)),
    row("跳过危险模式确认", yesNo(value.skipDangerousModePermissionPrompt)),
    row(
      "状态栏",
      statusLine.type
        ? `${safeIdentifier(statusLine.type, "")}${statusLine.command ? `：${text(maskCommandLine(String(statusLine.command), homes), 300)}` : ""}`
        : "未配置",
    ),
    row("主题", safeTheme(value.theme)),
    row(
      "MCP 服务数",
      `${keysOf(claudeState.mcpServers).length} 个用户级${projectServers ? `，${projectServers} 个项目级` : ""}`,
    ),
    row("环境变量", keysOf(value.env).length ? `${keysOf(value.env).length} 个（不显示值）` : "无"),
  ];
  return { title: "Claude Code 配置", location: "~/.claude/settings.json", rows };
}

async function workbuddyRows(homeDirectory) {
  const settings = await readBoundedJson(path.join(homeDirectory, ".workbuddy", "settings.json"), CONFIG_LIMIT);
  if (settings.status !== "ok") return null;
  const value = object(settings.value);
  const sandbox = object(value.sandbox);
  const plugins = Object.values(object(value.enabledPlugins));
  const installed = await readBoundedJson(
    path.join(homeDirectory, ".workbuddy", "plugins", "installed_plugins.json"),
    CONFIG_LIMIT,
  );
  const ruleCount = Array.isArray(sandbox.orderedRules)
    ? sandbox.orderedRules.length
    : Object.keys(object(sandbox.orderedRules)).length;
  return {
    title: "WorkBuddy 配置",
    location: "~/.workbuddy/settings.json",
    rows: [
      row(
        "沙箱额外可写目录",
        Array.isArray(sandbox.extraAllowWrite) ? `${sandbox.extraAllowWrite.length} 个` : "无",
      ),
      row("沙箱规则数", ruleCount),
      row("网络默认拒绝已迁移", yesNo(sandbox.networkDenyAllMigrated)),
      row("已启用插件", `${plugins.filter((enabled) => enabled === true).length} / ${plugins.length}`),
      row(
        "已安装插件数",
        installed.status === "ok" ? Object.keys(object(object(installed.value).plugins)).length : "未知",
      ),
      row("Hooks 事件", joinList(keysOf(value.hooks), "未配置")),
    ],
  };
}

async function geminiRows(homeDirectory) {
  const settings = await readBoundedJson(path.join(homeDirectory, ".gemini", "settings.json"), CONFIG_LIMIT);
  if (settings.status !== "ok") return null;
  const value = object(settings.value);
  const auth = object(object(value.security).auth);
  const model = typeof value.model === "string" ? value.model : object(value.model).name;
  return {
    title: "Gemini CLI 配置",
    location: "~/.gemini/settings.json",
    rows: [
      row("模型", safeIdentifier(model)),
      row("认证方式", safeIdentifier(auth.selectedType || value.selectedAuthType, "未设置")),
      row("主题", safeTheme(object(value.ui).theme || value.theme)),
      row("MCP 服务数", keysOf(value.mcpServers).length),
      row("Hooks 事件", joinList(keysOf(value.hooks), "未配置")),
    ],
  };
}

async function cursorRows(homeDirectory) {
  const config = await readBoundedJson(path.join(homeDirectory, ".cursor", "mcp.json"), CONFIG_LIMIT);
  if (config.status !== "ok") return null;
  const servers = keysOf(object(config.value).mcpServers);
  return {
    title: "Cursor 配置",
    location: "~/.cursor/mcp.json",
    rows: [row("MCP 服务数", servers.length), row("MCP 服务", joinList(servers))],
  };
}

const READERS = {
  codex: codexRows,
  claude: claudeRows,
  workbuddy: workbuddyRows,
  gemini: geminiRows,
  cursor: cursorRows,
};

export const AGENT_DETAIL_IDS = Object.keys(READERS);

export async function agentSettingsDetail(agentId, homeDirectory, homes) {
  const reader = READERS[agentId];
  if (!reader) return null;
  const detail = await reader(homeDirectory, homes);
  return (
    detail || {
      title: "Agent 配置",
      location: null,
      rows: [row("状态", "未找到配置文件，或文件无法安全读取")],
    }
  );
}
