import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { scanClaudePlugins } from "../server/claude-plugins.mjs";
import {
  SECRET_PATTERN,
  createClaudePluginFixture,
} from "./fixtures/integrations.mjs";

async function tempHome(context) {
  const home = await mkdtemp(path.join(tmpdir(), "claude-plugins-test-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test("reads Claude Code plugins, scopes, enabled state and components", async (context) => {
  const home = await tempHome(context);
  await createClaudePluginFixture(home);
  const result = await scanClaudePlugins(home);
  assert.equal(result.available, true);

  const warp = result.plugins.find((plugin) => plugin.id === "warp@claude-code-warp");
  assert.equal(warp.agentId, "claude");
  assert.equal(warp.enabled, true);
  assert.equal(warp.scope, "user");
  assert.equal(warp.version, "2.2.0");
  assert.equal(warp.displayName, "warp");
  assert.equal(warp.shortDescription, "Warp fixture");
  assert.equal(warp.developerName, "Warp");
  assert.deepEqual(warp.components.skills, ["warp-skill"]);
  assert.deepEqual(warp.components.agents, ["reviewer"]);
  assert.deepEqual(warp.components.commands, ["alpha", "group:beta"]);
  assert.deepEqual(warp.components.mcpServers, [{ name: "warpmcp", transport: "stdio" }]);
  assert.equal(warp.components.hooks, true);

  const designs = result.plugins.filter((plugin) => plugin.id === "frontend-design@official");
  assert.equal(designs.length, 2);
  const local = designs.find((plugin) => plugin.scope === "local");
  assert.equal(local.enabled, "unknown");
  assert.match(local.projectPath, /^~\/Projects\/demo$|Projects[\\/]demo$/);
  assert.notEqual(local.key, designs.find((plugin) => plugin.scope === "user").key);
  assert.deepEqual(local.components.skills, ["frontend-design"]);

  const disabled = result.plugins.find((plugin) => plugin.id === "disabled-one@official");
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.manifestStatus, "invalid");

  assert.equal(result.plugins.some((plugin) => plugin.id.endsWith("@evil")), false);
  assert.ok(result.warnings.length >= 1);
  assert.deepEqual(
    result.marketplaces.map((item) => [item.name, item.sourceType]).sort(),
    [["claude-code-warp", "github"], ["official", "git"]],
  );
  assert.doesNotMatch(JSON.stringify(result), SECRET_PATTERN);
});

test("fails soft on missing or malformed Claude plugin metadata", async (context) => {
  const home = await tempHome(context);
  const missing = await scanClaudePlugins(home);
  assert.equal(missing.available, false);
  assert.deepEqual(missing.plugins, []);

  const { plugins, claude } = await createClaudePluginFixture(home);
  await writeFile(path.join(plugins, "installed_plugins.json"), "{ secret-broken");
  await writeFile(path.join(claude, "settings.json"), "{ secret-broken");
  const malformed = await scanClaudePlugins(home);
  assert.deepEqual(malformed.plugins, []);
  assert.ok(malformed.warnings.length >= 1);
  assert.doesNotMatch(JSON.stringify(malformed), SECRET_PATTERN);
});
