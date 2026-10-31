import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startTestServer } from "./fixtures/server.mjs";
import { writeFixtureFile } from "./fixtures/smartorder.mjs";

async function tempHome(context, prefix) {
  const home = await mkdtemp(path.join(tmpdir(), prefix));
  context.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test("config.network: checks on by default, the first-run notice, the switch, pre-0.3 configs", { timeout: 60_000 }, async (context) => {
  const fresh = await tempHome(context, "network-fresh-");
  const { request, requestJson } = await startTestServer(context, fresh);
  const first = await requestJson("/api/config");
  // The test server runs with SKILL_MANAGER_UPDATES_OFFLINE=1, which the UI is told about.
  assert.deepEqual(first.network, { updateChecks: true, noticeSeenAt: null, envOffline: true });
  const saved = await requestJson("/api/config", { method: "PUT", body: JSON.stringify({ ...first, network: { updateChecks: false, noticeSeen: true } }) });
  assert.equal(saved.network.updateChecks, false);
  assert.match(saved.network.noticeSeenAt, /^\d{4}-\d{2}-\d{2}T/u);
  const stored = JSON.parse(await readFile(path.join(fresh, ".agent-skill-manager", "config.json"), "utf8"));
  assert.deepEqual(Object.keys(stored.network).sort(), ["noticeSeenAt", "updateChecks"], "envOffline is not stored");
  // Saving without `network` keeps it; the notice time is set once.
  const again = await requestJson("/api/config", { method: "PUT", body: JSON.stringify({ visibleAgentIds: [], network: { noticeSeen: true } }) });
  assert.deepEqual([again.network.updateChecks, again.network.noticeSeenAt], [false, saved.network.noticeSeenAt]);
  const versions = await (await request("/api/agent-versions")).json();
  assert.deepEqual([versions.offline, versions.autoCheck], [true, "off"], "the environment variable stops everything");

  const upgraded = await tempHome(context, "network-upgraded-");
  await writeFixtureFile(upgraded, ".agent-skill-manager/config.json", `${JSON.stringify({ version: 3, agents: [], knownAgentIds: [] })}\n`);
  const old = await startTestServer(context, upgraded);
  assert.deepEqual((await old.requestJson("/api/config")).network, { updateChecks: true, noticeSeenAt: "before-0.3", envOffline: true });
});
