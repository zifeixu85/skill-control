import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./helpers/load-ts.mjs";

const cache = await loadTs("app/lib/cache.ts");
const progress = await loadTs("app/lib/progress.ts");
const jobs = await loadTs("app/lib/agent-jobs.ts");
const versions = await loadTs("app/lib/agent-versions.ts");
const secrets = await loadTs("app/lib/secrets.ts");
const totals = await loadTs("app/lib/totals.ts");
const usage = await loadTs("app/lib/usage.ts");

test("cache hit rate: service value first, else read ÷ (uncached input + read + write)", () => {
  assert.equal(cache.cacheHitRate(0.96), 0.96);
  assert.equal(cache.cacheHitRate(96), 0.96, "0–100 accepted");
  assert.equal(cache.cacheHitRate(null, { input: 10, cacheRead: 80, cacheWrite: 10 }), 0.8);
  assert.equal(cache.cacheHitRate(undefined, { input: 0, cacheRead: 0, cacheWrite: 0 }), null, "no input, no rate");
  assert.equal(cache.cacheHitRate(undefined, { input: 5, cacheRead: 90, cacheWrite: 3, cacheWrite1h: 2 }), 0.9, "1-hour writes count as writes");
  assert.equal(cache.formatRate(0.957), "96%");
  assert.equal(cache.formatRate(0.004), "<1%");
  assert.equal(cache.formatRate(0.996), ">99%");
  assert.equal(cache.formatRate(null), "—");
  assert.equal(cache.rateTone(0.3), "bad");
  assert.equal(cache.rateTone(0.6), "warn");
  assert.equal(cache.rateTone(0.9), "ok");
  assert.match(cache.CACHE_HIT_HINT, /缓存读取 ÷（未缓存输入 \+ 缓存读取 \+ 缓存写入）/u);
});

test("cache distribution: cacheBySession with excludedSessions; p10 ≤ median ≤ p90", () => {
  const spread = cache.cacheDistributionOf({ cacheBySession: { sessions: 40, median: 0.93, p10: 0.61, p90: 0.98, lowSessions: 3, excludedSessions: 5 } });
  assert.deepEqual(spread, { sessions: 40, median: 0.93, p10: 0.61, p90: 0.98, lowSessions: 3, excluded: 5 });
  assert.equal(cache.cacheDistributionOf({ cacheBySession: { sessions: 0, median: 0.5 } }), null);
  assert.equal(cache.normalizeCacheDistribution({ sessions: 2, median: 0.5, p10: 0.7, p90: 0.2 }).p10, 0.5, "out-of-order quantiles are clamped");
  const agent = usage.normalizeUsageAgent({ agentId: "claude", tokens: { input: 10, cacheRead: 90, cacheWrite: 0, output: 5 }, cacheBySession: { sessions: 3, median: 0.9, p10: 0.8, p90: 0.95, lowSessions: 0 } });
  assert.equal(agent.cacheHitRate, 0.9);
  assert.equal(agent.cacheDistribution.sessions, 3);
  const window = totals.normalizeTotals({ windows: [{ id: "30", tokens: { input: 1, cacheRead: 3, cacheWrite: 0 }, cacheHitRate: 0.75, byAgent: [{ agentId: "codex", tokens: { input: 1, cacheRead: 1, cacheWrite: 0, total: 2 } }] }] }).windows[0];
  assert.equal(window.cacheHitRate, 0.75);
  assert.equal(window.byAgent[0].cacheHitRate, 0.5);
});

test("simulated progress eases toward 90% and never reaches it; elapsed time reads naturally", () => {
  const points = [0, 1_000, 10_000, 20_000, 60_000, 600_000].map((ms) => progress.simulatedProgress(ms, 20_000));
  for (let index = 1; index < points.length; index += 1) assert.ok(points[index] >= points[index - 1], "monotonic");
  assert.ok(points.at(-1) <= 0.9, "never past 90%");
  assert.ok(points[3] > 0.5 && points[3] < 0.7, `about 60% at the expected time, got ${points[3]}`);
  assert.equal(progress.elapsedText(8_400), "8 秒");
  assert.equal(progress.elapsedText(65_000), "1 分 05 秒");
  assert.equal(progress.elapsedText(3_720_000), "1 小时 2 分");
});

