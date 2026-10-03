import assert from "node:assert/strict";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { scanMcpInventory } from "../server/mcp-inventory.mjs";
import {
  SECRET_PATTERN,
  createCodexPluginFixture,
  createMcpFixture,
} from "./fixtures/integrations.mjs";

async function tempHome(context) {
  const home = await mkdtemp(path.join(tmpdir(), "mcp-inventory-test-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

const find = (servers, agentId, name) =>
  servers.find((server) => server.agentId === agentId && server.name === name);

test("lists MCP servers per agent with transport, host and secret field names only", async (context) => {
  const home = await tempHome(context);
  await createCodexPluginFixture(home);
  await createMcpFixture(home);
  const result = await scanMcpInventory(home);
  const { servers } = result;

  const docs = find(servers, "codex", "docs");
  assert.equal(docs.transport, "http");
  assert.equal(docs.host, "docs.example.test");
  assert.deepEqual(docs.secretFields, ["url.query.token"]);
  const localTool = find(servers, "codex", "local-tool");
  assert.equal(localTool.transport, "stdio");
  assert.equal(localTool.host, null);
  assert.equal(localTool.enabled, false);
  assert.deepEqual(localTool.secretFields.sort(), ["args[0]", "env.API_TOKEN", "env.PLAIN"]);
  assert.deepEqual(localTool.likelySecretFields.sort(), ["args[0]", "env.API_TOKEN"]);
  const remote = find(servers, "codex", "remote");
  assert.deepEqual(remote.secretFields.sort(), [
    "bearer_token",
    "http_headers.Authorization",
    "http_headers.X-Trace",
  ]);
  assert.equal(remote.enabled, null);

  const api = find(servers, "claude", "api");
  assert.equal(api.scope, "user");
  assert.equal(api.transport, "http");
  assert.equal(api.host, "api.example.test");
  assert.deepEqual(api.secretFields.sort(), [
    "headers.Accept",
    "headers.X-API-Key",
    "url.query.api_key",
  ]);
  const project = find(servers, "claude", "proj-db");
  assert.equal(project.scope, "project");
  assert.match(project.projectPath, /Projects[\\/]demo$/);
  assert.deepEqual(project.secretFields.sort(), ["env.DB_HOST", "env.DB_PASSWORD"]);
  assert.equal(find(servers, "cursor", "railway").transport, "stdio");
  const pencil = find(servers, "gemini", "pencil");
  assert.deepEqual(pencil.secretFields, []);
  const gemRemote = find(servers, "gemini", "remote");
  assert.equal(gemRemote.transport, "http");
  assert.deepEqual(gemRemote.secretFields, []);
  const legacy = find(servers, "gemini", "legacy");
  assert.equal(legacy.transport, "sse");
  assert.deepEqual(legacy.secretFields, ["headers.Cookie"]);

  const railway = result.matrix.find((row) => row.name === "railway");
  assert.deepEqual(railway.agentIds, ["claude", "cursor"]);
  assert.equal(result.matrix[0].agentIds.length >= railway.agentIds.length, true);

  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, SECRET_PATTERN);
  assert.doesNotMatch(serialized, /https?:\/\//);
  assert.doesNotMatch(serialized, /npx|pencil-token|\$\{API_KEY\}/i);
});

test("tolerates missing, malformed and oversized MCP configuration files", async (context) => {
  const home = await tempHome(context);
  const empty = await scanMcpInventory(home);
  assert.deepEqual(empty.servers, []);
  assert.deepEqual(empty.matrix, []);

  await createMcpFixture(home);
  await writeFile(path.join(home, ".cursor", "mcp.json"), "{ secret-broken");
  await writeFile(path.join(home, ".claude.json"), "");
  await truncate(path.join(home, ".claude.json"), 30_000_001);
  const result = await scanMcpInventory(home);
  assert.equal(result.servers.some((server) => server.agentId === "cursor"), false);
  assert.equal(result.servers.some((server) => server.agentId === "claude"), false);
  assert.equal(result.servers.some((server) => server.agentId === "gemini"), true);
  assert.ok(result.warnings.length >= 2);
  assert.doesNotMatch(JSON.stringify(result), SECRET_PATTERN);
});
