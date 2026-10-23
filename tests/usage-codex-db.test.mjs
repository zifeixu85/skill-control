import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CODEX_DB_REASON } from "../server/usage-cost.mjs";
import { loadUsageIndex, runUsageIndex, splitByMix } from "../server/usage-index.mjs";
import { usageForAgent, usageSummary, usageTotals } from "../server/usage-query.mjs";
import { dayKey } from "../server/usage-sources.mjs";
import { writeFixtureFile } from "./fixtures/smartorder.mjs";

const line = (value) => `${JSON.stringify(value)}\n`;
const daysAgo = (days) => Date.now() - days * 86_400_000;
const total = (input, cached, output) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });

/** A rollout with one gpt-5.4-mini turn: input 400 (+600 cached) and output 200. */
async function writeRollout(home, name, at = new Date(daysAgo(2)).toISOString()) {
  const usage = total(1_000, 600, 200);
  const relative = `.codex/sessions/2026/10/20/${name}`;
  await writeFixtureFile(home, relative, [
    { timestamp: at, type: "session_meta", payload: { id: name, cwd: "/work/live-project" } },
    { timestamp: at, type: "turn_context", payload: { model: "gpt-5.4-mini", cwd: "/work/live-project" } },
    { timestamp: at, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usage, last_token_usage: usage } } },
  ].map(line).join(""));
  return path.join(home, relative);
}

