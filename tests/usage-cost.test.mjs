import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { compileTable } from "../server/pricing.mjs";
import { priceRows } from "../server/usage-cost.mjs";
import { loadUsageIndex, runUsageIndex, USAGE_INDEX_VERSION } from "../server/usage-index.mjs";
import { costIndex } from "../server/usage-cost.mjs";
import { agentProjects, costProjects } from "../server/usage-projects.mjs";
import { usageForAgent, usageForSkill, usageModels, usageProjects, usageSummary } from "../server/usage-query.mjs";
import { writeFixtureFile } from "./fixtures/smartorder.mjs";

const line = (value) => `${JSON.stringify(value)}\n`;
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} ≠ ${expected}`);

/** The latest past moment at `hour`:30 UTC on an ISO weekday (1 = Monday), within the last 8 days. */
function recentUtc(weekday, hour) {
  for (let back = 1; back <= 8; back += 1) {
    const date = new Date(Date.now() - back * 86_400_000);
    date.setUTCHours(hour, 30, 0, 0);
    if ((date.getUTCDay() || 7) === weekday) return date;
  }
  throw new Error("unreachable");
}
const OFF_PEAK = recentUtc(6, 12); // Saturday noon UTC
const PEAK = recentUtc(3, 2); // Wednesday 02:30 UTC
const recent = new Date(Date.now() - 3_600_000).toISOString();

async function createPricedHome(home) {
  const claude = path.join(home, ".claude", "projects", "-work-priced");
  const assistant = (id, model, usage, extra = {}) => ({ type: "assistant", timestamp: recent, cwd: "/work/priced", message: { id, model, usage, content: [] }, ...extra });
  await writeFixtureFile(claude, "c1.jsonl", [
    // Fast mode, 1-hour cache writes, attributed to a skill.
    assistant("c_1", "claude-opus-5-5", {
      input_tokens: 1_000,
      output_tokens: 2_000,
      cache_read_input_tokens: 10_000,
      cache_creation_input_tokens: 3_000,
      cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 2_000 },
      speed: "fast",
    }, { attributionSkill: "pdf" }),
    // No split in the log: every write at the 5-minute price. Prompt 300K: no long tier for Claude.
    assistant("c_2", "claude-sonnet-5-5", { input_tokens: 100, output_tokens: 100, cache_read_input_tokens: 298_900, cache_creation_input_tokens: 1_000 }),
    assistant("c_3", "<synthetic>", { input_tokens: 0, output_tokens: 0 }),
  ].map(line).join(""));

  const total = (input, cached, write, output) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: write, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });
  const add = (left, right) => Object.fromEntries(Object.keys(left).map((key) => [key, left[key] + right[key]]));
  const t1 = total(300_000, 200_000, 50_000, 10_000);
  const t2 = add(t1, total(1_000, 0, 0, 100));
  const t3 = add(t2, total(272_000, 0, 0, 0));
  const event = (totals, last) => ({ timestamp: recent, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: totals, last_token_usage: last } } });
  const turn = (model) => ({ timestamp: recent, type: "turn_context", payload: { model, cwd: "/work/priced" } });
  await writeFixtureFile(home, ".codex/sessions/2026/10/06/rollout-2026-10-06T10-00-00-cccc.jsonl", [
    { timestamp: recent, type: "session_meta", payload: { id: "c", cwd: "/work/priced" } },
    turn("gpt-6.1-sol"),
    event(t1, t1), // prompt 300K → above 272K: the whole request at the long price
    turn("gpt-5.4-mini"),
    event(t2, total(1_000, 0, 0, 100)),
    turn("gpt-6.1-sol"),
    event(t3, total(272_000, 0, 0, 0)), // exactly 272K: still the base price
  ].map(line).join(""));
  // A resumed session reports usage before its first turn_context: it moves to that model.
  const first = total(1_000, 0, 0, 10);
  await writeFixtureFile(home, ".codex/sessions/2026/10/06/rollout-2026-10-06T11-00-00-dddd.jsonl", [
    { timestamp: recent, type: "session_meta", payload: { id: "d", cwd: "/work/priced" } },
    event(first, first),
    turn("gpt-6-sol"),
    event(add(first, first), first),
  ].map(line).join(""));

  const workBuddy = (id, model, timestamp, usage) => ({ type: "message", timestamp, providerData: { messageId: id, model }, message: { usage } });
  await writeFixtureFile(home, ".workbuddy/projects/p/w1.jsonl", [
    workBuddy("w_1", "deepseek-v4-pro", OFF_PEAK.toISOString(), { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 0 }),
    workBuddy("w_2", "deepseek-v4-pro", PEAK.toISOString(), { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 0 }),
    workBuddy("w_3", "auto", recent, { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 0 }),
    workBuddy("w_4", "mystery-model", recent, { input_tokens: 70, output_tokens: 7 }),
  ].map(line).join(""));

  const { DatabaseSync } = await import("node:sqlite");
  await mkdir(path.join(home, ".hermes"), { recursive: true });
  const database = new DatabaseSync(path.join(home, ".hermes", "state.db"));
  database.exec(
    "CREATE TABLE sessions (id TEXT, started_at REAL, model TEXT, billing_provider TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL, api_call_count INTEGER)",
  );
  const insert = database.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  insert.run("h1", Date.now() / 1000 - 3_600, "gpt-5.5", "openai-codex", 1_000, 100, 0, 0, 40, 0.5, 0, 3);
  insert.run("h2", Date.now() / 1000 - 7_200, null, null, 500, 50, 0, 0, 0, 0.25, 0, 1);
  insert.run("h3", OFF_PEAK.getTime() / 1000, "deepseek-v4-pro", "deepseek", 1_000_000, 0, 0, 0, 0, 0, 0, 1);
  database.close();
}

async function setup(context) {
  const home = await mkdtemp(path.join(tmpdir(), "usage-cost-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await createPricedHome(home);
  const indexPath = path.join(home, ".agent-skill-manager", "usage-index.json");
  assert.equal((await runUsageIndex({ homeDirectory: home, indexPath, budgetMs: 10_000 })).state, "complete");
  return { home, index: await loadUsageIndex(indexPath) };
}

const fileOf = (index, agentId, model = null) => Object.values(index.files).find((entry) => entry.a === agentId && (!model || entry.m?.[model]));
const buckets = (entry, model) => Object.values(entry.m[model]).flatMap((byBucket) => Object.entries(byBucket));

test("the index keeps tokens per model, day and price bucket", async (context) => {
  const { index } = await setup(context);
  assert.equal(index.version, USAGE_INDEX_VERSION);
  const claude = fileOf(index, "claude");
  assert.deepEqual(buckets(claude, "claude-opus-5-5"), [["s:fast", [1_000, 2_000, 10_000, 1_000, 2_000, 1]]]);
  assert.deepEqual(buckets(claude, "claude-sonnet-5-5"), [["l272", [100, 100, 298_900, 1_000, 0, 1]]]);
  assert.equal(claude.m["<synthetic>"], undefined);
  assert.deepEqual(Object.keys(claude.km.pdf), ["claude-opus-5-5"]);
  const codex = fileOf(index, "codex", "gpt-6.1-sol");
  // input_tokens includes cached reads and cache writes: 300000 − 200000 − 50000 uncached.
  assert.deepEqual(buckets(codex, "gpt-6.1-sol"), [["l272", [50_000, 10_000, 200_000, 50_000, 0, 1]], ["l200", [272_000, 0, 0, 0, 0, 1]]]);
  assert.deepEqual(buckets(codex, "gpt-5.4-mini"), [["s", [1_000, 100, 0, 0, 0, 1]]]);
  const resumed = fileOf(index, "codex", "gpt-6-sol");
  assert.deepEqual(buckets(resumed, "gpt-6-sol"), [["s", [2_000, 20, 0, 0, 0, 2]]]);
  assert.equal(resumed.m.unknown, undefined, "nothing left under unknown");
  assert.equal(resumed.st.codexPending, undefined);
  const workBuddy = fileOf(index, "workbuddy");
  // 1M-token prompts land in the >512K tier; DeepSeek has no long price, only the off-peak flag matters.
  assert.deepEqual(buckets(workBuddy, "deepseek-v4-pro").map(([bucket]) => bucket).sort(), ["l512", "l512:off"]);
  assert.deepEqual(buckets(workBuddy, "auto").map(([bucket]) => bucket), ["l512"]);
  const hermes = Object.values(index.records.hermes);
  assert.deepEqual(hermes.map((record) => [record.m, record.b, record.rc, record.n]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))), [
    ["deepseek-v4-pro", "s:off", 0, 1],
    ["gpt-5.5", "s", 0.5, 3],
    [null, "s", 0.25, 1],
  ]);
});

test("costs: official prices per rule, agent averages, families, reported figures and unpriced tokens", async (context) => {
  const { index } = await setup(context);
  const summary = usageSummary(index, { days: 30 });
  const agents = Object.fromEntries(summary.agents.map((agent) => [agent.agentId, agent]));

  // Claude: Opus fast = 2 × (1000×4 + 2000×20 + 10000×0.2 + 1000×5 + 2000×8) = 134000;
  // Sonnet = 100×2 + 100×10 + 298900×0.2 + 1000×2.5 = 63480.
  near(agents.claude.costUsd, 0.19748, "claude");
  const opus = agents.claude.byModel.find((row) => row.model === "claude-opus-5-5");
  assert.deepEqual(opus.tokens, { input: 1_000, output: 2_000, cacheRead: 10_000, cacheWrite: 1_000, cacheWrite1h: 2_000, total: 16_000 });
  assert.deepEqual([opus.name, opus.vendor, opus.basis, opus.requests, opus.costUsd, opus.longShare], ["Claude Opus 5.5", "anthropic", "official", 1, 0.134, 0]);
  assert.deepEqual(opus.priceRef, { section: "models", id: "claude-opus-5-5" });

  // Codex: GPT-6.1 Sol long = 50000×4 + 10000×15 + 200000×0.2 + 50000×5 = 640000, at 272K exactly
  // 272000×2 = 544000; GPT-5.4 mini = 1000×0.75 + 100×4.5 = 1200; GPT-6 Sol 2 × (1000×2 + 10×10) = 4200.
  near(agents.codex.costUsd, 1.1894, "codex");
  const sol = agents.codex.byModel.find((row) => row.model === "gpt-6.1-sol");
  assert.deepEqual([sol.costUsd, sol.longShare], [1.184, Math.round((310_000 / 582_000) * 1_000) / 1_000]);

  // WorkBuddy: DeepSeek V4 Pro off-peak 0.66 + 1.98, peak 1.32 + 3.96; "auto" at their token-weighted
  // average (input 0.99, output 2.97 per 1M) = 3.96; the unknown id stays unpriced.
  near(agents.workbuddy.costBasis.official, 7.92, "workbuddy official");
  near(agents.workbuddy.costBasis.estimate, 3.96, "workbuddy auto");
  assert.equal(agents.workbuddy.unpricedTokens, 77);
  const auto = agents.workbuddy.byModel.find((row) => row.model === "auto");
  assert.deepEqual([auto.basis, auto.priceAs, auto.unitPrice.input, auto.unitPrice.output, auto.priceRef.section], ["estimate", "@agent-average", 0.99, 2.97, "estimates"]);

  // Hermes: GPT-5.5 at official prices (1000×5 + 100×30), DeepSeek off-peak (1M × 0.66), the session
  // without a model at its own reported figure. The reported total stays visible.
  near(agents.hermes.costUsd, 0.008 + 0.66 + 0.25, "hermes");
  assert.deepEqual(agents.hermes.costBasis, { official: 0.668, estimate: 0, family: 0, reported: 0.25 });
  assert.equal(agents.hermes.reportedCostUsd, 0.75);

  near(summary.cost.costUsd, agents.claude.costUsd + agents.codex.costUsd + agents.workbuddy.costUsd + agents.hermes.costUsd, "total");
  assert.equal(summary.cost.unpricedTokens, 77);
  near(summary.agents.find((agent) => agent.agentId === "codex").series.at(-1).costUsd + summary.agents.find((agent) => agent.agentId === "codex").series.at(-2).costUsd, 1.1894, "series");

  const skill = usageForSkill(index, "pdf", { days: 30 }).agents[0];
  assert.deepEqual([skill.agentId, skill.costUsd, skill.byModel[0].model], ["claude", 0.134, "claude-opus-5-5"]);
  assert.equal(summary.topSkills.find((item) => item.name === "pdf").costUsd, 0.134);

  const agent = usageForAgent(index, "workbuddy", { days: 30 });
  assert.deepEqual(Object.keys(agent.totals).sort(), ["activeDays", "costBasis", "costUsd", "sessions", "sessionsStarted", "tokens", "unpricedTokens"]);
  assert.ok(agent.byModel.length === 3 && agent.series.every((day) => typeof day.costUsd === "number"));
  assert.equal(usageForAgent(index, "hermes", { days: 30 }).totals.reportedCostUsd, 0.75);
});

test("GET /api/usage/models shape: one row per model and basis, with the agents that used it", async (context) => {
  const { index } = await setup(context);
  const result = usageModels(index, { days: 30 });
  assert.deepEqual(Object.keys(result).sort(), ["generatedAt", "index", "models", "pricingStale", "pricingTable", "totals", "unpriced", "windowDays", "windowLabel"]);
  assert.deepEqual(Object.keys(result.pricingTable).sort(), ["ageDays", "checkedAt", "reviewAfterDays", "stale"]);
  assert.deepEqual(result.unpriced, ["mystery-model"]);
  const deepseek = result.models.find((row) => row.model === "deepseek-v4-pro");
  assert.deepEqual(deepseek.agents.map((item) => item.agentId), ["workbuddy", "hermes"]);
  near(deepseek.costUsd, 7.92 + 0.66, "deepseek");
  assert.deepEqual(Object.keys(deepseek).sort(), ["agents", "basis", "costUsd", "longShare", "model", "name", "priceRef", "requests", "tokens", "vendor"]);
  const unknown = result.models.find((row) => row.model === "unknown");
  assert.deepEqual([unknown.basis, unknown.costUsd, unknown.agents[0].agentId], ["reported", 0.25, "hermes"], "a session without a model keeps its own figure");
  near(result.totals.costUsd, usageSummary(index, { days: 30 }).cost.costUsd, "totals");
});

test("project costs: priced like the agent totals, unnamed sessions included, totals reconcile", async (context) => {
  const { index } = await setup(context);
  const summary = usageSummary(index, { days: 30 });
  const agentCost = (agentId) => summary.agents.find((agent) => agent.agentId === agentId).costUsd;
  // WorkBuddy and Hermes sessions here have no working folder: one unnamed project each.
  const workBuddy = usageForAgent(index, "workbuddy", { days: 30 });
  assert.deepEqual(workBuddy.topProjects.map((project) => [project.name, project.sessions]), [[null, 1]]);
  near(workBuddy.topProjects[0].costUsd, agentCost("workbuddy"), "workbuddy project = agent total (auto at the agent average)");
  assert.equal(workBuddy.topProjects[0].unpricedTokens, 77);
  const claude = usageForAgent(index, "claude", { days: 30 }).topProjects[0];
  assert.deepEqual([claude.name, claude.tokenSplit], ["priced", { input: 1_100, output: 2_100, cacheRead: 308_900, cacheWrite: 2_000, cacheWrite1h: 2_000 }]);
  assert.deepEqual(claude.topModels.map((model) => model.model), ["claude-opus-5-5", "claude-sonnet-5-5"]);

  const result = usageProjects(index, { days: 30 });
  assert.deepEqual(Object.keys(result).sort(), ["generatedAt", "index", "other", "projects", "totals", "windowDays", "windowLabel"]);
  // WorkBuddy's DeepSeek and "auto" tokens make the unnamed project the most expensive one.
  assert.deepEqual(result.projects.map((project) => project.name), [null, "priced"]);
  const priced = result.projects[1];
  assert.deepEqual(Object.keys(priced).sort(), ["agents", "costBasis", "costUsd", "name", "sessions", "sessionsStarted", "tokens", "topModels", "unpricedTokens"]);
  assert.deepEqual(priced.agents.map((agent) => agent.agentId), ["codex", "claude"]);
  near(priced.costUsd, agentCost("codex") + agentCost("claude"), "priced");
  assert.deepEqual(priced.topModels.map((model) => model.model), ["gpt-6.1-sol", "claude-opus-5-5", "claude-sonnet-5-5"]);
  assert.deepEqual(result.projects[0].agents.map((agent) => agent.agentId), ["workbuddy", "hermes"]);
  near(result.projects.reduce((sum, project) => sum + project.costUsd, 0) + result.other.costUsd, result.totals.costUsd, "projects add up");
  assert.deepEqual(result.other, { count: 0, costUsd: 0, tokens: 0 });

  // Past the row limit the rest is summed, so the list still reconciles.
  const inWindow = () => true;
  const projects = costProjects(index, inWindow, costIndex(index, inWindow));
  const limited = agentProjects([...projects.values()].flat(), 1);
  assert.equal(limited.topProjects.length, 1);
  assert.equal(limited.otherProjects.count, 3);
  near(limited.topProjects[0].costUsd + limited.otherProjects.costUsd, result.totals.costUsd, "limited");
});

test("an agent average with nothing to average: fallback model, then family, then reported, then unpriced", () => {
  const rows = (model) => new Map([[model, [{ day: "2026-10-06", bucket: "s", row: [1_000_000, 0, 0, 0, 0, 1] }]]]);
  const record = { model: "auto", day: "2026-10-06", bucket: "s", row: [1_000_000, 0, 0, 0, 0, 1], reported: 0.5 };
  // Bundled table: WorkBuddy "auto" falls back to GLM-5.2 (1M input × 1.4).
  const alone = priceRows("workbuddy", { rows: rows("auto") }).byModel[0];
  assert.deepEqual([alone.basis, alone.priceAs, alone.costUsd, alone.priceRef], ["estimate", "glm-5.2", 1.4, { section: "estimates", id: "auto" }]);
  assert.equal(priceRows("workbuddy", { records: [record] }).costBasis.estimate, 1.4, "the fallback comes before the reported figure");

  const model = (id, input) => ({ id, vendor: "x", input, output: input });
  const custom = (estimate, families = []) =>
    compileTable({ schedules: {}, models: [model("base", 1), model("fam", 2)], estimates: [{ id: "auto", priceAs: "@agent-average", ...estimate }], families });
  const withFallback = priceRows("any", { rows: rows("auto") }, { table: custom({ fallback: "base" }, [{ id: "f", match: "^auto", priceAs: "fam" }]) });
  assert.deepEqual([withFallback.byModel[0].priceAs, withFallback.costUsd], ["base", 1], "fallback before family");
  const family = priceRows("any", { rows: rows("auto") }, { table: custom({}, [{ id: "f", match: "^auto", priceAs: "fam" }]) });
  assert.deepEqual([family.byModel[0].basis, family.byModel[0].priceAs, family.costBasis.family], ["family", "fam", 2]);
  const reported = priceRows("any", { records: [record] }, { table: custom({}) });
  assert.deepEqual([reported.costUsd, reported.costBasis.reported], [0.5, 0.5]);
  const unpriced = priceRows("any", { rows: rows("auto") }, { table: custom({}) });
  assert.deepEqual([unpriced.costUsd, unpriced.unpricedTokens, unpriced.byModel[0].basis], [0, 1_000_000, "unpriced"]);
  const opus = priceRows("claude", { rows: rows("claude-opus-9") });
  assert.deepEqual([opus.byModel[0].basis, opus.byModel[0].priceAs, opus.costBasis.family], ["family", "claude-opus-5-5", 4]);
});
