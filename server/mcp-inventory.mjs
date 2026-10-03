import { createHash } from "node:crypto";
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

function summarizeServer({ name, config, agentId, scope, projectPath = null, source }) {
  const value = object(config);
  // Gemini CLI uses `url` for SSE and `httpUrl` for streamable HTTP.
  const transport =
    agentId === "gemini" && !value.type && !value.httpUrl && typeof value.url === "string"
      ? "sse"
      : mcpTransport(value);
  const url = [value.httpUrl, value.url, value.serverUrl].find((item) => typeof item === "string");
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

function serversFrom(map, context) {
  return Object.entries(object(map))
    .slice(0, SERVER_LIMIT)
    .filter(([name]) => identifier(name))
    .map(([name, config]) => summarizeServer({ name: identifier(name), config, ...context }));
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
  return serversFrom(object(result.value).mcp_servers, {
    agentId: "codex",
    scope: "user",
    source: "~/.codex/config.toml",
  });
}

async function readClaude(homeDirectory, homes, warnings) {
  const result = await readBoundedJson(path.join(homeDirectory, ".claude.json"), CLAUDE_STATE_LIMIT);
  if (result.status !== "ok") {
    if (result.status !== "missing") warnings.push(readStatusMessage("~/.claude.json", result.status));
    return [];
  }
  const state = object(result.value);
  const servers = serversFrom(state.mcpServers, {
    agentId: "claude",
    scope: "user",
    source: "~/.claude.json",
  });
  for (const [projectPath, project] of Object.entries(object(state.projects)).slice(0, PROJECT_LIMIT)) {
    if (!path.isAbsolute(projectPath)) continue;
    servers.push(
      ...serversFrom(object(project).mcpServers, {
        agentId: "claude",
        scope: "project",
        projectPath: compactHomePath(projectPath, homes),
        source: "~/.claude.json",
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
  return serversFrom(object(result.value).mcpServers, {
    agentId,
    scope: "user",
    source: `~/${relative.split(path.sep).join("/")}`,
  });
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

export async function scanMcpInventory(homeDirectory = homedir()) {
  const homes = await homeVariants(homeDirectory);
  const warnings = [];
  const groups = await Promise.all([
    readCodex(homeDirectory, warnings),
    readClaude(homeDirectory, homes, warnings),
    readJsonServers(homeDirectory, path.join(".cursor", "mcp.json"), "cursor", "Cursor mcp.json", warnings),
    readJsonServers(homeDirectory, path.join(".gemini", "settings.json"), "gemini", "Gemini settings.json", warnings),
  ]);
  const servers = groups.flat();
  return {
    servers,
    matrix: buildMcpMatrix(servers),
    warnings,
    scannedAt: new Date().toISOString(),
  };
}
