import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PIXEL_PNG, SAFE_SVG } from "./fixtures/integrations.mjs";
import {
  PLANT_PATTERN,
  createPlantedConfigFixture,
  createPlantedPluginFixture,
} from "./fixtures/planted.mjs";
import { startTestServer } from "./fixtures/server.mjs";
import { writeFixtureFile } from "./fixtures/smartorder.mjs";
import { createWorkBuddyExpertFixture, createWorkBuddyUsageDatabase } from "./fixtures/workbuddy.mjs";

test("serves experts, avatars, WorkBuddy plugins and masked configuration details", async (context) => {
  const home = await mkdtemp(path.join(tmpdir(), "experts-e2e-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await createPlantedConfigFixture(home);
  await createPlantedPluginFixture(home);
  await createWorkBuddyExpertFixture(home);
  await createWorkBuddyUsageDatabase(home);
  await writeFixtureFile(home, ".hermes/SOUL.md", "# Hermes\n");
  await writeFixtureFile(home, ".codex/skills/e2e-skill/SKILL.md", "---\nname: e2e-skill\ndescription: e2e\n---\n# E2E\n");
  const { request, requestJson } = await startTestServer(context, home);
  const bodies = [];
  const getJson = async (pathname) => {
    const payload = await requestJson(pathname);
    bodies.push(JSON.stringify(payload));
    return payload;
  };

  const capabilities = await getJson("/api/capabilities");
  const items = capabilities.products.flatMap((product) => product.items);
  assert.deepEqual(
    [...new Set(items.map((item) => item.origin))].sort(),
    ["market", "mine", "profile"],
  );
  assert.equal("assets" in capabilities.products[0], false);
  const mine = items.find((item) => item.origin === "mine");
  assert.equal(mine.displayName, "小初");
  assert.equal(mine.packaged, true);
  assert.deepEqual(mine.used, { count: 1, lastUsedAt: "2026-10-01T00:00:00.000Z" });
  const team = items.find((item) => item.name === "research-team");

  const avatar = await request(`/api/expert-avatar?id=${mine.avatar}`);
  assert.equal(avatar.status, 200);
  assert.equal(avatar.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await avatar.arrayBuffer()), PIXEL_PNG);
  const memberAvatar = await request(
    `/api/expert-avatar?id=${team.members.find((member) => member.avatar).avatar}`,
  );
  assert.equal(memberAvatar.headers.get("content-type"), "image/svg+xml");
  assert.match(memberAvatar.headers.get("content-security-policy"), /sandbox/u);
  assert.equal(await memberAvatar.text(), SAFE_SVG);
  const oversized = await request(
    `/api/expert-avatar?id=${team.members.find((member) => member.name === "reviewer").avatar}`,
  );
  assert.equal(oversized.status, 400);
  assert.match((await oversized.json()).error, /2 MB/u);
  for (const id of ["0".repeat(24), "../x", ""]) {
    assert.equal((await request(`/api/expert-avatar?id=${encodeURIComponent(id)}`)).status, 404);
  }

  const integrations = await getJson("/api/integrations");
  assert.ok(integrations.plugins.some((plugin) => plugin.agentId === "workbuddy" && plugin.displayName === "演示插件"));

  for (const name of ["planted", "remote-planted", "claudeplanted", "cursorplanted", "geminiplanted"]) {
    await getJson(`/api/config-detail?kind=mcp&id=${encodeURIComponent(name)}`);
  }
  for (const id of ["codex", "claude", "workbuddy", "gemini", "cursor"]) {
    await getJson(`/api/config-detail?kind=agent&id=${id}`);
  }
  await getJson(`/api/config-detail?kind=expert&id=${mine.id}`);
  await getJson(`/api/config-detail?kind=expert&id=${team.id}`);
  await getJson("/api/config-detail?kind=plugin&id=claude:planted-plugin%40market");
  await getJson("/api/config-detail?kind=plugin&id=workbuddy:demo%40workbuddy-builtin");
  const scan = await getJson("/api/scan?force=1");
  const skill = scan.skills.find((item) => item.name === "e2e-skill");
  const skillDetail = await getJson(
    `/api/config-detail?kind=skill&id=${skill.id}&instance=${skill.instances[0].id}`,
  );
  assert.equal(skillDetail.files[0].path, "SKILL.md");

  const missing = await request("/api/config-detail?kind=mcp&id=nope");
  assert.equal(missing.status, 404);
  const invalid = await request("/api/config-detail?kind=secrets&id=x");
  assert.equal(invalid.status, 400);

  const all = bodies.join("\n");
  assert.doesNotMatch(all, PLANT_PATTERN);
  assert.doesNotMatch(all, new RegExp(home.replaceAll("/", "\\/")));
});
