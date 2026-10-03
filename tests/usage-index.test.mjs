import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadUsageIndex, runUsageIndex } from "../server/usage-index.mjs";
import { usageForAgent, usageForSkill, usageSummary } from "../server/usage-query.mjs";
import { createUsageService } from "../server/usage-service.mjs";
import { createHermesHome, createOpenClawHome } from "./fixtures/claw-hermes.mjs";
import { createTranscriptsHome } from "./fixtures/insights.mjs";

async function setup(context) {
  const home = await mkdtemp(path.join(tmpdir(), "usage-index-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await createTranscriptsHome(home);
  await createHermesHome(home);
  await createOpenClawHome(home);
  return { home, indexPath: path.join(home, ".agent-skill-manager", "usage-index.json") };
}

const byAgent = (summary) => Object.fromEntries(summary.agents.map((agent) => [agent.agentId, agent]));

test("indexes tokens, sessions and skills from every source without keeping any text", async (context) => {
  const { home, indexPath } = await setup(context);
  const run = await runUsageIndex({ homeDirectory: home, indexPath, budgetMs: 10_000 });
  assert.equal(run.state, "complete");
  const index = await loadUsageIndex(indexPath);
  const agents = byAgent(usageSummary(index, { days: 30 }));

  // Claude: the resumed session repeats msg_1 and its Skill call; both count once.
  assert.equal(agents.claude.sessions, 2);
  assert.deepEqual(agents.claude.tokens, { input: 22, output: 14, cacheRead: 100, cacheWrite: 20, total: 156 });
  // Codex: a duplicated token_count adds nothing, the fork counts only its own turn.
  assert.equal(agents.codex.sessions, 2);
  assert.deepEqual(agents.codex.tokens, { input: 600, output: 80, cacheRead: 1_000, cacheWrite: 0, total: 1_680 });
  // WorkBuddy: input excludes cached tokens; credits come from workbuddy.db.
  assert.equal(agents.workbuddy.sessions, 1);
  assert.deepEqual(agents.workbuddy.tokens, { input: 150, output: 25, cacheRead: 200, cacheWrite: 0, total: 375 });
  assert.equal(agents.workbuddy.credits, 3.75);
  assert.equal(agents.workbuddy.costUsd, null);
  // Hermes state.db and OpenClaw sessions.json: sessions inside the window only.
  assert.equal(agents.hermes.sessions, 2);
  assert.equal(agents.hermes.tokens.total, 4_600);
  assert.equal(agents.hermes.costUsd, 0.42);
  assert.equal(agents.openclaw.sessions, 1);
  assert.equal(agents.openclaw.tokens.total, 1_500);
  assert.equal(agents.claude.series.length, 30);
  assert.ok(agents.claude.sources.some((source) => source.confidence === "exact"));

  const summary = usageSummary(index, { days: 30 });
  const skill = (name) => summary.topSkills.find((item) => item.name === name);
  assert.deepEqual(skill("pdf").agents.map((item) => [item.agentId, item.count, item.confidence]), [["claude", 1, "exact"]]);
  assert.equal(skill("pdf").tokens, 135);
  assert.deepEqual(skill("lark-doc").agents.map((item) => [item.agentId, item.confidence]), [["codex", "inferred"]]);
  assert.equal(skill("output-only"), undefined, "tool outputs are never inspected");
  assert.deepEqual(skill("xlsx").agents.map((item) => [item.agentId, item.count]), [["workbuddy", 1]]);
  assert.deepEqual(skill("managed-skill").agents.map((item) => [item.agentId, item.confidence]), [["openclaw", "inferred"]]);

  const hermesSkill = usageForSkill(index, "flat-skill", { days: 90 });
  assert.deepEqual(hermesSkill.agents.map((item) => [item.agentId, item.reportedTotal, item.confidence]), [["hermes", 7, "reported"]]);
  const codex = usageForAgent(index, "codex", { days: 90 });
  assert.deepEqual(codex.topProjects, [{ name: "beta-project", sessions: 2, tokens: 1_680 }]);
  assert.equal(codex.series.length, 90);
  assert.equal(usageForAgent(index, "workbuddy", { days: 30 }).topProjects[0].name, "gamma-project");

  const stored = await readFile(indexPath, "utf8");
  assert.doesNotMatch(stored, /MSGTEXT|ZZ9/u, "no message text, arguments or titles in the index");
  assert.equal(stored.includes(home), false, "no paths in the index");
});

test("continues from saved offsets, keeps aggregates of deleted transcripts and resumes after the budget", async (context) => {
  const { home, indexPath } = await setup(context);
  await runUsageIndex({ homeDirectory: home, indexPath, budgetMs: 10_000 });
  const claudeDir = path.join(home, ".claude", "projects", "-work-alpha-project");
  await appendFile(
    path.join(claudeDir, "s2.jsonl"),
    `${JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { id: "msg_5", usage: { input_tokens: 50, output_tokens: 50 }, content: [] } })}\n`,
  );
  await runUsageIndex({ homeDirectory: home, indexPath, budgetMs: 10_000 });
  let claude = byAgent(usageSummary(await loadUsageIndex(indexPath), { days: 30 })).claude;
  assert.equal(claude.tokens.total, 256, "only the appended message is new");

  await rm(path.join(claudeDir, "s1.jsonl"));
  await runUsageIndex({ homeDirectory: home, indexPath, budgetMs: 10_000 });
  claude = byAgent(usageSummary(await loadUsageIndex(indexPath), { days: 30 })).claude;
  assert.equal(claude.tokens.total, 256, "aggregates outlive the transcript");
  assert.equal(claude.sessions, 2);

  // A zero budget still makes progress: every run indexes at least one file.
  const slicedPath = path.join(home, "sliced-index.json");
  let runs = 0;
  let result;
  do {
    result = await runUsageIndex({ homeDirectory: home, indexPath: slicedPath, budgetMs: 0 });
    runs += 1;
  } while (result.state !== "complete" && runs < 20);
  assert.equal(result.state, "complete");
  assert.ok(runs > 1);
  assert.equal(result.indexedFiles, result.files);
  const sliced = byAgent(usageSummary(await loadUsageIndex(slicedPath), { days: 30 }));
  assert.equal(sliced.codex.tokens.total, 1_680);
});

test("the usage service indexes in a worker and reports progress", async (context) => {
  const { home, indexPath } = await setup(context);
  const service = createUsageService({ homeDirectory: home, indexPath, budgetMs: 2_000 });
  context.after(() => service.stop());
  assert.equal(service.status().state, "idle");
  const result = await service.runToCompletion();
  assert.equal(result.state, "complete");
  assert.equal(service.status().indexedFiles, service.status().totalFiles);
  assert.ok(service.status().totalFiles >= 6);
  const index = await service.getIndex();
  assert.equal(byAgent(usageSummary(index, { days: 30 })).codex.tokens.total, 1_680);
});
