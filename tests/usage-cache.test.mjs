import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { publicPriceTable } from "../server/pricing.mjs";
import { cacheBySession, cacheRates } from "../server/usage-cache.mjs";
import { loadUsageIndex, runUsageIndex } from "../server/usage-index.mjs";
import { usageForAgent, usageModels, usageProjects, usageSummary, usageTotals } from "../server/usage-query.mjs";
import { writeFixtureFile } from "./fixtures/smartorder.mjs";

const line = (value) => `${JSON.stringify(value)}\n`;
const at = (minutes) => new Date(Date.now() - 86_400_000 - minutes * 60_000).toISOString();

/** Claude: one main session (90% cached) with a subagent transcript, one cold session; Codex: one rollout, one DB-only thread. */
async function createCacheHome(home) {
  const claude = path.join(home, ".claude", "projects", "-work-cache-app");
  const assistant = (id, minutes, usage) => ({ type: "assistant", timestamp: at(minutes), cwd: "/work/cache-app", message: { id, model: "claude-sonnet-5-5", usage } });
  await writeFixtureFile(claude, "warm.jsonl", line(assistant("w1", 10, { input_tokens: 50, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 100 })));
  await writeFixtureFile(claude, "warm/subagents/agent-1.jsonl", line(assistant("w2", 9, { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 10 })));
  await writeFixtureFile(claude, "cold.jsonl", line(assistant("c1", 8, { input_tokens: 800, cache_read_input_tokens: 0, cache_creation_input_tokens: 200, output_tokens: 10 })));
  const usage = { input_tokens: 1_000, cached_input_tokens: 750, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 0, total_tokens: 1_050 };
  await writeFixtureFile(home, ".codex/sessions/2026/10/20/rollout-a.jsonl", [
    { timestamp: at(5), type: "session_meta", payload: { id: "a", cwd: "/work/cache-app" } },
    { timestamp: at(5), type: "turn_context", payload: { model: "gpt-5.4-mini" } },
    { timestamp: at(5), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usage, last_token_usage: usage } } },
  ].map(line).join(""));
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(path.join(home, ".codex", "state_5.sqlite"));
  database.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, model TEXT, cwd TEXT, tokens_used INTEGER, source TEXT)");
  database.prepare("INSERT INTO threads VALUES ('gone', ?, ?, ?, 'gpt-5.4-mini', '/work/cache-app', 100000, 'vscode')").run(path.join(home, ".codex/sessions/2026/10/19/rollout-gone.jsonl"), Math.floor(Date.now() / 1000) - 86_400, Math.floor(Date.now() / 1000) - 86_400);
  database.close();
}

test("cache hit rate = cache reads / (uncached input + cache reads + cache writes), per agent, model, project and session", { timeout: 30_000 }, async (context) => {
  const home = await mkdtemp(path.join(tmpdir(), "usage-cache-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await createCacheHome(home);
  const indexPath = path.join(home, "index.json");
  await runUsageIndex({ homeDirectory: home, indexPath, budgetMs: 10_000 });
  const index = await loadUsageIndex(indexPath);

  assert.deepEqual(cacheRates({ input: 50, cacheRead: 900, cacheWrite: 50 }), { cacheHitRate: 0.9, cacheWriteShare: 0.05 });
  assert.deepEqual(cacheRates({ input: 0, cacheRead: 0, cacheWrite: 0 }), { cacheHitRate: null, cacheWriteShare: null });

  const summary = usageSummary(index, { days: 7 });
  const claude = summary.agents.find((agent) => agent.agentId === "claude");
  // Claude prompt tokens: 1,000 + 1,000 + 1,000; reads 1,800; writes 250.
  assert.deepEqual([claude.cacheHitRate, claude.cacheWriteShare], [0.6, 0.0833]);
  assert.equal(claude.byModel[0].cacheHitRate, 0.6);
  // Per conversation: the warm session (with its subagent: 1,800 / 2,000) and the cold one (0).
  assert.deepEqual(claude.cacheBySession, { sessions: 2, median: 0, p10: 0, p90: 0.9, lowSessions: 1, excludedSessions: 0 });
  // Codex: the measured rollout only (750 / 1,000); the database thread is excluded everywhere.
  const codex = summary.agents.find((agent) => agent.agentId === "codex");
  assert.equal(codex.cacheHitRate, 0.75);
  assert.deepEqual(codex.cacheBySession, { sessions: 1, median: 0.75, p10: 0.75, p90: 0.75, lowSessions: 0, excludedSessions: 1 });
  assert.deepEqual(codex.byModel.filter((row) => row.basis === "estimate").map((row) => row.cacheHitRate), [null]);

  const totals = usageTotals(index).windows.find((window) => window.id === "7");
  assert.equal(totals.cacheHitRate, Math.round(((1_800 + 750) / (3_000 + 1_000)) * 10_000) / 10_000);
  assert.equal(totals.byAgent.find((row) => row.agentId === "claude").cacheBySession.sessions, 2);
  const agent = usageForAgent(index, "claude", { days: 7 });
  assert.deepEqual([agent.totals.cacheHitRate, agent.totals.cacheBySession.median, agent.byModel[0].cacheWriteShare], [0.6, 0, 0.0833]);
  assert.equal(agent.topProjects[0].cacheHitRate, 0.6);
  const models = usageModels(index, { days: 7 }).models;
  assert.equal(models.find((row) => row.model === "claude-sonnet-5-5").cacheHitRate, 0.6);
  const project = usageProjects(index, { days: 7 }).projects.find((row) => row.name === "cache-app");
  assert.equal(project.cacheHitRate, totals.cacheHitRate, "the project holds every measured session");
  assert.equal(cacheBySession(index, () => false).size, 0);

  const rule = publicPriceTable().rules.cacheRate;
  assert.match(rule.text, /缓存率/u);
  assert.equal(rule.formula, "cacheRead / (input + cacheRead + cacheWrite)");
  assert.ok(rule.links.every((link) => link.url.startsWith("https://")));
});