test("background update jobs: numeric step, steps, version; the store polls until done and reports once", async () => {
  const job = versions.normalizeUpdateJob({ jobId: "j1", status: "running", step: 1, steps: [{ display: "a", exitCode: 0 }, { display: "b" }], startedAt: "2026-10-24T01:00:00Z", outputTail: "added 1 package\n" });
  assert.equal(job.done, 1);
  assert.equal(job.total, 2);
  assert.equal(job.step, "b");
  assert.equal(job.result, null);
  const done = versions.normalizeUpdateJob({ jobId: "j1", status: "done", steps: [{ display: "a", exitCode: 0 }], version: { before: "1", after: "2" } });
  assert.equal(done.result.ok, true);
  assert.equal(done.result.version.after, "2");
  assert.equal(versions.normalizeUpdateJob({ status: "error", error: "npm 失败" }, "j2").error, "npm 失败");

  const answers = [{ status: "running", step: 0, steps: [{ display: "a" }] }, { status: "done", steps: [{ display: "a", exitCode: 0 }], version: { after: "2" } }];
  const store = jobs.createJobStore(async (id) => versions.normalizeUpdateJob(answers.shift(), id), { intervalMs: 5 });
  const finished = [];
  store.onFinished((tracked) => finished.push(tracked));
  store.track("codex-cli", "Codex CLI", "j1");
  assert.ok(store.get()["codex-cli"]);
  await store.pollNow();
  assert.equal(store.get()["codex-cli"].job.status, "running");
  await store.pollNow();
  assert.equal(store.get()["codex-cli"], undefined, "a finished job leaves the rows");
  assert.equal(finished.length, 1);
  assert.equal(finished[0].job.result.version.after, "2");
  store.reset();

  const failing = jobs.createJobStore(async () => Promise.reject(new Error("offline")), { intervalMs: 5, maxErrors: 2 });
  const failed = [];
  failing.onFinished((tracked) => failed.push(tracked));
  failing.track("x", "X", "j3");
  await failing.pollNow();
  assert.equal(failing.get().x.stale, true, "a failed poll marks it stale and keeps going");
  await failing.pollNow();
  assert.equal(failed.length, 1);
  assert.equal(failed[0].job.status, "error");
  failing.reset();
});

test("secrets guide: the service's text and prompt, or a prompt built here without values", () => {
  const report = secrets.normalizeSecrets({ guide: { text: "明文存储不安全…", prompt: "service prompt" }, items: [] });
  assert.deepEqual(report.guide, { text: "明文存储不安全…", prompt: "service prompt" });
  assert.equal(secrets.normalizeSecrets({ items: [] }).guide, null);
  const items = secrets.normalizeSecrets({
    items: [
      { id: "a", service: "OpenAI", keyName: "OPENAI_API_KEY", location: "~/.codex/config.toml", storage: "plaintext", fingerprint: "abcd1234" },
      { id: "b", service: "GitHub", keyName: "token", location: "~/.config/gh/hosts.yml", storage: "keychain" },
    ],
  }).items;
  const prompt = secrets.guidePrompt(items);
  assert.match(prompt, /1 个密钥以明文/u);
  assert.match(prompt, /OPENAI_API_KEY/u);
  assert.doesNotMatch(prompt, /hosts\.yml/u, "only plaintext entries");
  assert.match(prompt, /还能正常连接/u, "the connectivity caution");
  assert.match(prompt, /不要在回复里显示密钥的值/u);
  assert.doesNotMatch(prompt, /abcd1234/u);
});
