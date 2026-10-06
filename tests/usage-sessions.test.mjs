import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadUsageIndex, runUsageIndex } from "../server/usage-index.mjs";
import { usageForAgent, usageProjects, usageSummary } from "../server/usage-query.mjs";
import { dayKey } from "../server/usage-sources.mjs";
import { fileActiveDays, isSessionFile, sessionKeyOf } from "../server/usage-sessions.mjs";
import { writeFixtureFile } from "./fixtures/smartorder.mjs";

const line = (value) => `${JSON.stringify(value)}\n`;
const ago = (days) => new Date(Date.now() - days * 86_400_000 - 3_600_000).toISOString();

async function createHome(home) {
  const claude = path.join(home, ".claude", "projects", "-work-long-runner");
  const assistant = (id, days, extra = {}, cwd = "/work/long-runner") => ({
    type: "assistant",
    timestamp: ago(days),
    cwd,
    message: { id, model: "claude-sonnet-5-5", usage: { input_tokens: 10, output_tokens: 10 }, content: [] },
    ...extra,
  });
  // Started 40 days ago, still in use 2 days ago and today.
  await writeFixtureFile(claude, "long.jsonl", [assistant("l_1", 40), assistant("l_2", 2), assistant("l_3", 0)].map(line).join(""));
  // Started and used today.
  await writeFixtureFile(claude, "fresh.jsonl", line(assistant("f_1", 0)));
  // A subagent transcript is activity of its parent session, not a session of its own.
  await writeFixtureFile(claude, "long/subagents/agent-x.jsonl", line(assistant("s_1", 1)));
  // A session started 40 days ago whose subagents work today in another folder.
  await writeFixtureFile(claude, "old.jsonl", line(assistant("o_1", 40, {}, "/work/parent-project")));
  await writeFixtureFile(claude, "old/subagents/agent-y.jsonl", line(assistant("o_2", 0, {}, "/work/sub-folder")));

  // Codex: started 40 days ago; inside the window only a skill read, no tokens.
  await writeFixtureFile(home, ".codex/sessions/2026/08/01/rollout-2026-08-01T10-00-00-eeee.jsonl", [
    { timestamp: ago(40), type: "session_meta", payload: { id: "e", cwd: "/work/long-runner" } },
    { timestamp: ago(5), type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "cat ~/.codex/skills/pdf/SKILL.md" }) } },
  ].map(line).join(""));

  const { DatabaseSync } = await import("node:sqlite");
  await mkdir(path.join(home, ".hermes"), { recursive: true });
  const database = new DatabaseSync(path.join(home, ".hermes", "state.db"));
  database.exec("CREATE TABLE sessions (id TEXT, started_at REAL, ended_at REAL, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cwd TEXT)");
  const insert = database.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)");
  const seconds = (days) => (Date.now() - days * 86_400_000 - 3_600_000) / 1000;
  insert.run("h_long", seconds(40), seconds(1), "gpt-5.5", 1_000, 100, "/work/long-runner"); // active in the window, started before it
  insert.run("h_old", seconds(60), seconds(50), "gpt-5.5", 1_000, 100, "/work/long-runner"); // not active
  insert.run("h_new", seconds(3), null, "gpt-5.5", 10, 1, null);
  database.close();
}

