import assert from "node:assert/strict";
import test from "node:test";
import {
  bucketFor,
  compileTable,
  costOf,
  isOffPeak,
  modelKey,
  normalize,
  priceFor,
  priceTable,
  pricingFreshness,
  promptBucket,
  publicPriceTable,
  resolve,
} from "../server/pricing.mjs";

const table = priceTable();
const entry = (id) => resolve(id, table).entry;
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} ≠ ${expected}`);

test("the bundled table is valid and prices every model id seen in local logs", () => {
  const seen = {
    claude: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5", "claude-sonnet-5", "claude-fable-5-1", "claude-opus-4-8", "claude-haiku-4-5-20251001"],
    codex: ["gpt-5.6-sol", "gpt-6-astra", "gpt-5.5", "codex-auto-review", "gpt-6.1-sol", "gpt-5.6-terra", "gpt-6-sol", "gpt-5.4-mini", "gpt-5.6-luna"],
    workbuddy: ["glm-5.2", "hy3", "kimi-k2.7", "auto", "minimax-m3", "deepseek-v4-pro", "kimi-k2.6", "glm-5.3-flash", "hy4-preview", "deepseek-v4.1-flash", "glm-5.1"],
    hermes: ["gpt-5.5"],
  };
  for (const [agentId, ids] of Object.entries(seen)) {
    for (const id of ids) assert.notEqual(resolve(id, table, { agentId }).basis, "unpriced", `${agentId}: ${id}`);
  }
  assert.equal(resolve("<synthetic>", table).basis, "ignored");
  assert.equal(resolve("", table).basis, "unpriced");
  const pricing = publicPriceTable(table);
  assert.equal(pricing.models.length, table.raw.models.length);
  assert.deepEqual(pricing.buckets.map((bucket) => bucket.id), ["s", "l200", "l272", "l512"]);
  assert.ok(pricing.families.every((family) => typeof family.match === "string" && !("regex" in family)));
});

test("normalization: case, provider prefixes, date suffixes and aliases", () => {
  assert.equal(normalize("Moonshot/Kimi-K3"), "kimi-k3");
  assert.equal(normalize("openrouter/openai/gpt-5.5"), "gpt-5.5");
  for (const [id, expected] of [
    ["claude-haiku-4-5-20251001", "claude-haiku-4-5"], // alias
    ["claude-opus-4-5@20251101", "claude-opus-4-5"], // date suffix with @
    ["claude-opus-4-8-20260901", "claude-opus-4-8"], // date suffix, no alias
    ["openai/gpt-5.5-2026-04-23", "gpt-5.5"],
    ["GPT-5.6", "gpt-5.6-sol"],
    ["moonshot/kimi-k3", "kimi-k3"],
    ["models/gemini-3.1-pro-preview", "gemini-3.1-pro-preview"],
  ]) {
    const result = resolve(id, table);
    assert.deepEqual([result.basis, result.entry?.id], ["official", expected], id);
  }
  assert.equal(modelKey("sk-ant-api03-abcdefghijklmnop"), "unknown", "credential-shaped ids are never kept");
  assert.equal(modelKey("gpt 5"), "unknown");
  assert.equal(modelKey("x".repeat(81)), "unknown");
  assert.equal(modelKey(42), "unknown");
  assert.equal(modelKey(" claude-opus-5-5 "), "claude-opus-5-5");
});

test("resolution order: exact, estimate (agent-scoped), family, unpriced", () => {
  const review = resolve("codex-auto-review", table);
  assert.deepEqual([review.basis, review.priceAs, review.priceRef], ["estimate", "gpt-5.6-luna", { section: "estimates", id: "codex-auto-review" }]);
  assert.equal(resolve("deepseek-chat", table).priceAs, "deepseek-flash");
  const auto = resolve("auto", table, { agentId: "workbuddy" });
  assert.deepEqual([auto.basis, auto.average, auto.priceAs], ["estimate", true, "@agent-average"]);
  assert.equal(resolve("auto", table, { agentId: "claude" }).basis, "unpriced", "the auto estimate is WorkBuddy's own");
  const opus = resolve("claude-opus-9", table);
  assert.deepEqual([opus.basis, opus.family, opus.priceAs], ["family", "claude-opus", "claude-opus-5-5"]);
  assert.equal(resolve("gemini-9-flash-lite", table).family, "gemini-flash-lite", "the more specific family wins");
  assert.equal(resolve("glm-9-flash", table).family, "glm-flash");
  assert.equal(resolve("hy5", table).family, "hunyuan");
  assert.equal(resolve("mystery-model", table).basis, "unpriced");
});

test("Claude: uncached input, cache reads, 5-minute and 1-hour writes, fast mode", () => {
  const opus = entry("claude-opus-5-5");
  const row = [1_000, 2_000, 10_000, 1_000, 2_000];
  // 1000×4 + 2000×20 + 10000×0.2 + 1000×5 + 2000×8 = 67000 per 1M.
  near(costOf(row, priceFor(opus, "2026-10-07", "s")), 0.067);
  near(costOf(row, priceFor(opus, "2026-10-07", "s:fast")), 0.134);
  const sonnet = entry("claude-sonnet-5-5");
  assert.equal(priceFor(sonnet, "2026-10-07", "s:fast").fast, 1, "no fast price, no multiplier");
  near(costOf(row, priceFor(sonnet, "2026-10-07", "s:fast")), costOf(row, priceFor(sonnet, "2026-10-07", "s")));
});

test("long context: the whole request at the long price above each threshold", () => {
  assert.deepEqual(
    [200_000, 200_001, 272_000, 272_001, 512_000, 512_001].map(promptBucket),
    ["s", "l200", "l200", "l272", "l272", "l512"],
  );
  const sol = entry("gpt-6.1-sol"); // long above 272K
  assert.deepEqual(["s", "l200", "l272", "l512"].map((bucket) => priceFor(sol, "2026-10-07", bucket).input), [2, 2, 4, 4]);
  assert.equal(priceFor(sol, "2026-10-07", "l272").output, 15, "output too");
  const pro = entry("gemini-3.1-pro-preview"); // long above 200K
  assert.deepEqual(["s", "l200", "l272"].map((bucket) => priceFor(pro, "2026-10-07", bucket).input), [2, 4, 4]);
  const minimax = entry("minimax-m3"); // long above 512K
  assert.deepEqual(["l272", "l512"].map((bucket) => priceFor(minimax, "2026-10-07", bucket).output), [1.2, 2.4]);
  assert.equal(priceFor(sol, "2026-10-07", "l512").long, true);
  assert.equal(priceFor(entry("gpt-5.4-mini"), "2026-10-07", "l512").long, false, "no long tier, no long price");
});

test("missing fields fall back: cache reads and writes at the input price, 1-hour writes at the write price", () => {
  const gpt55 = priceFor(entry("gpt-5.5"), "2026-10-07", "s");
  assert.deepEqual([gpt55.cacheRead, gpt55.cacheWrite, gpt55.cacheWrite1h], [0.5, 5, 5]);
  const gpt55Long = priceFor(entry("gpt-5.5"), "2026-10-07", "l272");
  assert.deepEqual([gpt55Long.input, gpt55Long.cacheRead, gpt55Long.cacheWrite], [10, 1, 10], "writes at the long input price");
  const pro = priceFor(entry("gpt-5.5-pro"), "2026-10-07", "s");
  assert.deepEqual([pro.cacheRead, pro.cacheWrite], [30, 30], "no cache discount");
  const mimo = priceFor(entry("mimo-v2.6-pro"), "2026-10-07", "s");
  assert.deepEqual([mimo.cacheWrite, mimo.cacheWrite1h], [0, 0], "an explicit 0 stays 0");
});

test("Gemini Flash: the price follows the day of use", () => {
  const flash = entry("gemini-3.8-flash");
  assert.deepEqual([priceFor(flash, "2026-12-31", "s").input, priceFor(flash, "2027-01-01", "s").input, priceFor(flash, "2027-03-01", "s").output], [0.75, 1.5, 7.5]);
});

test("DeepSeek: off-peak by request time, only for models with an off-peak price", () => {
  const schedule = table.schedules["deepseek-peak"];
  // 2026-10-05 is a Monday. Peak: 01:00–04:00 and 06:00–10:00 UTC on weekdays.
  assert.deepEqual(
    ["2026-10-05T00:59:00Z", "2026-10-05T01:00:00Z", "2026-10-05T03:59:00Z", "2026-10-05T04:00:00Z", "2026-10-05T09:59:00Z", "2026-10-05T10:00:00Z", "2026-10-10T02:00:00Z", "2026-10-11T07:00:00Z"].map(
      (time) => isOffPeak(schedule, time),
    ),
    [true, false, false, true, false, true, true, true],
  );
  assert.equal(isOffPeak(schedule, "not a time"), false, "unknown times are priced at peak");
  assert.equal(isOffPeak({ timezone: "Asia/Shanghai", weekdays: [1, 2, 3, 4, 5], hours: [[9, 12]] }, "2026-10-05T02:00:00Z"), false, "10:00 in Beijing");
  assert.equal(bucketFor({ model: "deepseek-v4-pro", timestamp: "2026-10-10T02:00:00Z" }, table), "s:off");
  assert.equal(bucketFor({ model: "deepseek-v4-pro", timestamp: "2026-10-05T02:00:00Z" }, table), "s");
  assert.equal(bucketFor({ model: "deepseek-chat", timestamp: "2026-10-10T02:00:00Z" }, table), "s:off", "estimates follow their price");
  assert.equal(bucketFor({ model: "glm-5.2", timestamp: "2026-10-10T02:00:00Z" }, table), "s", "no off-peak price, no flag");
  assert.equal(bucketFor({ model: "claude-opus-5-5", promptTokens: 300_000, fast: true }, table), "l272:fast");
  const pro = entry("deepseek-v4-pro");
  assert.deepEqual([priceFor(pro, "2026-10-07", "s:off").input, priceFor(pro, "2026-10-07", "s").input], [0.66, 1.32]);
});

test("a malformed table is refused", () => {
  const base = { schedules: {}, models: [{ id: "a", vendor: "x", input: 1, output: 2 }] };
  assert.doesNotThrow(() => compileTable(base));
  assert.throws(() => compileTable({ ...base, models: [{ id: "a", vendor: "x", input: 1, output: 2, long: { above: 256_000, input: 2 } }] }), /不在索引分档内/u);
  assert.throws(() => compileTable({ ...base, models: [...base.models, { id: "b", aliases: ["a"], vendor: "x", input: 1, output: 1 }] }), /重复/u);
  assert.throws(() => compileTable({ ...base, estimates: [{ id: "z", priceAs: "missing" }] }), /不存在的模型/u);
  assert.throws(() => compileTable({ ...base, models: [{ id: "a", vendor: "x", input: 1, output: 2, offPeak: { schedule: "nope" } }] }), /不存在的时段/u);
  assert.throws(() => compileTable({ ...base, models: [{ id: "a", vendor: "x", input: "1", output: 2 }] }), /缺少输入或输出价格/u);
  assert.throws(() => compileTable({ ...base, estimates: [{ id: "z", priceAs: "@agent-average", fallback: "missing" }] }), /fallback 指向不存在的模型/u);
  assert.doesNotThrow(() => compileTable({ ...base, estimates: [{ id: "z", priceAs: "@agent-average", fallback: "A" }] }));
  assert.throws(() => compileTable({ ...base, models: [{ id: "a", vendor: "x", input: 1, output: 2, reviewBy: "2026-11" }] }), /reviewBy/u);
  assert.throws(() => compileTable({ ...base, reviewAfterDays: 0 }), /reviewAfterDays/u);
});

test("review dates: promotions past reviewBy and a table older than reviewAfterDays are flagged", () => {
  const at = (year, month, day) => new Date(year, month - 1, day, 12).getTime();
  assert.equal(table.raw.reviewAfterDays, 90);
  assert.deepEqual(table.raw.estimates.find((estimate) => estimate.id === "auto").fallback, "glm-5.2");
  assert.deepEqual(table.raw.models.filter((model) => model.reviewBy).map((model) => [model.id, model.reviewBy]), [
    ["gpt-5.6-sol", "2026-11-21"],
    ["gemini-3.8-flash", "2026-12-31"],
    ["gemini-3.7-flash", "2026-12-31"],
    ["gemini-3.6-flash", "2026-12-31"],
  ]);
  assert.equal(pricingFreshness(table, at(2026, 11, 21)).pricingStale, null, "due on the day itself, not yet past");
  assert.deepEqual(pricingFreshness(table, at(2026, 11, 22)).pricingStale, { ids: ["gpt-5.6-sol"], since: "2026-11-21" });
  assert.deepEqual(pricingFreshness(table, at(2027, 1, 1)).pricingStale.ids, ["gpt-5.6-sol", "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"]);
  assert.deepEqual(pricingFreshness(table, at(2026, 10, 7)).table, { checkedAt: "2026-10-07", ageDays: 0, reviewAfterDays: 90, stale: false });
  assert.deepEqual([pricingFreshness(table, at(2027, 1, 5)).table.ageDays, pricingFreshness(table, at(2027, 1, 5)).table.stale], [90, false]);
  assert.deepEqual([pricingFreshness(table, at(2027, 1, 6)).table.ageDays, pricingFreshness(table, at(2027, 1, 6)).table.stale], [91, true]);
  const pricing = publicPriceTable(table, at(2026, 11, 22));
  assert.deepEqual([pricing.reviewAfterDays, pricing.checkedAgeDays, pricing.tableStale, pricing.pricingStale.ids], [90, 46, false, ["gpt-5.6-sol"]]);
  assert.equal(pricing.models.find((model) => model.id === "gpt-5.6-sol").reviewBy, "2026-11-21");
  assert.equal(pricing.estimates.find((estimate) => estimate.id === "auto").fallback, "glm-5.2");
});
