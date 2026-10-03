import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  scanAgentActivity,
  suggestPrimaryAgents,
} from "../server/agents-activity.mjs";
import { writeSessionFile } from "./fixtures/integrations.mjs";

const NOW = new Date("2026-10-03T12:00:00Z").getTime();
const daysAgo = (days) => new Date(NOW - days * 86_400_000);

async function tempHome(context) {
  const home = await mkdtemp(path.join(tmpdir(), "activity-test-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test("counts recent session files, bytes and active days per agent using stat only", async (context) => {
  const home = await tempHome(context);
  await writeSessionFile(home, ".codex/sessions/2026/09/30/rollout-a.jsonl", 1_000, daysAgo(2));
  await writeSessionFile(home, ".codex/sessions/2026/09/22/rollout-b.jsonl.zst", 500, daysAgo(10));
  await writeSessionFile(home, ".codex/sessions/2026/09/22/rollout-c.jsonl", 100, daysAgo(10));
  await writeSessionFile(home, ".codex/sessions/2026/07/01/rollout-old.jsonl", 5_000, daysAgo(60));
  await writeSessionFile(home, ".codex/sessions/2026/09/30/notes.txt", 9_999, daysAgo(1));
  await writeSessionFile(home, ".claude/projects/p1/s1.jsonl", 300, daysAgo(1));
  await writeSessionFile(home, ".claude/projects/p1/s3.jsonl", 300, daysAgo(1));
  await writeSessionFile(home, ".claude/projects/p3/s4.jsonl", 300, daysAgo(3));
  await writeSessionFile(home, ".claude/projects/p1/sub/deep.jsonl", 9_999, daysAgo(1));
  await writeSessionFile(home, ".claude/projects/p2/s2.jsonl", 200, daysAgo(40));
  await writeSessionFile(home, ".workbuddy/projects/w/x.jsonl", 50, daysAgo(1));
  if (process.platform !== "win32") {
    const outside = await writeSessionFile(home, "outside/big.jsonl", 900_000, daysAgo(1));
    await symlink(outside, path.join(home, ".claude", "projects", "p1", "linked.jsonl"));
  }

  const activity = await scanAgentActivity(home, {
    agentIds: ["codex", "claude", "workbuddy", "cursor"],
    now: NOW,
  });
  const byId = Object.fromEntries(activity.agents.map((agent) => [agent.agentId, agent]));

  assert.equal(activity.windowDays, 30);
  assert.equal(byId.codex.status, "ok");
  assert.equal(byId.codex.files30d, 3);
  assert.equal(byId.codex.bytes30d, 1_600);
  assert.equal(byId.codex.activeDays30d, 2);
  assert.equal(byId.codex.lastActiveAt, daysAgo(2).toISOString());
  assert.equal(byId.claude.files30d, 3);
  assert.equal(byId.claude.bytes30d, 900);
  assert.equal(byId.claude.lastActiveAt, daysAgo(1).toISOString());
  assert.equal(byId.workbuddy.files30d, 1);
  assert.equal(byId.workbuddy.bytes30d, 50);
  assert.equal(byId.cursor.status, "unknown");
  assert.equal(byId.cursor.files30d, 0);
  assert.equal(byId.cursor.lastActiveAt, null);
  assert.deepEqual(activity.suggestedPrimaryAgentIds, ["codex", "claude"]);
});

test("ranks suggestions by recent bytes and drops agents below 2% of the top agent or with few sessions", () => {
  const base = { status: "ok", activeDays30d: 1, lastActiveAt: null };
  assert.deepEqual(
    suggestPrimaryAgents([
      { ...base, agentId: "workbuddy", files30d: 70, bytes30d: 22_000_000 },
      { ...base, agentId: "claude", files30d: 48, bytes30d: 671_000_000 },
      { ...base, agentId: "codex", files30d: 345, bytes30d: 8_800_000_000 },
    ]),
    ["codex", "claude"],
  );
  assert.deepEqual(
    suggestPrimaryAgents([
      { ...base, agentId: "workbuddy", files30d: 73, bytes30d: 22_000_000 },
      { ...base, agentId: "codex", files30d: 345, bytes30d: 8_800_000_000 },
    ]),
    ["codex"],
  );
  assert.deepEqual(
    suggestPrimaryAgents([
      { ...base, agentId: "workbuddy", files30d: 70, bytes30d: 200 },
      { ...base, agentId: "claude", files30d: 3, bytes30d: 900 },
      { ...base, agentId: "codex", files30d: 3, bytes30d: 1_000 },
    ]),
    ["codex", "claude"],
  );
  assert.deepEqual(
    suggestPrimaryAgents([
      { ...base, agentId: "claude", files30d: 2, bytes30d: 900 },
      { ...base, agentId: "codex", files30d: 3, bytes30d: 1_000 },
    ]),
    ["codex"],
  );
  assert.deepEqual(
    suggestPrimaryAgents([
      { ...base, agentId: "codex", files30d: 0, bytes30d: 0 },
      { ...base, agentId: "claude", status: "unknown", files30d: 0, bytes30d: 0 },
    ]),
    [],
  );
});

test("reports missing session directories and stops at the file bound", async (context) => {
  const home = await tempHome(context);
  const empty = await scanAgentActivity(home, { now: NOW });
  assert.deepEqual(empty.suggestedPrimaryAgentIds, []);
  assert.equal(empty.agents.find((agent) => agent.agentId === "codex").status, "missing");

  for (let index = 0; index < 5; index += 1) {
    await writeSessionFile(home, `.codex/sessions/2026/09/30/rollout-${index}.jsonl`, 10, daysAgo(1));
  }
  const bounded = await scanAgentActivity(home, { now: NOW, maxFiles: 3 });
  const codex = bounded.agents.find((agent) => agent.agentId === "codex");
  assert.equal(codex.truncated, true);
  assert.ok(codex.files30d <= 3);
});

test("keeps resumed sessions in older date folders but prunes folders beyond the lookback", async (context) => {
  const home = await tempHome(context);
  await writeSessionFile(home, ".codex/sessions/2026/07/06/rollout-resumed.jsonl", 4_000, daysAgo(1));
  await writeSessionFile(home, ".codex/sessions/2024/01/01/rollout-ancient.jsonl", 9_000, daysAgo(1));
  const activity = await scanAgentActivity(home, { now: NOW });
  const codex = activity.agents.find((agent) => agent.agentId === "codex");
  assert.equal(codex.files30d, 1);
  assert.equal(codex.bytes30d, 4_000);
});

test("visits the most recently modified project folders first and reports truncation", async (context) => {
  const home = await tempHome(context);
  for (let index = 0; index < 4; index += 1) {
    await writeSessionFile(home, `.claude/projects/old-${index}/s.jsonl`, 10, daysAgo(90));
  }
  const { utimes } = await import("node:fs/promises");
  for (let index = 0; index < 4; index += 1) {
    await utimes(path.join(home, ".claude", "projects", `old-${index}`), daysAgo(90), daysAgo(90));
  }
  await writeSessionFile(home, ".claude/projects/zz-recent/a.jsonl", 100, daysAgo(1));
  await writeSessionFile(home, ".claude/projects/zz-recent/b.jsonl", 100, daysAgo(1));
  await utimes(path.join(home, ".claude", "projects", "zz-recent"), daysAgo(1), daysAgo(1));
  const activity = await scanAgentActivity(home, { now: NOW, maxFiles: 2 });
  const claude = activity.agents.find((agent) => agent.agentId === "claude");
  assert.equal(claude.files30d, 2);
  assert.equal(claude.truncated, true);
  assert.equal(activity.warnings.length, 1);
  assert.match(activity.warnings[0], /Claude Code/);
});

test("ranks suggestions among configured agents before applying the top-two cap", async (context) => {
  const home = await tempHome(context);
  for (let index = 0; index < 3; index += 1) {
    await writeSessionFile(home, `.codex/sessions/2026/10/01/rollout-${index}.jsonl`, 900_000, daysAgo(1));
    await writeSessionFile(home, `.claude/projects/p/${index}.jsonl`, 50_000, daysAgo(1));
    await writeSessionFile(home, `.workbuddy/projects/w/${index}.jsonl`, 40_000, daysAgo(1));
  }
  const activity = await scanAgentActivity(home, { now: NOW, agentIds: ["claude", "workbuddy"] });
  assert.deepEqual(activity.suggestedPrimaryAgentIds, ["claude", "workbuddy"]);
});
