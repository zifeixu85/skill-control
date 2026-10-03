import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { scanWorkBuddyPlugins } from "../server/installed-plugins.mjs";
import { scanWorkBuddyExperts } from "../server/workbuddy-experts.mjs";
import { normalizeExpertKey, readWorkBuddyExpertUsage } from "../server/workbuddy-usage.mjs";
import { createPlantedPluginFixture } from "./fixtures/planted.mjs";
import { createWorkBuddyExpertFixture, createWorkBuddyUsageDatabase } from "./fixtures/workbuddy.mjs";

async function tempHome(context) {
  const home = await mkdtemp(path.join(tmpdir(), "workbuddy-experts-test-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

const publicJson = (value) => JSON.stringify(value, (key, item) => (item instanceof Map ? undefined : item));

test("discovers market, cache-only and the user's own experts with prompts, skills and avatars", async (context) => {
  const home = await tempHome(context);
  await createWorkBuddyExpertFixture(home);
  await createWorkBuddyUsageDatabase(home);
  const product = await scanWorkBuddyExperts(home);
  const byName = Object.fromEntries(product.items.map((item) => [item.name, item]));

  assert.equal(product.available, true);
  assert.deepEqual(product.items.map((item) => `${item.origin}:${item.name}`), [
    "mine:mine-expert",
    "market:research-team",
    "market:solo-cache",
  ]);

  const mine = byName["mine-expert"];
  assert.equal(mine.displayName, "小初");
  assert.equal(mine.kind, "expert");
  assert.equal(mine.version, "0.1.0");
  assert.equal(mine.packaged, true);
  assert.equal(mine.inUse, true);
  assert.equal(mine.installedVersion, "0.1.0");
  assert.deepEqual(mine.skills, ["mine-skill"]);
  assert.equal(mine.defaultPrompt, "你好，我是小初");
  assert.deepEqual(mine.quickPrompts, ["写一篇笔记", "Only English"]);
  assert.deepEqual(mine.tags, ["内容"]);
  assert.match(mine.avatar, /^[a-f0-9]{24}$/u);
  assert.deepEqual(mine.used, { count: 1, lastUsedAt: "2026-10-01T00:00:00.000Z" });
  assert.equal(mine.members[0].maxTurns, 40);

  const team = byName["research-team"];
  assert.equal(team.kind, "expert-team");
  assert.equal(team.packaged, false);
  assert.equal(team.inUse, false);
  assert.equal(team.defaultPrompt, "开始调研");
  assert.deepEqual(team.skills, ["source-review"]);
  assert.deepEqual(team.used, { count: 2, lastUsedAt: "2026-09-20T00:00:00.000Z" });
  const lead = team.members.find((member) => member.name === "research-lead");
  const analyst = team.members.find((member) => member.name === "analyst");
  assert.match(lead.avatar, /^[a-f0-9]{24}$/u);
  assert.equal(analyst.avatar, null);
  assert.match(team.members.find((member) => member.name === "reviewer").avatar, /^[a-f0-9]{24}$/u);
  assert.ok(product.assets.has(team.avatar));

  const cacheOnly = byName["solo-cache"];
  assert.equal(cacheOnly.installed, true);
  if (process.platform !== "win32") assert.equal(cacheOnly.avatar, null);

  assert.doesNotMatch(publicJson(product), /PLANT-TITLE|ex_cloud/u);
});

test("maps WorkBuddy expert ids and skips unreadable usage databases", async (context) => {
  assert.equal(normalizeExpertKey("OpcTeam"), normalizeExpertKey("opc-team"));
  const home = await tempHome(context);
  await createWorkBuddyExpertFixture(home);
  await writeFile(path.join(home, ".workbuddy", "workbuddy.db"), "not a database");
  const usage = await readWorkBuddyExpertUsage(home);
  assert.equal(usage.available, false);
  assert.equal(usage.warnings.length, 1);
  const product = await scanWorkBuddyExperts(home);
  assert.ok(product.items.every((item) => item.used === null));
  assert.equal(product.warnings.length, 1);

  const empty = await tempHome(context);
  const none = await readWorkBuddyExpertUsage(empty);
  assert.deepEqual(none.warnings, []);
});

test("reads WorkBuddy installed plugins with localized names and components", async (context) => {
  const home = await tempHome(context);
  await createPlantedPluginFixture(home);
  const result = await scanWorkBuddyPlugins(home);
  assert.equal(result.plugins.length, 1);
  const [demo] = result.plugins;
  assert.equal(demo.agentId, "workbuddy");
  assert.equal(demo.kind, "plugin");
  assert.equal(demo.displayName, "演示插件");
  assert.deepEqual(demo.components.agents, ["helper"]);
  assert.deepEqual(demo.components.commands, ["run"]);
  assert.deepEqual(demo.components.mcpServers, [{ name: "wbserver", transport: "stdio" }]);
  assert.equal(result.warnings.length, 1);
  assert.doesNotMatch(publicJson(result), /PLANT/u);
});
