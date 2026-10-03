import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { scanSmartOrder, scanSmartOrderConnectors } from "../server/smartorder.mjs";
import { scanAll } from "../server/local-server.mjs";
import { createSmartOrderFixture, writeFixtureFile } from "./fixtures/smartorder.mjs";

async function tempHome(context) {
  const home = await mkdtemp(path.join(tmpdir(), "smartorder-test-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test("SmartOrder lists configured MCP connectors without credentials or command arguments", async (context) => {
  const home = await tempHome(context);
  await createSmartOrderFixture(home);
  const catalog = await scanSmartOrderConnectors(home);
  assert.equal(catalog.available, true);
  assert.equal(catalog.connectors.length, 3);
  const orders = catalog.connectors.find((item) => item.name === "orders");
  assert.equal(orders.endpoint, "https://example.test");
  assert.equal(orders.enabled, true);
  assert.equal(orders.hasCredentials, true);
  assert.equal(orders.timeoutSeconds, 45);
  assert.deepEqual(orders.enabledTools, ["query_orders"]);
  assert.deepEqual(orders.disabledTools, ["delete_order"]);
  const local = catalog.connectors.find((item) => item.name === "local");
  assert.equal(local.transport, "stdio");
  assert.equal(local.enabled, false);
  assert.equal(local.toolsRestricted, true);
  assert.deepEqual(local.enabledTools, []);
  assert.doesNotMatch(JSON.stringify(catalog), /secret-|skillSources|disabledSkillPaths|bearer_token|env_http_headers/);
  assert.equal(catalog.plugins.find((item) => item.name === "order-demo").displayName, "酒店订单示例");
});

test("SmartOrder skill scan includes installed plugin skills but excludes disabled, catalog and historical cache", async (context) => {
  const home = await tempHome(context);
  const { root } = await createSmartOrderFixture(home);
  if (process.platform !== "win32") {
    const outside = await writeFixtureFile(home, "outside/SKILL.md", "---\nname: escaped-secret\n---\n");
    await symlink(path.dirname(outside), path.join(root, "skills", "escape"));
  }
  const scan = await scanAll({
    version: 3, visibleAgentIds: ["smartorder"], agents: [{
      id: "smartorder", name: "订单来了", shortName: "订", color: "#9abbd6", paths: [path.join(root, "skills")],
    }],
  }, { homeDirectory: home });
  assert.deepEqual(scan.skills.map((skill) => skill.name).sort(), ["local-demo", "plugin-demo", "system-demo"]);
  assert.equal(scan.skills.find((skill) => skill.name === "plugin-demo").instances[0].readOnly, true);
  assert.match(scan.skills.find((skill) => skill.name === "plugin-demo").instances[0].sourceLabel, /酒店订单示例/);
  assert.equal(scan.skills.find((skill) => skill.name === "system-demo").instances[0].readOnly, true);
  assert.equal(scan.skills.find((skill) => skill.name === "local-demo").instances[0].readOnly, false);
  assert.equal(scan.agents[0].skillCount, 3);
});

test("SmartOrder refuses ambiguous plugin versions and unsafe manifest skill paths", async (context) => {
  const home = await tempHome(context);
  const { root, config } = await createSmartOrderFixture(home);
  await writeFixtureFile(root, "plugins/cache/demo-market/order-demo/V2/.codex-plugin/plugin.json", "{}");
  let catalog = await scanSmartOrder(home);
  assert.equal(catalog.skillSources.length, 0);
  assert.equal(catalog.plugins.find((item) => item.name === "order-demo").status, "ambiguous");
  const selected = config.replace('[plugins."order-demo@demo-market"]\nenabled = true', '[plugins."order-demo@demo-market"]\nenabled = true\nversion = "V1"');
  await writeFile(path.join(root, "config.toml"), selected);
  catalog = await scanSmartOrder(home);
  assert.equal(catalog.skillSources.length, 1);
  await writeFixtureFile(root, "plugins/cache/demo-market/order-demo/V1/.codex-plugin/plugin.json", JSON.stringify({
    skills: ["../../../../../../outside", "C:\\outside", "/outside"],
  }));
  catalog = await scanSmartOrder(home);
  assert.equal(catalog.skillSources.length, 0);
});

test("SmartOrder handles missing, invalid, oversized and symlinked configuration safely", async (context) => {
  const home = await tempHome(context);
  assert.equal((await scanSmartOrderConnectors(home)).available, false);
  const { root } = await createSmartOrderFixture(home);
  for (const input of ['[mcp_servers."secret-invalid', "#".repeat(256_001)]) {
    await writeFile(path.join(root, "config.toml"), input);
    const catalog = await scanSmartOrderConnectors(home);
    assert.equal(catalog.connectors.length, 0);
    assert.equal(catalog.warnings.length, 1);
    assert.doesNotMatch(JSON.stringify(catalog), /secret-invalid/);
  }
  if (process.platform !== "win32") {
    await rm(path.join(root, "config.toml"));
    const outside = await writeFixtureFile(home, "outside.toml", '[mcp_servers.secret-outside]\ncommand="x"\n');
    await symlink(outside, path.join(root, "config.toml"));
    const catalog = await scanSmartOrderConnectors(home);
    assert.equal(catalog.connectors.length, 0);
    assert.doesNotMatch(JSON.stringify(catalog), /secret-outside/);
  }
});
