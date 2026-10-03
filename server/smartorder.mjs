import { createHash } from "node:crypto";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse } from "smol-toml";

const CONFIG_LIMIT = 256_000;
const ENTRY_LIMIT = 200;
const safeSegment = (value) => typeof value === "string" &&
  /^[\p{L}\p{N}_-][\p{L}\p{N}_.-]{0,127}$/u.test(value) && !value.includes("..");
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const text = (value, limit = 160) => typeof value === "string"
  ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, limit) : "";
const localizedText = (value) => text(value) || text(object(value)["zh-CN"]) || text(object(value).zh) || text(object(value).en);
const identifier = (value) => typeof value === "string" && /^[\p{L}\p{N}_.:@/-]{1,160}$/u.test(value)
  ? value : "";
const names = (value) => Array.isArray(value)
  ? value.slice(0, ENTRY_LIMIT).map(identifier).filter(Boolean) : [];
const idFor = (value) => createHash("sha256").update(value).digest("hex").slice(0, 20);

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function boundedPath(root, candidate) {
  if (!within(root, candidate)) throw new Error("outside root");
  const resolved = await realpath(candidate);
  if (!within(await realpath(root), resolved)) throw new Error("outside root");
  return resolved;
}

async function readBounded(root, candidate) {
  const handle = await open(await boundedPath(root, candidate), "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > CONFIG_LIMIT) throw new Error("invalid size/type");
    const buffer = Buffer.alloc(CONFIG_LIMIT + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > CONFIG_LIMIT) throw new Error("invalid size");
    return buffer.toString("utf8", 0, offset);
  } finally {
    await handle.close();
  }
}

