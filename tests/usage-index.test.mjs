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
  // Estimated cost at official prices, per model (USD per 1M tokens in the price table):
  // Opus 5.5 10×4 + 5×20 + 100×0.2 + 5×5 (5 min) + 15×8 (1 h) = 305, Sonnet 5.5 22, Haiku 4.5 22.
  assert.equal(agents.claude.costUsd, 0.000349);
  assert.deepEqual(agents.claude.costBasis, { official: 0.000349, estimate: 0, family: 0, reported: 0 });
  assert.equal(agents.claude.unpricedTokens, 8, "the credential-shaped model id is stored as unknown");
  assert.deepEqual(agents.claude.byModel.map((row) => [row.model, row.basis]), [
    ["claude-opus-5-5", "official"],
    ["claude-haiku-4-5-20251001", "official"],
    ["claude-sonnet-5-5", "official"],
    ["unknown", "unpriced"],
  ]);
  // Codex: GPT-5.5 for the first file's turns (2900 + 2500), the fork's auto-review at GPT-5.6 Luna.
  assert.deepEqual([agents.codex.costUsd, agents.codex.costBasis.official, agents.codex.costBasis.estimate], [0.00542, 0.0054, 0.00002]);
  // WorkBuddy: GLM-5.2 = 100×1.4 + 200×0.26 + 20×4.4 = 280; "auto" at that average = 50×1.4 + 5×4.4 = 92.
  assert.deepEqual([agents.workbuddy.costUsd, agents.workbuddy.costBasis.estimate], [0.000372, 0.000092]);
  assert.equal(agents.workbuddy.byModel.find((row) => row.model === "auto").priceAs, "@agent-average");
  // Hermes state.db and OpenClaw sessions.json: sessions inside the window only; without a
  // model the products' own cost figures are used.
  assert.equal(agents.hermes.sessions, 2);
  assert.equal(agents.hermes.tokens.total, 4_600);
  assert.equal(agents.hermes.costUsd, 0.42);
  assert.deepEqual([agents.hermes.costBasis.reported, agents.hermes.reportedCostUsd], [0.42, 0.42]);
  assert.deepEqual([agents.openclaw.costUsd, agents.openclaw.costBasis.reported], [0.2, 0.2]);
  assert.equal(agents.openclaw.sessions, 1);
  assert.equal(agents.openclaw.tokens.total, 1_500);
  assert.equal(agents.claude.series.length, 30);
  assert.ok(agents.claude.sources.some((source) => source.confidence === "exact"));

  const summary = usageSummary(index, { days: 30 });
  const skill = (name) => summary.topSkills.find((item) => item.name === name);
  assert.deepEqual(skill("pdf").agents.map((item) => [item.agentId, item.count, item.confidence]), [["claude", 1, "exact"]]);
  assert.equal(skill("pdf").tokens, 135);
  assert.equal(skill("pdf").costUsd, 0.000305, "attributed tokens are priced by model");
  assert.equal(skill("xlsx").costUsd, null, "no token attribution, no cost");
  assert.deepEqual(skill("lark-doc").agents.map((item) => [item.agentId, item.confidence]), [["codex", "inferred"]]);
  assert.equal(skill("output-only"), undefined, "tool outputs are never inspected");
  assert.deepEqual(skill("xlsx").agents.map((item) => [item.agentId, item.count]), [["workbuddy", 1]]);
  assert.deepEqual(skill("managed-skill").agents.map((item) => [item.agentId, item.confidence]), [["openclaw", "inferred"]]);

  const hermesSkill = usageForSkill(index, "flat-skill", { days: 90 });
  assert.deepEqual(hermesSkill.agents.map((item) => [item.agentId, item.reportedTotal, item.confidence]), [["hermes", 7, "reported"]]);
  const codex = usageForAgent(index, "codex", { days: 90 });
  assert.deepEqual(codex.topProjects, [
    {
      // Cache rate: 1,000 cached of 1,600 prompt tokens.
      cacheHitRate: 0.625,
      cacheWriteShare: 0,
      name: "beta-project",
      sessions: 2,
      sessionsStarted: 2,
      tokens: 1_680,
      tokenSplit: { input: 600, output: 80, cacheRead: 1_000, cacheWrite: 0, cacheWrite1h: 0 },
      costUsd: 0.00542,
      costBasis: { official: 0.0054, estimate: 0.00002, family: 0, reported: 0 },
      unpricedTokens: 0,
      topModels: [
        { model: "gpt-5.5", name: "GPT-5.5", costUsd: 0.0054 },
        { model: "codex-auto-review", name: "codex-auto-review", costUsd: 0.00002 },
      ],
    },
  ]);
  assert.deepEqual(codex.otherProjects, { count: 0, costUsd: 0, tokens: 0 });
  // Hermes sessions without a working folder form the unnamed project.
  assert.deepEqual(usageForAgent(index, "hermes", { days: 30 }).topProjects.map((project) => [project.name, project.sessions, project.costUsd]), [[null, 2, 0.42]]);
  assert.equal(codex.series.length, 90);
  assert.equal(usageForAgent(index, "workbuddy", { days: 30 }).topProjects[0].name, "gamma-project");

  const stored = await readFile(indexPath, "utf8");
  assert.doesNotMatch(stored, /MSGTEXT|ZZ9/u, "no message text, arguments, titles or credential-shaped ids in the index");
  const claudeFile = Object.values(index.files).find((entry) => entry.m?.["claude-opus-5-5"]);
  assert.deepEqual(Object.values(claudeFile.m["claude-opus-5-5"])[0], { s: [10, 5, 100, 5, 15, 1] });
  assert.deepEqual(Object.keys(Object.values(claudeFile.km.pdf["claude-opus-5-5"])[0]), ["s"]);
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
