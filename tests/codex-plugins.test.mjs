import assert from "node:assert/strict";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  scanCodexConnectors,
  scanCodexPlugins,
} from "../server/codex-plugins.mjs";
import {
  SECRET_PATTERN,
  createCodexPluginFixture,
} from "./fixtures/integrations.mjs";

async function tempHome(context) {
  const home = await mkdtemp(path.join(tmpdir(), "codex-plugins-test-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

const publicJson = (value) =>
  JSON.stringify(value, (key, item) => (item instanceof Map ? undefined : item));

test("reads Codex plugins with enabled true, false and unknown without trusting cache presence", async (context) => {
  const home = await tempHome(context);
  await createCodexPluginFixture(home);
  const result = await scanCodexPlugins(home);
  const byId = Object.fromEntries(result.plugins.map((plugin) => [plugin.id, plugin]));

  assert.equal(result.available, true);
  assert.equal(byId["github@openai-curated"].enabled, true);
  assert.equal(byId["gmail@openai-curated"].enabled, false);
  assert.equal(byId["github@openai-curated-remote"].enabled, "unknown");
  assert.equal(byId["github@openai-curated-remote"].configured, false);
  assert.equal(byId["ghost@openai-curated"].enabled, true);
  assert.equal(byId["ghost@openai-curated"].installed, false);

  const github = byId["github@openai-curated"];
  assert.equal(github.agentId, "codex");
  assert.equal(github.displayName, "GitHub");
  assert.equal(github.shortDescription, "Triage PRs");
  assert.equal(github.category, "Developer Tools");
  assert.equal(github.developerName, "Fixture Inc");
  assert.equal(github.brandColor, "#24292F");
  assert.equal(github.version, "bd2122cb");
  assert.equal(github.marketplace, "openai-curated");
  assert.deepEqual(github.components.skills, ["gh-ci", "gh-review"]);
  assert.deepEqual(github.components.mcpServers, [{ name: "github", transport: "http" }]);
  assert.deepEqual(github.components.apps, [{ key: "github", connectorId: "connector_github123" }]);
  assert.equal(github.components.hooks, false);
  assert.match(github.logo, /^[a-f0-9]{24}$/);
  assert.match(github.composerIcon, /^[a-f0-9]{24}$/);
  if (process.platform !== "win32") assert.equal(github.logoDark, null);
  assert.ok(result.assets.has(github.logo));
  assert.equal(result.marketplaces.find((item) => item.name === "personal").sourceType, "local");
});

test("selects the newest real version directory and reports every version name", async (context) => {
  const home = await tempHome(context);
  await createCodexPluginFixture(home);
  const chrome = (await scanCodexPlugins(home)).plugins.find((plugin) => plugin.id === "chrome@openai-bundled");
  assert.equal(chrome.version, "26.2.0");
  assert.equal(chrome.displayName, "Chrome 26.2.0");
  assert.equal(chrome.components.hooks, true);
  assert.deepEqual(
    [...chrome.versions].sort(),
    process.platform === "win32" ? ["26.1.0", "26.2.0"] : ["26.1.0", "26.2.0", "latest"],
  );
});

test("skips escaped plugin directories, oversized and malformed manifests, and never leaks secrets", async (context) => {
  const home = await tempHome(context);
  await createCodexPluginFixture(home);
  const result = await scanCodexPlugins(home);
  const ids = result.plugins.map((plugin) => plugin.id);
  assert.equal(ids.includes("escape-plugin@evil-market"), false);
  const huge = result.plugins.find((plugin) => plugin.id === "huge@big-market");
  assert.equal(huge.manifestStatus, "too-large");
  const broken = result.plugins.find((plugin) => plugin.id === "broken@bad-market");
  assert.equal(broken.manifestStatus, "invalid");
  assert.ok(result.warnings.length >= 2);
  assert.doesNotMatch(publicJson(result), SECRET_PATTERN);
  assert.doesNotMatch(publicJson(result), /escaped|secret-path|github\.example\.test\/secret/);
});

test("fails soft on malformed Codex config and missing directories", async (context) => {
  const home = await tempHome(context);
  const missing = await scanCodexPlugins(home);
  assert.equal(missing.available, false);
  assert.deepEqual(missing.plugins, []);

  const { codex } = await createCodexPluginFixture(home);
  await writeFile(path.join(codex, "config.toml"), '[plugins."secret-invalid');
  const result = await scanCodexPlugins(home);
  assert.ok(result.warnings.some((warning) => /config\.toml/.test(warning)));
  assert.equal(result.plugins.find((plugin) => plugin.id === "github@openai-curated").enabled, "unknown");
  assert.doesNotMatch(publicJson(result), SECRET_PATTERN);
});

test("aggregates Codex connectors from the newest app tools cache", async (context) => {
  const home = await tempHome(context);
  await createCodexPluginFixture(home);
  const plugins = await scanCodexPlugins(home);
  const result = await scanCodexConnectors(home, { plugins: plugins.plugins });
  assert.equal(result.available, true);
  assert.equal(result.cachedAt, "2026-09-30T00:00:00.000Z");
  assert.deepEqual(result.connectors.map((connector) => connector.id), ["connector_github123", "connector_hotline"]);
  const github = result.connectors[0];
  assert.equal(github.name, "GitHub");
  assert.equal(github.description, "GitHub connector description");
  assert.equal(github.toolCount, 3);
  assert.deepEqual(github.toolNames, ["List pull requests", "Get issue", "search"]);
  assert.deepEqual(github.providedByPlugins.sort(), ["github@openai-curated", "github@openai-curated-remote"]);
  assert.equal(github.source, "codex-cache");
  assert.doesNotMatch(JSON.stringify(result), SECRET_PATTERN);
});

test("refuses oversized or malformed connector caches without throwing", async (context) => {
  const home = await tempHome(context);
  const { newFile } = await createCodexPluginFixture(home);
  await truncate(newFile, 20_000_001);
  let result = await scanCodexConnectors(home);
  assert.deepEqual(result.connectors, []);
  assert.equal(result.warnings.length, 1);

  await writeFile(newFile, "{ secret-not-json");
  result = await scanCodexConnectors(home);
  assert.deepEqual(result.connectors, []);
  assert.equal(result.warnings.length, 1);
  assert.doesNotMatch(JSON.stringify(result), SECRET_PATTERN);

  const empty = await tempHome(context);
  assert.equal((await scanCodexConnectors(empty)).available, false);
});
