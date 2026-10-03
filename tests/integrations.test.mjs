import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { scanClaudePlugins } from "../server/installed-plugins.mjs";
import { scanCodexConnectors, scanCodexPlugins } from "../server/codex-plugins.mjs";
import { scanIntegrations } from "../server/integrations.mjs";
import { createCodexPluginFixture } from "./fixtures/integrations.mjs";

test("isolates a failing scanner and keeps the other sections", async (context) => {
  const home = await mkdtemp(path.join(tmpdir(), "integrations-test-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await createCodexPluginFixture(home);
  const result = await scanIntegrations(home, {
    scanCodexPlugins,
    scanClaudePlugins,
    scanCodexConnectors,
    scanMcpInventory: async () => {
      throw new Error(`EACCES: permission denied, open '${home}/.claude.json'`);
    },
  });
  assert.ok(result.payload.plugins.length > 0);
  assert.ok(result.payload.connectors.length > 0);
  assert.deepEqual(result.payload.mcpServers, []);
  assert.ok(result.payload.warnings.includes("MCP 配置读取失败，已跳过。"));
  assert.doesNotMatch(JSON.stringify(result.payload), /EACCES|permission denied/);

  const connectorsDown = await scanIntegrations(home, {
    scanCodexPlugins,
    scanClaudePlugins,
    scanMcpInventory: async () => ({ servers: [], matrix: [], warnings: [] }),
    scanCodexConnectors: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(connectorsDown.codexConnectors.available, false);
  assert.deepEqual(connectorsDown.codexConnectors.connectors, []);
  assert.ok(connectorsDown.payload.plugins.length > 0);
});