async function directories(root, candidate) {
  try {
    const entries = await readdir(await boundedPath(root, candidate), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && safeSegment(entry.name))
      .slice(0, ENTRY_LIMIT).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function endpointOrigin(value) {
  try {
    const url = new URL(value);
    // Paths, credentials, query strings and fragments can all contain secrets.
    return ["https:", "http:"].includes(url.protocol) ? url.origin : "";
  } catch {
    return "";
  }
}

function summarizeConnector(name, raw, source) {
  const config = object(raw);
  const endpoint = endpointOrigin(config.url);
  return {
    id: idFor(`${source}:${name}`),
    productId: "smartorder",
    productName: "订单来了",
    name: identifier(name) || "未命名连接器",
    enabled: config.enabled !== false,
    transport: endpoint ? "HTTP" : typeof config.command === "string" ? "stdio" : "未知",
    endpoint,
    source,
    toolsRestricted: Array.isArray(config.enabled_tools),
    enabledTools: names(config.enabled_tools),
    disabledTools: names(config.disabled_tools),
    approvalMode: ["auto", "prompt", "approve", "deny"].includes(config.default_tools_approval_mode)
      ? config.default_tools_approval_mode : "",
    timeoutSeconds: typeof config.tool_timeout_sec === "number" && Number.isFinite(config.tool_timeout_sec)
      ? config.tool_timeout_sec : null,
    hasCredentials: Boolean(config.bearer_token || config.bearer_token_env_var ||
      Object.keys(object(config.http_headers)).length || Object.keys(object(config.env_http_headers)).length ||
      Object.keys(object(config.env)).length),
  };
}

/** Local metadata only. Never returns the parsed configuration, command, args or credentials. */
export async function scanSmartOrder(homeDirectory = homedir()) {
  const root = path.join(homeDirectory, ".smartorder");
  const result = {
    available: false, productId: "smartorder", productName: "订单来了",
    connectors: [], plugins: [], skillSources: [], disabledSkillPaths: [], warnings: [],
  };
  try {
    result.available = (await stat(root)).isDirectory();
  } catch {
    return result;
  }
  let config = {};
  try {
    config = parse(await readBounded(root, path.join(root, "config.toml")));
  } catch (error) {
    if (error.code !== "ENOENT") result.warnings.push("无法安全解析订单来了配置；连接器与插件技能暂未读取。");
  }
  const skillConfig = object(config.skills).config;
  for (const entry of Array.isArray(skillConfig) ? skillConfig.slice(0, ENTRY_LIMIT) : []) {
    if (entry?.enabled !== false || typeof entry.path !== "string") continue;
    const candidate = entry.path.startsWith("~/") || entry.path.startsWith("~\\")
      ? path.join(homeDirectory, entry.path.slice(2)) : path.resolve(root, entry.path);
    if (within(root, candidate)) result.disabledSkillPaths.push(candidate);
  }
  for (const [name, raw] of Object.entries(object(config.mcp_servers)).slice(0, ENTRY_LIMIT)) {
    result.connectors.push(summarizeConnector(name, raw, "config.toml"));
  }
  const pluginEntries = Object.entries(object(config.plugins));
  if (pluginEntries.length > ENTRY_LIMIT) result.warnings.push("插件配置过多，仅读取前 200 项。");
  for (const [key, raw] of pluginEntries.slice(0, ENTRY_LIMIT)) {
    const separator = key.lastIndexOf("@");
    const name = key.slice(0, separator);
    const marketplace = key.slice(separator + 1);
    if (separator < 1 || !safeSegment(name) || !safeSegment(marketplace)) continue;
    const settings = object(raw);
    const pluginPath = path.join(root, "plugins", "cache", marketplace, name);
    const versions = await directories(root, pluginPath);
    const version = typeof settings.version === "string" && versions.includes(settings.version)
      ? settings.version : versions.length === 1 ? versions[0] : null;
    if (settings.enabled !== true || !version) {
      result.plugins.push({ name, marketplace, version: version || "", enabled: settings.enabled === true,
        status: settings.enabled !== true ? "disabled" : versions.length ? "ambiguous" : "missing" });
      if (settings.enabled === true) result.warnings.push(`${name} 的本地版本${versions.length ? "无法确定" : "尚未找到"}，未将市场缓存计入已安装技能。`);
      continue;
    }
    const versionRoot = path.join(pluginPath, version);
    try {
      const manifest = JSON.parse(await readBounded(root, path.join(versionRoot, ".codex-plugin", "plugin.json")));
      const info = object(manifest.interface);
      result.plugins.push({ name, marketplace, version, enabled: true, status: "available",
        displayName: localizedText(info.displayName) || name });
      const relativeSources = Array.isArray(manifest.skills) ? manifest.skills : [manifest.skills || "./skills"];
      for (const relative of relativeSources.slice(0, 16)) {
        if (typeof relative !== "string" || relative.includes("\0") || path.win32.isAbsolute(relative)) continue;
        const candidate = path.resolve(versionRoot, relative);
        if (!within(versionRoot, candidate)) continue;
        try {
          await boundedPath(versionRoot, candidate);
          if (!(await stat(candidate)).isDirectory()) continue;
          if (result.skillSources.length < ENTRY_LIMIT) result.skillSources.push({ path: candidate, label: `插件 · ${localizedText(info.displayName) || name}`, readOnly: true });
        } catch { /* Missing optional skill directories are not installed skills. */ }
      }
      // Plugin MCP manifests are configuration, not proof of authentication/connectivity.
      try {
        const mcp = JSON.parse(await readBounded(versionRoot, path.join(versionRoot, ".mcp.json")));
        for (const [connectorName, connector] of Object.entries(object(mcp.mcpServers)).slice(0, ENTRY_LIMIT)) {
          if (result.connectors.length < ENTRY_LIMIT) result.connectors.push(summarizeConnector(connectorName, connector, `插件 · ${name}`));
        }
      } catch { /* Optional MCP manifest; never surface raw parser errors. */ }
    } catch {
      result.warnings.push(`${name} 的插件清单无法安全读取。`);
    }
  }
  return result;
}

export async function scanSmartOrderConnectors(homeDirectory = homedir()) {
  const { available, productId, productName, connectors, plugins, warnings } = await scanSmartOrder(homeDirectory);
  return { available, productId, productName, connectors, plugins, warnings, scannedAt: new Date().toISOString() };
}