/** Codex's state_5.sqlite (titles, first messages and previews carry planted secrets) and history DB. */
async function writeStateDatabase(home, threads, edges = []) {
  const { DatabaseSync } = await import("node:sqlite");
  await writeFixtureFile(home, ".codex/.keep", "");
  const database = new DatabaseSync(path.join(home, ".codex", "state_5.sqlite"));
  database.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, model_provider TEXT, cwd TEXT,
    title TEXT, tokens_used INTEGER, archived INTEGER, first_user_message TEXT, agent_role TEXT, model TEXT, agent_path TEXT, created_at_ms INTEGER, updated_at_ms INTEGER,
    thread_source TEXT, preview TEXT, history_mode TEXT);
    CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT);`);
  const insert = database.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, 'openai', ?, ?, ?, 0, ?, NULL, ?, NULL, ?, ?, ?, ?, 'paginated')");
  for (const thread of threads) {
    insert.run(thread.id, thread.rollout, Math.floor(thread.created / 1000), Math.floor(thread.updated / 1000), thread.source || "vscode", thread.cwd || `${home}/work/db-project`,
      "ZZ9title01 secret plan", thread.tokens, "my key is sk-ZZ9firstmessage0123456789", thread.model, thread.created, thread.updated, thread.source ? "subagent" : "user", "ZZ9preview03");
  }
  const edge = database.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?, 'closed')");
  for (const [parent, child] of edges) edge.run(parent, child);
  database.close();
  const history = new DatabaseSync(path.join(home, ".codex", "thread_history_1.sqlite"));
  history.exec("CREATE TABLE thread_items (thread_id TEXT, item_json TEXT, item_type TEXT); INSERT INTO thread_items VALUES ('gone-root', '{\"text\":\"ZZ9itemjson04\"}', 'agentMessage');");
  history.close();
}

const sessions = (home) => path.join(home, ".codex", "sessions", "2026", "10", "20");

test("Codex threads whose rollout is gone become estimated records; indexed ones and subagent totals are not counted twice", { timeout: 30_000 }, async (context) => {
  const home = await mkdtemp(path.join(tmpdir(), "usage-codex-db-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  // Indexed earlier, then deleted by Codex: the index keeps it, the database row must not add it again.
  const old = await writeRollout(home, "rollout-old.jsonl");
  const indexPath = path.join(home, "index.json");
  await runUsageIndex({ homeDirectory: home, indexPath, budgetMs: 10_000 });
  await rm(old);
  const live = await writeRollout(home, "rollout-live.jsonl");
  await writeStateDatabase(
    home,
    [
      { id: "live", rollout: live, created: daysAgo(2), updated: daysAgo(2), model: "gpt-5.4-mini", tokens: 1_200 },
      { id: "old", rollout: old, created: daysAgo(2), updated: daysAgo(2), model: "gpt-5.4-mini", tokens: 1_200 },
      { id: "gone-root", rollout: path.join(sessions(home), "rollout-gone.jsonl"), created: daysAgo(3), updated: daysAgo(1), model: "gpt-5.4-mini", tokens: 12_000 },
      { id: "gone-child", rollout: path.join(sessions(home), "rollout-child.jsonl"), created: daysAgo(3), updated: daysAgo(3), model: "gpt-5.4-mini", tokens: 50_000, source: '{"subagent":{"thread_spawn":{"depth":1}}}' },
      { id: "gone-other", rollout: path.join(sessions(home), "rollout-other.jsonl"), created: daysAgo(40), updated: daysAgo(40), model: "gpt-6.1-sol", tokens: 6_000 },
    ],
    [["gone-root", "gone-child"]],
  );
  await runUsageIndex({ homeDirectory: home, indexPath, budgetMs: 10_000 });
  const index = await loadUsageIndex(indexPath);
  const records = Object.values(index.records.codex);
  assert.equal(records.length, 3, "live and already-indexed threads are skipped");
  const byTotal = (value) => records.find((record) => record.t[4] === value);
  // gone-root: the model's own mix (400 / 200 / 600 / 0 of 1,200) applied to 12,000; created day, updated day as the end day.
  assert.deepEqual(byTotal(12_000).t, [4_000, 2_000, 6_000, 0, 12_000]);
  assert.deepEqual([byTotal(12_000).d, byTotal(12_000).e, byTotal(12_000).p, byTotal(12_000).x], [dayKey(daysAgo(3)), dayKey(daysAgo(1)), "db-project", "codex-db"]);
  // A model without its own mix uses the overall Codex mix.
  assert.deepEqual(byTotal(6_000).t, [2_000, 1_000, 3_000, 0, 6_000]);
  // The subagent counts as a session; its total (which includes the parent's context) is kept aside.
  const child = records.find((record) => record.i);
  assert.deepEqual([child.t, child.i], [[0, 0, 0, 0, 0], 50_000]);

  const summary = usageSummary(index, { days: 30 });
  const codex = summary.agents.find((agent) => agent.agentId === "codex");
  assert.equal(codex.tokens.total, 1_200 + 1_200 + 12_000, "old rollout + live rollout + gone-root (gone-other is outside 30 days)");
  assert.equal(codex.sessionsStarted, 4);
  const estimated = codex.byModel.find((row) => row.basis === "estimate");
  assert.deepEqual([estimated.model, estimated.reason, estimated.tokens.total], ["gpt-5.4-mini", CODEX_DB_REASON, 12_000]);
  assert.ok(estimated.costUsd > 0 && codex.costBasis.estimate === estimated.costUsd);
  assert.ok(codex.byModel.some((row) => row.model === "gpt-5.4-mini" && row.basis === "official"), "indexed rollouts stay official");
  const [note] = codex.notes;
  assert.deepEqual([note.kind, note.sessions, note.tokens, note.spawnedSessions, note.uncountedTokens], ["codex-db-estimate", 2, 12_000, 1, 50_000]);
  assert.match(note.text, new RegExp(CODEX_DB_REASON, "u"));
  assert.match(note.text, /子代理线程/u);
  assert.equal(usageSummary(index, { days: null }).agents.find((agent) => agent.agentId === "codex").tokens.total, 20_400);
  assert.equal(usageForAgent(index, "codex", { days: 7 }).notes[0].sessions, 2);
  assert.ok(usageTotals(index).windows.find((window) => window.id === "all").byAgent.find((row) => row.agentId === "codex").notes);
  assert.equal(usageSummary(index, { days: 30 }).agents.find((agent) => agent.agentId === "claude"), undefined);

  // Only counts, days, models and folder names are stored: no title, message, preview or item text.
  const stored = await readFile(indexPath, "utf8");
  assert.doesNotMatch(stored, /ZZ9/u);
  assert.equal(stored.includes(home), false);
  assert.doesNotMatch(JSON.stringify(summary), /ZZ9/u);

  // A thread whose rollout gets indexed later loses its record on the next run.
  await writeRollout(home, "rollout-gone.jsonl", new Date(daysAgo(3)).toISOString());
  await runUsageIndex({ homeDirectory: home, indexPath, budgetMs: 10_000 });
  const after = await loadUsageIndex(indexPath);
  assert.equal(Object.values(after.records.codex).some((record) => record.t[4] === 12_000), false);
});

test("without any indexed rollout the totals are counted but not priced", { timeout: 30_000 }, async (context) => {
  const home = await mkdtemp(path.join(tmpdir(), "usage-codex-db-fresh-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await writeStateDatabase(home, [{ id: "a", rollout: path.join(sessions(home), "rollout-a.jsonl"), created: daysAgo(1), updated: daysAgo(1), model: "gpt-6.1-sol", tokens: 9_000 }]);
  const indexPath = path.join(home, "index.json");
  await runUsageIndex({ homeDirectory: home, indexPath, budgetMs: 10_000 });
  const index = await loadUsageIndex(indexPath);
  const codex = usageSummary(index, { days: 7 }).agents.find((agent) => agent.agentId === "codex");
  assert.deepEqual([codex.tokens.total, codex.costUsd, codex.unpricedTokens], [9_000, 0, 9_000]);
  assert.match(codex.notes[0].text, /暂不估算费用/u);
  assert.equal(codex.notes[0].unpricedTokens, 9_000);
});

test("the split keeps every token", () => {
  assert.deepEqual(splitByMix(10, [1, 1, 1, 0]), [4, 3, 3, 0]);
  assert.equal(splitByMix(1_234_567, [400, 200, 600, 7]).reduce((sum, value) => sum + value, 0), 1_234_567);
});
