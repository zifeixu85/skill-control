import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  compactHomePath,
  homeVariants,
  hostnameOf,
  identifier,
  mcpTransport,
  object,
  readBoundedJson,
  readBoundedToml,
  readStatusMessage,
} from "./fs-safe.mjs";
import { secretFieldReport } from "./secret-fields.mjs";
import { hermesMcpEntries } from "./hermes.mjs";
import { openClawMcpEntries } from "./openclaw.mjs";

export { secretFieldNames } from "./secret-fields.mjs";

/**
 * Read-only MCP server inventory across agents. Only names, transport, hostname, enabled
 * flags and the NAMES of fields that carry literal secrets are returned — never values,
 * commands, arguments or full URLs. Configuration files are read once and never written.
 */

const CODEX_CONFIG_LIMIT = 2_000_000;
const CLAUDE_STATE_LIMIT = 30_000_000;
const SMALL_CONFIG_LIMIT = 2_000_000;
const SERVER_LIMIT = 300;
const PROJECT_LIMIT = 500;

/** Gemini CLI uses `url` for SSE and `httpUrl` for streamable HTTP. */
export function serverTransport(agentId, value) {
  return agentId === "gemini" && !value.type && !value.httpUrl && typeof value.url === "string"
    ? "sse"
    : mcpTransport(value);
}

export function serverUrl(value) {
  return [value.httpUrl, value.url, value.serverUrl].find((item) => typeof item === "string");
}

function summarizeServer({ name, config, agentId, scope, projectPath = null, source }) {
  const value = object(config);
  const transport = serverTransport(agentId, value);
  const url = serverUrl(value);
  const secrets = secretFieldReport(value);
  return {
    id: createHash("sha256")
      .update(`${agentId}:${scope}:${projectPath || ""}:${name}`)
      .digest("hex")
      .slice(0, 16),
    name,
    agentId,
    scope,
    projectPath,
    transport,
    host: transport === "stdio" ? null : hostnameOf(url),
    enabled:
      typeof value.enabled === "boolean"
        ? value.enabled
        : typeof value.disabled === "boolean"
          ? !value.disabled
          : null,
    secretFields: secrets.all,
    likelySecretFields: secrets.likely,
    source,
  };
}

/** Raw entries stay server-side: { name, config, agentId, scope, projectPath, source, format }. */
function rawEntries(map, context) {
  return Object.entries(object(map))
    .slice(0, SERVER_LIMIT)
    .filter(([name]) => identifier(name))
    .map(([name, config]) => ({ name: identifier(name), config: object(config), ...context }));
}

async function readCodex(homeDirectory, warnings) {
  const result = await readBoundedToml(
    path.join(homeDirectory, ".codex", "config.toml"),
    CODEX_CONFIG_LIMIT,
  );
  if (result.status !== "ok") {
    if (result.status !== "missing") warnings.push(readStatusMessage("Codex config.toml", result.status));
    return [];
  }
  return rawEntries(object(result.value).mcp_servers, {
    agentId: "codex",
    scope: "user",
    projectPath: null,
    source: "~/.codex/config.toml",
    format: "toml",
  });
}

async function readClaude(homeDirectory, homes, warnings) {
  const result = await readBoundedJson(path.join(homeDirectory, ".claude.json"), CLAUDE_STATE_LIMIT);
  if (result.status !== "ok") {
    if (result.status !== "missing") warnings.push(readStatusMessage("~/.claude.json", result.status));
    return [];
  }
  const state = object(result.value);
  const servers = rawEntries(state.mcpServers, {
    agentId: "claude",
    scope: "user",
    projectPath: null,
    source: "~/.claude.json",
    format: "json",
  });
  for (const [projectPath, project] of Object.entries(object(state.projects)).slice(0, PROJECT_LIMIT)) {
    if (!path.isAbsolute(projectPath)) continue;
    servers.push(
      ...rawEntries(object(project).mcpServers, {
        agentId: "claude",
        scope: "project",
        projectPath: compactHomePath(projectPath, homes),
        source: "~/.claude.json",
        format: "json",
      }),
    );
  }
  return servers;
}

async function readJsonServers(homeDirectory, relative, agentId, label, warnings) {
  const result = await readBoundedJson(path.join(homeDirectory, relative), SMALL_CONFIG_LIMIT);
  if (result.status !== "ok") {
    if (result.status !== "missing") warnings.push(readStatusMessage(label, result.status));
    return [];
  }
  return rawEntries(object(result.value).mcpServers, {
    agentId,
    scope: "user",
    projectPath: null,
    source: `~/${relative.split(path.sep).join("/")}`,
    format: "json",
  });
}

/**
 * Raw MCP definitions from every supported agent. Values are NOT safe to return; callers
 * must summarize (scanMcpInventory) or mask (config-mask.mjs) before anything leaves.
 */
export async function readMcpSources(homeDirectory = homedir()) {
  const homes = await homeVariants(homeDirectory);
  const warnings = [];
  const fromAdapter = async (reader) => {
    const result = await reader().catch(() => ({ entries: [], warnings: ["MCP 配置读取失败，已跳过。"] }));
    warnings.push(...result.warnings);
    return result.entries;
  };
  const groups = await Promise.all([
    readCodex(homeDirectory, warnings),
    readClaude(homeDirectory, homes, warnings),
    readJsonServers(homeDirectory, path.join(".cursor", "mcp.json"), "cursor", "Cursor mcp.json", warnings),
    readJsonServers(homeDirectory, path.join(".gemini", "settings.json"), "gemini", "Gemini settings.json", warnings),
    fromAdapter(() => hermesMcpEntries(homeDirectory)),
    fromAdapter(() => openClawMcpEntries("openclaw", homeDirectory)),
    fromAdapter(() => openClawMcpEntries("qclaw", homeDirectory)),
  ]);
  return { entries: groups.flat(), warnings: [...new Set(warnings)] };
}

export function buildMcpMatrix(servers) {
  const rows = new Map();
  for (const server of servers) {
    const row = rows.get(server.name) || { name: server.name, agentIds: [], entries: [] };
    if (!row.agentIds.includes(server.agentId)) row.agentIds.push(server.agentId);
    row.entries.push({
      agentId: server.agentId,
      scope: server.scope,
      projectPath: server.projectPath,
      transport: server.transport,
      enabled: server.enabled,
    });
    rows.set(server.name, row);
  }
  return [...rows.values()]
    .map((row) => ({ ...row, agentIds: row.agentIds.sort() }))
    .sort((left, right) => right.agentIds.length - left.agentIds.length || left.name.localeCompare(right.name));
}

/** Modification time of each configuration file (for sorting MCP servers by "recently changed"). */
async function sourceTimes(entries, homeDirectory) {
  const times = new Map();
  for (const source of new Set(entries.map((entry) => entry.source).filter((value) => typeof value === "string"))) {
    const file = source.startsWith("~/") ? path.join(homeDirectory, source.slice(2)) : source;
    const info = path.isAbsolute(file) ? await stat(file).catch(() => null) : null;
    times.set(source, info ? new Date(info.mtimeMs).toISOString() : null);
  }
  return times;
}

export async function scanMcpInventory(homeDirectory = homedir()) {
  const { entries, warnings } = await readMcpSources(homeDirectory);
  const times = await sourceTimes(entries, homeDirectory);
  const servers = entries.map((entry) => ({ ...summarizeServer(entry), updatedAt: times.get(entry.source) || null }));
  return {
    servers,
    matrix: buildMcpMatrix(servers),
    warnings,
    scannedAt: new Date().toISOString(),
  };
}
