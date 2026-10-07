import path from "node:path";
import { stringify as stringifyToml } from "smol-toml";
import { agentSettingsDetail, AGENT_DETAIL_IDS } from "./agent-settings.mjs";
import { isSecretKey, MASK, maskConfig, maskServerConfig, scrubTokens } from "./config-mask.mjs";
import { frontmatterBlock, readYamlScalar } from "./frontmatter.mjs";
import { dumpYaml, readYamlFile } from "./config-files.mjs";
import {
  compactHomeInText,
  hostnameOf,
  isSensitiveFileName,
  object,
  readBoundedJson,
  readTextPrefix,
  resolveInside,
} from "./fs-safe.mjs";
import { readMcpSources, serverTransport, serverUrl } from "./mcp-inventory.mjs";
import { secretFieldReport } from "./secret-fields.mjs";
import { isSensitiveCapabilityPath } from "./workbuddy-experts.mjs";

/**
 * Read-only configuration details shown inside the app:
 *   { title, rows: [{ label, value }], files: [{ path, label, language, text, truncated }], location }
 *
 * Structured files (MCP sections, plugin and expert manifests, declared JSON files) are
 * parsed and passed through the default-deny masker; free text (SKILL.md, agent
 * prompts, SOUL.md) goes through the redactor. Every string leaving here has home paths
 * compacted to "~" and format characters removed.
 */

export const DETAIL_KINDS = new Set(["agent", "mcp", "expert", "plugin", "skill"]);
const EXPERT_FILE_LIMIT = 20_000;
const FILE_LIMIT = 64_000;
const MANIFEST_LIMIT = 256_000;
const MCP_CACHE_TTL = 30_000;
const AGENT_LABELS = {
  codex: "Codex",
  claude: "Claude Code",
  cursor: "Cursor",
  gemini: "Gemini CLI",
  workbuddy: "WorkBuddy",
  hermes: "Hermes Agent",
  openclaw: "OpenClaw",
  qclaw: "QClaw",
};
const TRANSPORT_LABELS = { stdio: "本地命令（stdio）", http: "HTTP", sse: "SSE", unknown: "未知" };
const MANIFEST_FILES = {
  codex: ".codex-plugin/plugin.json",
  claude: ".claude-plugin/plugin.json",
  workbuddy: ".codebuddy-plugin/plugin.json",
  hermes: "plugin.yaml",
  openclaw: "openclaw.plugin.json",
  qclaw: "openclaw.plugin.json",
};

export class DetailError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** Free text: home compaction, format-character removal and credential redaction. */
export function cleanText(value, homes) {
  return scrubTokens(
    compactHomeInText(String(value), homes)
      .replace(/\p{Cf}/gu, "")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " "),
  );
}

/** Serialized structured text: already masked, so only compaction and character cleanup. */
function cleanStructured(value, homes) {
  return compactHomeInText(String(value), homes)
    .replace(/\p{Cf}/gu, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ");
}

const row = (label, value, homes) => ({
  label: cleanText(label, homes).slice(0, 120),
  value: cleanText(value === null || value === undefined || value === "" ? "无" : String(value), homes).slice(0, 4_000),
});

function fileEntry({ filePath, label, language, body, truncated = false, structured = false }, homes) {
  const raw = String(body);
  const bounded = raw.slice(0, FILE_LIMIT);
  const cleaned = structured ? cleanStructured(bounded, homes) : cleanText(bounded, homes);
  truncated = truncated || raw.length > FILE_LIMIT;
  return {
    path: cleanText(filePath, homes).slice(0, 512),
    label: label ? cleanText(label, homes).slice(0, 200) : null,
    language,
    text: cleaned.slice(0, FILE_LIMIT),
    truncated: truncated || cleaned.length > FILE_LIMIT,
  };
}

async function readDisplayFile(root, relativePath, limit) {
  const resolved = await resolveInside(root, relativePath);
  if (!resolved) return null;
  const read = await readTextPrefix(resolved, limit);
  return read.status === "ok" ? read : null;
}

function languageOf(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return { ".json": "json", ".toml": "toml", ".yaml": "yaml", ".yml": "yaml" }[extension] || "md";
}

function stripNulls(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== null).map(stripNulls);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== null && item !== undefined)
        .map(([key, item]) => [key, stripNulls(item)]),
    );
  }
  return value;
}

