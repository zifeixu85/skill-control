import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { listAgentFiles, readAgentFile } from "../server/agent-files.mjs";
import { writeFixtureFile } from "./fixtures/smartorder.mjs";

/** Layouts seen on a real machine: OpenClaw run by LumiClaw, WorkBuddy with an account folder. */
async function createLayouts(home) {
  const openclaw = path.join(home, ".openclaw");
  await writeFixtureFile(openclaw, "openclaw.json", JSON.stringify({ agents: { defaults: { workspace: "~/.openclaw/workspace" }, list: [{ id: "lumi", workspace: "~/lumi-space" }] } }));
  await writeFixtureFile(openclaw, "AGENTS.md", "# Agents\n");
  await writeFixtureFile(openclaw, "LUMICLAW.md", "# LumiClaw\n");
  await writeFixtureFile(openclaw, ".lumiclaw/current-tasks.md", "# 当前任务\n\ntoken=ZZ9lumitasks21abc\n");
  await writeFixtureFile(openclaw, "agents/lumi/LESSONS.md", "# Lessons\n");
  await writeFixtureFile(openclaw, "agents/ceo/LESSONS.md", "# CEO lessons\n");
  await writeFixtureFile(openclaw, "agents/ceo/agent/auth-profiles.json", JSON.stringify({ key: "ZZ9ocauth22" }));
  await writeFixtureFile(openclaw, "agents/ceo/sessions/s1.jsonl", "{}\n");
  await writeFixtureFile(openclaw, "workspace/SOUL.md", "# Soul\n");
  await writeFixtureFile(openclaw, "workspace/memory/2026-10-01.md", "# Day\n");
  await writeFixtureFile(home, "lumi-space/IDENTITY.md", "# Lumi\n");
  await writeFixtureFile(home, "lumi-space/memory/2026-10-02.md", "# Lumi day\n");

  const workbuddy = path.join(home, ".workbuddy");
  for (const name of ["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"]) {
    await writeFixtureFile(workbuddy, name, `# global ${name}\n`);
    await writeFixtureFile(workbuddy, `user-0f1e2d3c-personal/${name}`, `# account ${name}\n`);
  }
  await writeFixtureFile(workbuddy, "user-0f1e2d3c-personal/workspace-state.json", "{}\n");
  await writeFixtureFile(workbuddy, "memory/0f1e2d3c_memory.md", "# 记忆\npassword: ZZ9wbmemory23\n");
  await writeFixtureFile(workbuddy, "memory/0f1e2d3c_memory.md.bak", "# old\n");
  await writeFixtureFile(workbuddy, "automations/automation-1/memory.md", "# a1\n");
  await writeFixtureFile(workbuddy, "automations/automation-2/memory.md", "# a2\n");
  await writeFixtureFile(workbuddy, "automations/automation-2/state.json", "{}\n");
  await writeFixtureFile(workbuddy, "plans/swift-plan.md", "# 计划\n");
}

const groupsOf = (listing) => Object.fromEntries(listing.groups.map((group) => [group.id, group.files.map((file) => file.displayPath.replace(/^~\//u, ""))]));

test("OpenClaw: every agent's workspace and folder, memory days and LumiClaw's task files", async (context) => {
  const home = await mkdtemp(path.join(tmpdir(), "agent-files-layouts-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await createLayouts(home);
  const options = { homeDirectory: home, homes: [home] };
  const listing = await listAgentFiles("openclaw", options);
  assert.deepEqual(listing.agents, ["lumi", "ceo"]);
  const groups = Object.fromEntries(listing.groups.map((group) => [group.id, group.files.map((file) => file.name)]));
  assert.deepEqual(groups["workspace:default"], ["SOUL.md"], "agents.defaults.workspace is listed too");
  assert.deepEqual(groups["memory:default"], ["2026-10-01.md"]);
  assert.deepEqual(groups["workspace:lumi"], ["IDENTITY.md"]);
  assert.deepEqual(groups["memory:lumi"], ["2026-10-02.md"]);
  assert.deepEqual(groups["agent-state:lumi"], ["LESSONS.md"]);
  assert.deepEqual(groups["agent-state:ceo"], ["LESSONS.md"], "credentials and sessions are never listed");
  assert.deepEqual(groups.state, ["AGENTS.md", "LUMICLAW.md"]);
  assert.deepEqual(groups.lumiclaw, ["current-tasks.md"]);
  const ceo = await listAgentFiles("openclaw", { ...options, agent: "ceo" });
  assert.deepEqual(ceo.groups.map((group) => group.id), ["agent-state", "state", "lumiclaw"]);
  for (const file of listing.groups.flatMap((group) => group.files)) {
    assert.doesNotMatch((await readAgentFile(file.id, options)).text, /ZZ9/u, file.name);
  }
});

test("WorkBuddy: global and account persona, memory, automation memories and plans", async (context) => {
  const home = await mkdtemp(path.join(tmpdir(), "agent-files-layouts-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await createLayouts(home);
  const listing = await listAgentFiles("workbuddy", { homeDirectory: home, homes: [home] });
  const groups = groupsOf(listing);
  assert.deepEqual(groups.identity, [".workbuddy/SOUL.md", ".workbuddy/IDENTITY.md", ".workbuddy/USER.md", ".workbuddy/MEMORY.md"]);
  assert.deepEqual(groups.account, ["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"].map((name) => `.workbuddy/user-0f1e2d3c-personal/${name}`));
  assert.match(listing.groups.find((group) => group.id === "account").note, /没有设置标明哪一份生效/u);
  assert.deepEqual(groups.memory, [".workbuddy/memory/0f1e2d3c_memory.md"], ".bak copies are left out");
  assert.deepEqual(groups.automations.sort(), [".workbuddy/automations/automation-1/memory.md", ".workbuddy/automations/automation-2/memory.md"]);
  assert.deepEqual(groups.plans, [".workbuddy/plans/swift-plan.md"]);
  assert.equal(listing.groups.find((group) => group.id === "plans").label, "计划");
});