async function setup(context) {
  const home = await mkdtemp(path.join(tmpdir(), "usage-sessions-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await createHome(home);
  const indexPath = path.join(home, ".agent-skill-manager", "usage-index.json");
  assert.equal((await runUsageIndex({ homeDirectory: home, indexPath, budgetMs: 10_000 })).state, "complete");
  return loadUsageIndex(indexPath);
}

test("sessions count when active in the window, not only on the day they started", async (context) => {
  const index = await setup(context);
  const agents = Object.fromEntries(usageSummary(index, { days: 30 }).agents.map((agent) => [agent.agentId, agent]));
  // Claude: the long-running session, today's, and the old one whose subagent works today.
  assert.deepEqual([agents.claude.sessions, agents.claude.sessionsStarted], [3, 1]);
  // Codex: a skill read inside the window makes the old session active.
  assert.deepEqual([agents.codex.sessions, agents.codex.sessionsStarted], [1, 0]);
  // Hermes: started 40 days ago and ended yesterday counts; the one that ended 50 days ago does not.
  assert.deepEqual([agents.hermes.sessions, agents.hermes.sessionsStarted], [2, 1]);
  assert.equal(agents.hermes.tokens.total, 11, "tokens stay on the day a session started");

  // Series: a session counts on each day it is active.
  const series = new Map(agents.claude.series.map((point) => [point.date, point]));
  assert.equal(series.get(dayKey(ago(0))).sessions, 3);
  assert.equal(series.get(dayKey(ago(0))).sessionsStarted, 1);
  assert.equal(series.get(dayKey(ago(2))).sessions, 1);
  assert.equal(series.get(dayKey(ago(1))).sessions, 1, "its subagent made the long session active that day");
  assert.equal(agents.claude.activeDays, 3, "activeDays is unchanged: days with a start or tokens");

  const claude = usageForAgent(index, "claude", { days: 30 });
  assert.deepEqual([claude.totals.sessions, claude.totals.sessionsStarted], [3, 1]);
  // A project made only of subagent transcripts still shows the session that worked in it.
  assert.deepEqual(
    claude.topProjects.map((project) => [project.name, project.sessions, project.sessionsStarted]).sort(),
    [["long-runner", 2, 1], ["sub-folder", 1, 0]],
  );

  const projects = usageProjects(index, { days: 30 });
  const longRunner = projects.projects.find((project) => project.name === "long-runner");
  assert.deepEqual([longRunner.sessions, longRunner.sessionsStarted], [4, 1], "Claude 2 + Codex 1 + Hermes 1");
  assert.deepEqual(projects.projects.find((project) => project.name === null).sessions, 1);

  // A 7-day window still sees the long-running sessions.
  const week = Object.fromEntries(usageSummary(index, { days: 7 }).agents.map((agent) => [agent.agentId, agent]));
  assert.deepEqual([week.claude.sessions, week.codex.sessions, week.hermes.sessions], [3, 1, 2]);
});

test("the home card counts a Hermes session by its last activity", async (context) => {
  const home = await mkdtemp(path.join(tmpdir(), "usage-sessions-home-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await createHome(home);
  const { readHermesActivity } = await import("../server/hermes.mjs");
  const activity = await readHermesActivity(home);
  assert.equal(activity.sessions30d, 2, "started 40 days ago and ended yesterday, plus one from 3 days ago");
  assert.ok(Date.parse(activity.lastActiveAt) > Date.now() - 2 * 86_400_000, "the latest end, not the latest start");
});

test("session files: the indexer's flag, or a recorded start for older entries", () => {
  const inWindow = () => true;
  assert.equal(isSessionFile({ sf: false, d: { "2026-10-01": [1, 1, 0, 0, 0, 1] } }), false);
  assert.equal(isSessionFile({ d: { "2026-10-01": [1, 1, 0, 0, 0, 1] } }), true);
  assert.equal(isSessionFile({ d: { "2026-10-01": [0, 1, 0, 0, 0, 1] } }), false);
  assert.deepEqual(fileActiveDays({ sf: true, d: { "2026-10-01": [0, 0, 0, 0, 0, 0] }, k: { pdf: { "2026-10-02": 1 } }, ki: {} }, inWindow), ["2026-10-02"]);
  assert.equal(sessionKeyOf("claude|a", { sf: true, d: {} }), "claude|a");
  assert.equal(sessionKeyOf("claude|b", { sf: false, s: "claude|a", d: {} }), "claude|a", "a subagent belongs to its session");
  assert.equal(sessionKeyOf("openclaw|c", { sf: false, d: {} }), null);
});