/** Parses a JSON file inside `root` and returns a masked, pretty-printed file entry. */
async function maskedJsonFile(root, relativePath, homes, { label = null, limit = MANIFEST_LIMIT } = {}) {
  const resolved = await resolveInside(root, relativePath);
  if (!resolved) return null;
  const read = await readBoundedJson(resolved, limit);
  const filePath = relativePath.replace(/^\.\//u, "");
  if (read.status === "missing") return null;
  if (read.status !== "ok") {
    return fileEntry({ filePath, label, language: "json", body: "（文件过大或格式无效，未显示）" }, homes);
  }
  const body = JSON.stringify(maskConfig(read.value, { homes }), null, 2);
  return fileEntry({ filePath, label, language: "json", body, structured: true }, homes);
}

function secretReminders(config) {
  const likely = secretFieldReport(config).likely;
  const messages = new Set();
  for (const field of likely) {
    const group = field.split(/[.[]/u)[0];
    if (/header/iu.test(group)) messages.add("请求头里写着密钥");
    else if (/^env/iu.test(group)) messages.add("环境变量里写着密钥");
    else if (group === "args") messages.add("启动参数里写着密钥");
    else if (/url$/iu.test(group)) messages.add("地址里带着凭据或令牌");
    else messages.add("配置里直接写着密钥");
  }
  return [...messages];
}

function entryLabel(entry) {
  const agent = AGENT_LABELS[entry.agentId] || entry.agentId;
  return entry.scope === "project" && entry.projectPath ? `${agent}（项目 ${entry.projectPath}）` : agent;
}

// ~/.claude.json can be tens of MB: parse it at most every 30 s.
const mcpSourceCache = new Map();
function cachedMcpSources(homeDirectory) {
  const cached = mcpSourceCache.get(homeDirectory);
  if (cached && Date.now() - cached.at < MCP_CACHE_TTL) return cached.promise;
  const promise = readMcpSources(homeDirectory).catch((error) => {
    mcpSourceCache.delete(homeDirectory);
    throw error;
  });
  mcpSourceCache.set(homeDirectory, { at: Date.now(), promise });
  return promise;
}

async function mcpDetail(name, context) {
  const { entries } = await cachedMcpSources(context.homeDirectory);
  const matches = entries.filter((entry) => entry.name === name);
  if (!matches.length) throw new DetailError(404, "没有找到这个 MCP 服务的配置。");
  const homes = context.displayHomes;
  const files = matches.map((entry) => {
    const masked = stripNulls(maskServerConfig(entry.config, { homes }));
    const body =
      entry.format === "toml"
        ? stringifyToml({ mcp_servers: { [entry.name]: masked } })
        : entry.format === "yaml"
          ? dumpYaml({ mcp_servers: { [entry.name]: masked } })
          : JSON.stringify({ [entry.name]: masked }, null, 2);
    return fileEntry(
      { filePath: entry.source, label: entryLabel(entry), language: entry.format, body, structured: true },
      homes,
    );
  });
  const transports = [...new Set(matches.map((entry) => serverTransport(entry.agentId, entry.config)))];
  const hosts = [
    ...new Set(
      matches
        .map((entry) => (serverTransport(entry.agentId, entry.config) === "stdio" ? null : hostnameOf(String(serverUrl(entry.config) || "").trim())))
        .filter(Boolean),
    ),
  ];
  const enabledStates = matches
    .filter((entry) => typeof entry.config.enabled === "boolean" || typeof entry.config.disabled === "boolean")
    .map((entry) => {
      const enabled = typeof entry.config.enabled === "boolean" ? entry.config.enabled : !entry.config.disabled;
      return `${entryLabel(entry)}：${enabled ? "已启用" : "已停用"}`;
    });
  const reminders = [...new Set(matches.flatMap((entry) => secretReminders(entry.config)))];
  return {
    title: cleanText(`MCP 服务 · ${name}`, homes),
    location: cleanText(
      matches.map((entry) => entry.source).filter((value, index, list) => list.indexOf(value) === index).join("、"),
      homes,
    ),
    rows: [
      row("服务名", name, homes),
      row("配置在", matches.map(entryLabel).join("、"), homes),
      row("连接方式", transports.map((transport) => TRANSPORT_LABELS[transport] || transport).join("、"), homes),
      row("地址", hosts.length ? hosts.join("、") : transports.includes("stdio") ? "本机进程" : "未知", homes),
      ...(enabledStates.length ? [row("启用状态", enabledStates.join("、"), homes)] : []),
      row(
        "提醒",
        reminders.length
          ? `${reminders.join("、")}，建议改用环境变量引用（如 \${API_KEY}）。`
          : "未发现明文密钥",
        homes,
      ),
    ],
    files,
  };
}

function expertRows(capability, homes) {
  const members = capability.members || [];
  const team = capability.kind === "expert-team";
  const turns = team
    ? members.filter((member) => member.maxTurns).map((member) => `${member.displayName}：${member.maxTurns}`).join("、")
    : members[0]?.maxTurns;
  return [
    row("类型", capability.kindLabel, homes),
    row("名称", capability.displayName, homes),
    row("技术名", capability.name, homes),
    row("版本", capability.version || "未标注", homes),
    row("职业", capability.profession || members[0]?.profession, homes),
    ...(team
      ? [row("成员", members.map((member) => `${member.displayName}${member.profession ? `（${member.profession}）` : ""}`).join("、"), homes)]
      : []),
    row("最大轮次", turns || "未设置", homes),
    row("依赖技能", (capability.skills || []).join("、"), homes),
    row("开场提示", capability.defaultPrompt, homes),
    row("快捷提示", (capability.quickPrompts || []).join("\n"), homes),
    row("标签", (capability.tags || []).join("、"), homes),
    row("来源", capability.originLabel, homes),
    row(
      "安装状态",
      capability.inUse
        ? `使用中${capability.installedVersion ? `（${capability.installedVersion}）` : ""}`
        : capability.installed
          ? "已安装，未在使用"
          : "仅在专家目录中",
      homes,
    ),
    row("分发包", capability.packaged ? `已打包（dist/${capability.name}.zip）` : "未打包", homes),
    row(
      "使用记录",
      capability.used
        ? `${capability.used.count} 次${capability.used.lastUsedAt ? `，最近 ${capability.used.lastUsedAt.slice(0, 10)}` : ""}`
        : "无记录",
      homes,
    ),
    row("位置", capability.sourcePath, homes),
  ];
}

/** Masked virtual JSON (e.g. the Hermes configuration summary). */
function maskedVirtualFile(filePath, content, homes) {
  let body;
  try {
    body = JSON.stringify(maskConfig(JSON.parse(content), { homes }), null, 2);
  } catch {
    body = MASK;
  }
  return fileEntry({ filePath, language: "json", body, structured: true }, homes);
}

async function expertDetail(id, context) {
  const capability = await context.getCapability(id);
  if (!capability) throw new DetailError(404, "没有找到这个专家或 Agent 配置。");
  const homes = context.displayHomes;
  if (capability.productId === "hermes") {
    const files = [];
    for (const filePath of capability.allowedFiles || []) {
      if (isSensitiveFileName(filePath)) continue;
      const read = await readDisplayFile(capability.rootPath, filePath, EXPERT_FILE_LIMIT);
      if (read) files.push(fileEntry({ filePath, language: languageOf(filePath), body: read.text, truncated: read.truncated }, homes));
    }
    for (const [filePath, content] of capability.virtualFiles || []) {
      files.push(maskedVirtualFile(filePath, content, homes));
    }
    return {
      title: cleanText(capability.displayName, homes),
      location: cleanText(capability.sourcePath, homes),
      rows: [
        row("类型", capability.kindLabel, homes),
        row("名称", capability.displayName, homes),
        row("技术名", capability.name, homes),
        row("模型", capability.model || "未设置", homes),
        row("最大轮次", capability.maxTurns || "未设置", homes),
        row("委派", capability.delegation?.enabled ? "已开启" : "未开启", homes),
        row("技能数", capability.skillCount, homes),
        row("位置", capability.sourcePath, homes),
      ],
      files,
    };
  }
  const files = [];
  const manifest = await maskedJsonFile(capability.rootPath, ".codebuddy-plugin/plugin.json", homes, {
    limit: EXPERT_FILE_LIMIT * 10,
  });
  if (manifest) files.push(manifest);
  const memberPaths = (capability.members || [])
    .map((member) => member.filePath)
    .filter((filePath, index, list) => list.indexOf(filePath) === index && !isSensitiveCapabilityPath(filePath));
  for (const filePath of memberPaths.slice(0, 20)) {
    const read = await readDisplayFile(capability.rootPath, filePath, EXPERT_FILE_LIMIT);
    if (read) {
      files.push(fileEntry({ filePath, language: languageOf(filePath), body: read.text, truncated: read.truncated }, homes));
    }
  }
  return {
    title: cleanText(capability.displayName, homes),
    location: cleanText(capability.sourcePath, homes),
    rows: expertRows(capability, homes),
    files,
  };
}

function findPlugin(payload, id) {
  const separator = id.indexOf(":");
  if (separator < 1) return null;
  const agentId = id.slice(0, separator);
  const pluginId = id.slice(separator + 1);
  const candidates = payload.plugins.filter(
    (plugin) => plugin.key === id || (plugin.agentId === agentId && plugin.id === pluginId),
  );
  return candidates.find((plugin) => plugin.scope === "user") || candidates[0] || null;
}

/**
 * A manifest-declared JSON file (apps, mcpServers, hooks): it must resolve inside the
 * plugin, must not be a sensitive file name and must be .json; it is parsed and masked.
 */
function declaredJsonPath(value, fallback) {
  const candidate = typeof value === "string" ? value : fallback;
  if (!candidate) return null;
  const normalized = candidate.replace(/^\.\//u, "");
  if (!normalized.toLowerCase().endsWith(".json")) return null;
  if (isSensitiveFileName(normalized, { allow: [".mcp.json"] })) return null;
  return candidate;
}

async function pluginDetail(id, context) {
  const { payload, roots } = await context.getIntegrations();
  const plugin = findPlugin(payload, id);
  const root = plugin ? roots.get(plugin.key) : null;
  if (!plugin || !root) throw new DetailError(404, "没有找到这个插件，或它尚未安装到本机。");
  const homes = context.displayHomes;
  const manifestPath = MANIFEST_FILES[plugin.agentId] || ".claude-plugin/plugin.json";
  const manifestFile = await resolveInside(root, manifestPath);
  const manifestRead = manifestFile
    ? manifestPath.endsWith(".yaml")
      ? await readYamlFile(manifestFile, MANIFEST_LIMIT)
      : await readBoundedJson(manifestFile, MANIFEST_LIMIT)
    : null;
  const manifest = manifestRead?.status === "ok" ? object(manifestRead.value) : null;
  const files = [];
  if (manifest) {
    // The whole manifest is masked: mcpServers, lspServers, hooks, userConfig, settings …
    const masked = maskConfig(manifest, { homes });
    const yamlManifest = manifestPath.endsWith(".yaml");
    files.push(
      fileEntry(
        {
          filePath: manifestPath,
          language: yamlManifest ? "yaml" : "json",
          body: yamlManifest ? dumpYaml(masked) : JSON.stringify(masked, null, 2),
          structured: true,
        },
        homes,
      ),
    );
  } else if (manifestRead) {
    files.push(fileEntry({ filePath: manifestPath, language: "json", body: "（清单过大或格式无效，未显示）" }, homes));
  }
  const declared = [
    declaredJsonPath(manifest?.mcpServers, ".mcp.json"),
    declaredJsonPath(manifest?.apps, ".app.json"),
    typeof manifest?.hooks === "string" ? declaredJsonPath(manifest.hooks, null) : null,
  ].filter((item, index, list) => item && list.indexOf(item) === index);
  for (const relativePath of declared) {
    const entry = await maskedJsonFile(root, relativePath, homes);
    if (entry) files.push(entry);
  }
  const components = plugin.components || {};
  const enabled = plugin.enabled === true ? "已启用" : plugin.enabled === false ? "已停用" : "未知";
  return {
    title: cleanText(`插件 · ${plugin.displayName}`, homes),
    location: cleanText(root, homes),
    rows: [
      row("名称", plugin.displayName, homes),
      row("技术名", plugin.id, homes),
      row("所属 Agent", AGENT_LABELS[plugin.agentId] || plugin.agentId, homes),
      row("版本", plugin.version || "未标注", homes),
      row("启用状态", enabled, homes),
      row("插件市场", plugin.marketplace, homes),
      row("作用域", `${plugin.scope}${plugin.projectPath ? `（${plugin.projectPath}）` : ""}`, homes),
      row("开发者", plugin.developerName, homes),
      row("分类", plugin.category, homes),
      row("技能", components.skills?.length ? `${components.skills.length} 个：${components.skills.slice(0, 20).join("、")}` : "无", homes),
      row("MCP 服务", (components.mcpServers || []).map((server) => server.name).join("、"), homes),
      row("应用连接器", (components.apps || []).map((app) => app.key).join("、"), homes),
      row("Hooks", components.hooks ? "有" : "无", homes),
      row("位置", root, homes),
    ],
    files,
  };
}

function frontmatterRows(source, homes) {
  const block = frontmatterBlock(source);
  const rows = [];
  for (const line of block.split("\n")) {
    if (rows.length >= 30) break;
    const match = line.match(/^([\p{L}\p{N}_-]{1,64}):(.*)$/u);
    if (!match) continue;
    const scalar = readYamlScalar(block, match[1]);
    const value = !scalar
      ? "（嵌套字段，见下方原文）"
      : isSecretKey(match[1])
        ? MASK
        : scalar.slice(0, 500);
    rows.push(row(match[1], value, homes));
  }
  return rows;
}

/** Product-specific facts about one installed copy (Hermes usage, OpenClaw requirements …). */
function productStateRows(instance, homes) {
  const rows = [];
  if (instance.readOnly) rows.push(row("可写", "否，由产品自己管理", homes));
  if (instance.disabled) rows.push(row("状态", "已在产品配置中停用", homes));
  if (instance.disabledOn?.length) rows.push(row("按平台停用", instance.disabledOn.join("、"), homes));
  if (instance.shadowed) rows.push(row("生效情况", `被同名技能覆盖（${instance.shadowedBy}）`, homes));
  if (instance.hiddenByProduct === "symlink-escape") {
    rows.push(row("生效情况", "软链接指向技能目录之外，产品本身会跳过它", homes));
  }
  if (instance.hiddenByProduct === "symlink-not-followed") {
    rows.push(row("生效情况", "这个产品不跟随软链接，这份副本不会被加载；需要时改为复制安装", homes));
  }
  if (instance.usage) {
    const usage = instance.usage;
    rows.push(
      row(
        "使用记录",
        `${usage.confidence === "inferred" && usage.windowDays ? `近 ${usage.windowDays} 天 ` : ""}${usage.count} 次${usage.lastUsedAt ? `，最近 ${String(usage.lastUsedAt).slice(0, 10)}` : ""}${usage.state ? `，状态 ${usage.state}` : ""}${usage.confidence === "inferred" ? "（根据会话推断）" : ""}`,
        homes,
      ),
    );
  }
  if (instance.remote) {
    rows.push(row("远程同步", [instance.remote.version && `版本 ${instance.remote.version}`, instance.remote.type, instance.remote.installMode, instance.remote.effectScope].filter(Boolean).join(" · "), homes));
  }
  const requirements = instance.requirements;
  if (requirements) {
    const parts = [
      requirements.bins?.length && `命令 ${requirements.bins.join("、")}`,
      requirements.anyBins?.length && `任一命令 ${requirements.anyBins.join("、")}`,
      requirements.env?.length && `环境变量 ${requirements.env.join("、")}`,
      requirements.config?.length && `配置 ${requirements.config.join("、")}`,
      requirements.os?.length && `系统 ${requirements.os.join("、")}`,
      requirements.install?.length && `安装方式 ${requirements.install.join("、")}`,
    ].filter(Boolean);
    if (parts.length) rows.push(row("依赖", parts.join("；"), homes));
  }
  return rows;
}

async function skillDetail(skillId, instanceId, context) {
  const found = await context.findSkillInstance(skillId, instanceId);
  if (!found) throw new DetailError(404, "没有找到这个技能安装，请重新扫描后再试。");
  const homes = context.displayHomes;
  const read = await readDisplayFile(found.absolutePath, "SKILL.md", FILE_LIMIT);
  if (!read) throw new DetailError(404, "SKILL.md 已不存在或无法安全读取。");
  const { instance, skill } = found;
  return {
    title: cleanText(skill.displayName || skill.name, homes),
    location: cleanText(instance.path, homes),
    rows: [
      ...frontmatterRows(read.text, homes),
      row("所属 Agent", instance.agentName || instance.agentId, homes),
      row("来源", [instance.sourceLabel, instance.source || "local"].filter(Boolean).join(" · "), homes),
      ...productStateRows(instance, homes),
      row("内容指纹", instance.shortHash, homes),
      row("位置", instance.path, homes),
    ],
    files: [fileEntry({ filePath: "SKILL.md", language: "md", body: read.text, truncated: read.truncated }, homes)],
  };
}

export async function buildConfigDetail({ kind, id, instance }, context) {
  const value = typeof id === "string" ? id.slice(0, 512) : "";
  if (!DETAIL_KINDS.has(kind) || !value) throw new DetailError(400, "请求的配置类型或标识无效。");
  if (kind === "agent") {
    if (!AGENT_DETAIL_IDS.includes(value)) throw new DetailError(404, "暂不支持查看这个 Agent 的配置。");
    const detail = await agentSettingsDetail(value, context.homeDirectory, context.displayHomes);
    return {
      ...detail,
      title: cleanText(detail.title, context.displayHomes),
      location: detail.location ? cleanText(detail.location, context.displayHomes) : null,
      files: [],
    };
  }
  if (kind === "mcp") return mcpDetail(value, context);
  if (kind === "expert") return expertDetail(value, context);
  if (kind === "plugin") return pluginDetail(value, context);
  return skillDetail(value, String(instance || ""), context);
}
