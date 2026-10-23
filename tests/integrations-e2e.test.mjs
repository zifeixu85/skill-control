import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PIXEL_PNG,
  SAFE_SVG,
  SECRET_PATTERN,
  createClaudePluginFixture,
  createCodexPluginFixture,
  createMcpFixture,
  writeSessionFile,
} from "./fixtures/integrations.mjs";
import { startTestServer } from "./fixtures/server.mjs";
import { createSmartOrderFixture, writeFixtureFile } from "./fixtures/smartorder.mjs";

function rawStatus(port, pathname, host) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path: pathname, method: "GET", headers: { Host: host } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.once("error", reject);
    request.end();
  });
}

test("serves plugins, connectors, MCP inventory, activity and primary config over the local API", async (context) => {
  const home = await mkdtemp(path.join(tmpdir(), "integrations-e2e-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await createCodexPluginFixture(home);
  await createClaudePluginFixture(home);
  await createMcpFixture(home);
  await createSmartOrderFixture(home);
  await writeFixtureFile(home, ".codex/skills/demo/SKILL.md", "---\nname: demo\ndescription: demo\n---\n# demo\n");
  for (const name of ["x", "y", "z"]) {
    await writeSessionFile(home, `.codex/sessions/2026/10/01/rollout-${name}.jsonl`, 2_000, new Date());
  }
  const { request, requestJson, port } = await startTestServer(context, home);

  const integrations = await requestJson("/api/integrations");
  assert.ok(integrations.plugins.some((plugin) => plugin.id === "github@openai-curated" && plugin.agentId === "codex"));
  assert.ok(integrations.plugins.some((plugin) => plugin.id === "warp@claude-code-warp" && plugin.agentId === "claude"));
  assert.ok(integrations.connectors.some((connector) => connector.id === "connector_github123"));
  assert.ok(integrations.mcpServers.some((server) => server.agentId === "gemini"));
  assert.ok(Array.isArray(integrations.mcpMatrix));
  assert.equal("assets" in integrations, false);
  assert.doesNotMatch(JSON.stringify(integrations), SECRET_PATTERN);

  const plugins = await requestJson("/api/plugins");
  assert.equal(plugins.plugins.length, integrations.plugins.length);
  const mcp = await requestJson("/api/mcp");
  assert.equal(mcp.servers.length, integrations.mcpServers.length);

  const github = integrations.plugins.find((plugin) => plugin.id === "github@openai-curated");
  // v0.2 §3/§5: folder times for sorting; connector providers, icon, auth basis and tools.
  assert.ok(Date.parse(github.installedAt) && Date.parse(github.updatedAt));
  assert.ok(integrations.mcpServers.every((server) => server.updatedAt === null || Date.parse(server.updatedAt)));
  assert.ok(integrations.mcpServers.some((server) => Date.parse(server.updatedAt)));
  const connector = integrations.connectors.find((item) => item.id === "connector_github123");
  assert.deepEqual(connector.providers.map((provider) => provider.id).sort(), ["github@openai-curated", "github@openai-curated-remote"]);
  assert.equal(connector.iconAssetId, github.logo);
  assert.equal(connector.auth.status, "connected");
  assert.deepEqual(connector.tools.map((tool) => [tool.name, tool.description, tool.readOnly]), [["List pull requests", "desc", false], ["Get issue", "desc", false], ["search", "desc", false]]);
  const logo = await request(`/api/plugin-asset?id=${github.logo}`);
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get("content-type"), "image/png");
  assert.match(logo.headers.get("content-security-policy"), /default-src 'none'/);
  assert.deepEqual(Buffer.from(await logo.arrayBuffer()), PIXEL_PNG);
  const icon = await request(`/api/plugin-asset?id=${github.composerIcon}`);
  assert.equal(icon.headers.get("content-type"), "image/svg+xml");
  assert.equal(await icon.text(), SAFE_SVG);
  // Plugin SVGs are only consumed through <img>; the response still forbids script.
  assert.equal(icon.headers.get("x-content-type-options"), "nosniff");
  assert.match(icon.headers.get("content-security-policy"), /sandbox/);
  for (const rejected of ["", "0".repeat(24), "../../etc/passwd"]) {
    const response = await request(`/api/plugin-asset?id=${encodeURIComponent(rejected)}`);
    assert.equal(response.status, 404);
  }

  const connectors = await requestJson("/api/connectors");
  assert.equal(connectors.productId, "smartorder");
  assert.equal(connectors.connectors.length, 3);
  assert.equal(connectors.codex.available, true);
  assert.ok(connectors.codex.connectors.some((connector) => connector.id === "connector_github123"));
  assert.doesNotMatch(JSON.stringify(connectors), SECRET_PATTERN);

  const activity = await requestJson("/api/agents/activity");
  assert.equal(activity.agents.find((agent) => agent.agentId === "codex").files30d, 3);
  assert.deepEqual(activity.suggestedPrimaryAgentIds, ["codex"]);

  const config = await requestJson("/api/config");
  assert.equal(config.primaryAgentIds, null);
  const saved = await requestJson("/api/config", {
    method: "PUT",
    body: JSON.stringify({ ...config, primaryAgentIds: ["codex", "not-configured"] }),
  });
  assert.deepEqual(saved.primaryAgentIds, ["codex"]);
  const invalid = await request("/api/config", {
    method: "PUT",
    body: JSON.stringify({ ...config, primaryAgentIds: "codex" }),
  });
  assert.equal(invalid.status, 400);

  for (const [host, status] of [
    ["evil.example", 403],
    [`evil.example:${port}`, 403],
    ["127.0.0.1:1", 403],
    [`localhost:${port}`, 200],
    [`[::1]:${port}`, 200],
    [`127.0.0.1:${port}`, 200],
  ]) {
    assert.equal(await rawStatus(port, "/api/mcp", host), status, host);
  }

  const scan = await requestJson("/api/scan?force=1");
  assert.deepEqual(scan.primaryAgentIds, ["codex"]);
  assert.deepEqual(scan.suggestedPrimaryAgentIds, ["codex"]);
  assert.equal(typeof scan.summary.total, "number");
  assert.ok(Array.isArray(scan.sharedRoots));
  assert.ok(scan.skills.find((skill) => skill.name === "demo").inPrimary);
});
