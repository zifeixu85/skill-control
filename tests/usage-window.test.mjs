import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadUsageIndex, runUsageIndex, USAGE_INDEX_VERSION } from "../server/usage-index.mjs";
import { clampDays, usageForAgent, usageForSkill, usageModels, usageProjects, usageSummary } from "../server/usage-query.mjs";
import { dayKey } from "../server/usage-sources.mjs";
import { writeFixtureFile } from "./fixtures/smartorder.mjs";

const line = (value) => `${JSON.stringify(value)}\n`;
const ago = (days) => new Date(Date.now() - days * 86_400_000 - 3_600_000).toISOString();

test("days: 1–3650, all time as 'all' or 0, anything else the fallback", () => {
  assert.deepEqual(["all", "ALL", "0", 0].map((value) => clampDays(value, 30)), [null, null, null, null]);
  assert.deepEqual([clampDays("7", 30), clampDays("90", 30), clampDays("5000", 30), clampDays("-3", 30), clampDays("abc", 30), clampDays(undefined, 90)], [7, 90, 3650, 30, 30, 90]);
});

test("all time keeps days older than 400 and labels the window", async (context) => {
  const home = await mkdtemp(path.join(tmpdir(), "usage-window-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const assistant = (id, days) => ({
    type: "assistant",
    timestamp: ago(days),
    cwd: "/work/old-project",
    message: { id, model: "claude-sonnet-5-5", usage: { input_tokens: 100, output_tokens: 10 }, content: [{ type: "tool_use", id: `t_${id}`, name: "Skill", input: { skill: "pdf" } }] },
  });
  await writeFixtureFile(path.join(home, ".claude", "projects", "-work-old-project"), "s.jsonl", [assistant("a", 500), assistant("b", 0)].map(line).join(""));
  const indexPath = path.join(home, "index.json");
  await runUsageIndex({ homeDirectory: home, indexPath, budgetMs: 10_000 });
  const index = await loadUsageIndex(indexPath);
  assert.equal(index.version, USAGE_INDEX_VERSION);
  assert.ok(USAGE_INDEX_VERSION >= 3);

  const all = usageSummary(index, { days: null });
  assert.deepEqual([all.windowDays, all.windowLabel], [null, "所有时间"]);
  const claude = all.agents.find((agent) => agent.agentId === "claude");
  assert.equal(claude.tokens.total, 220, "the 500-day-old message is kept");
  assert.equal(claude.series[0].date, dayKey(ago(500)), "the series starts at the earliest indexed day");
  assert.equal(claude.series.at(-1).date, dayKey(Date.now()));
  assert.ok(claude.costUsd > 0);
  const month = usageSummary(index, { days: 30 });
  assert.deepEqual([month.windowLabel, month.agents.find((agent) => agent.agentId === "claude").tokens.total], ["最近 30 天", 110]);

  for (const result of [usageModels(index, { days: null }), usageProjects(index, { days: null }), usageForAgent(index, "claude", { days: null }), usageForSkill(index, "pdf", { days: null })]) {
    assert.deepEqual([result.windowDays, result.windowLabel], [null, "所有时间"]);
  }
  assert.equal(usageForSkill(index, "pdf", { days: null }).agents[0].total, 2);
  assert.equal(usageProjects(index, { days: null }).projects[0].tokens, 220);
  assert.equal(usageForAgent(index, "claude", { days: null }).totals.sessions, 1);
});
