import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./helpers/load-ts.mjs";

const cost = await loadTs("app/lib/cost.ts");
const pricing = await loadTs("app/lib/pricing.ts");
const usage = await loadTs("app/lib/usage.ts");
const chart = await loadTs("app/lib/chart.ts");

test("cost formatting: two decimals, <$0.01 for tiny amounts, — for none", () => {
  assert.equal(cost.formatCost(null), "—");
  assert.equal(cost.formatCost(Number.NaN), "—");
  assert.equal(cost.formatCost(0), "$0.00");
  assert.equal(cost.formatCost(0.004), "<$0.01");
  assert.equal(cost.formatCost(0.0099), "<$0.01");
  assert.equal(cost.formatCost(0.01), "$0.01");
  assert.equal(cost.formatCost(2.8), "$2.80");
  assert.equal(cost.formatCost(999.994), "$999.99");
  assert.equal(cost.formatCost(1234.567), "$1,235");
  assert.equal(cost.formatCost(16373.3), "$16,373");
  assert.equal(cost.longShareLabel(0.634), "长上下文 63%");
  assert.equal(cost.longShareLabel(0.002), "长上下文 <1%");
  assert.equal(cost.longShareLabel(0), null);
});

test("model rows: tolerant parsing, unknown basis is unpriced, cost order with unpriced last", () => {
  const report = cost.normalizeModelsReport({
    windowDays: 30,
    totals: { costUsd: 12.5, costBasis: { official: 10, estimate: 2, family: 0.5, reported: 0 }, unpricedTokens: 70 },
    models: [
      { model: "mystery", name: "mystery", basis: "unpriced", tokens: { input: 900, output: 0 }, costUsd: 0 },
      { model: "gpt-6.1-sol", name: "GPT-6.1 Sol", vendor: "openai", basis: "official", priceRef: { section: "models", id: "gpt-6.1-sol" }, tokens: { input: 10, output: 5, cacheRead: 2 }, costUsd: 10, longShare: 0.67, agents: [{ agentId: "codex", tokens: 17, costUsd: 10 }] },
      { model: "auto", name: "auto", basis: "estimate", priceAs: "@agent-average", priceRef: { section: "estimates", id: "auto" }, tokens: {}, costUsd: 2 },
      { model: "weird", basis: "bogus", priceRef: { section: "nope", id: "x" }, costUsd: 0.5, longShare: 7 },
      { name: "no id" },
    ],
    unpriced: ["mystery"],
    pricingStale: { ids: ["gpt-5.6-sol"], since: "2026-10-01" },
    pricingTable: { checkedAt: "2026-06-20", ageDays: 109, reviewAfterDays: 90, stale: true },
  });
  assert.deepEqual(report.models.map((row) => row.model), ["gpt-6.1-sol", "auto", "weird", "mystery"]);
  const weird = report.models[2];
  assert.equal(weird.basis, "unpriced");
  assert.equal(weird.priceRef, null, "only known sections link to the table");
  assert.equal(weird.longShare, 1, "clamped");
  assert.equal(report.models[0].tokens.total, 17);
  assert.deepEqual(report.models[0].agents, [{ agentId: "codex", tokens: 17, costUsd: 10 }]);
  assert.equal(report.totals.unpricedTokens, 70);
  assert.equal(report.pricingTable.stale, true);
  assert.deepEqual(report.pricingStale, { ids: ["gpt-5.6-sol"], since: "2026-10-01" });
  assert.equal(cost.priceTarget(report.models[0]), "models:gpt-6.1-sol");
  assert.equal(cost.priceTarget(report.models[3]), "rules", "no row to point at");
  assert.deepEqual(cost.BASIS_LABELS, { official: "官方", estimate: "估算", family: "系列兜底", reported: "产品自报", unpriced: "未定价" });
  assert.equal(cost.basisChip("unpriced").tone, "danger");
});

test("summing costs keeps the basis split; agents and series carry cost", () => {
  const total = cost.sumCosts([
    { costUsd: 1, costBasis: { official: 1, estimate: 0, family: 0, reported: 0 } },
    { costUsd: 0.5, costBasis: { official: 0, estimate: 0.5, family: 0, reported: 0 } },
    { costUsd: null, costBasis: null },
  ]);
  assert.deepEqual(total, { costUsd: 1.5, costBasis: { official: 1, estimate: 0.5, family: 0, reported: 0 } });
  assert.deepEqual(cost.sumCosts([{ costUsd: null, costBasis: null }]), { costUsd: 0, costBasis: null });

  const summary = usage.normalizeUsageSummary({
    agents: [{
      agentId: "hermes",
      costUsd: 28.93,
      costBasis: { official: 28.06, estimate: 0, family: 0, reported: 0.87 },
      unpricedTokens: 0,
      reportedCostUsd: 0.87,
      byModel: [{ model: "gpt-5.5", basis: "official", costUsd: 27.2 }],
      series: [{ date: "2026-10-06", sessions: 1, tokens: 10, costUsd: 6.8 }],
    }],
  });
  const hermes = summary.agents[0];
  assert.equal(hermes.reportedCostUsd, 0.87);
  assert.equal(hermes.costBasis.reported, 0.87);
  assert.equal(hermes.byModel[0].model, "gpt-5.5");
  assert.equal(hermes.series[0].costUsd, 6.8);
  assert.equal(usage.fillSeries(hermes.series, 2, "2026-10-07")[1].costUsd, 0, "filled days cost nothing");
});

test("money charts can scale below 1", () => {
  assert.equal(chart.niceMax(0.004, 0.01), 0.01);
  assert.equal(chart.niceMax(0.3, 0.01), 0.5);
  assert.equal(chart.niceMax(0.3), 1, "counts never go below 1");
  assert.equal(chart.niceMax(7), 10);
});

const TABLE = {
  checkedAt: "2026-10-07",
  reviewAfterDays: 90,
  checkedAgeDays: 0,
  tableStale: false,
  pricingStale: { ids: ["gpt-5.6-sol"], since: "2026-10-01" },
  currency: "USD",
  unit: "per 1M tokens",
  vendors: { openai: { name: "OpenAI", pricingUrl: "https://developers.openai.com/api/docs/pricing" }, deepseek: { name: "DeepSeek", pricingUrl: "javascript:alert(1)" } },
  schedules: { "deepseek-peak": { note: "峰时为周一至周五" } },
  fx: { CNY: { perUsd: 7.2, note: "x" } },
  models: [
    { id: "gpt-6-astra", vendor: "openai", name: "GPT-6 Astra", input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, long: { above: 272000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }, source: "https://developers.openai.com/api/docs/pricing" },
    { id: "gpt-5.5", aliases: ["gpt-5.5-2026-04-23"], vendor: "openai", name: "GPT-5.5", input: 5, output: 30, cacheRead: 0.5, source: "http://insecure.example" },
    { id: "gpt-5.6-sol", vendor: "openai", name: "GPT-5.6 Sol", input: 4, output: 20, status: "promo", reviewBy: "2026-11-21" },
    { id: "deepseek-v4-pro", vendor: "deepseek", name: "DeepSeek V4 Pro", input: 1.32, output: 3.96, cacheRead: 0.003625, offPeak: { schedule: "deepseek-peak", input: 0.66, output: 1.98 }, status: "retired" },
    { id: "gemini-3.8-flash", vendor: "google", name: "Gemini 3.8 Flash", input: 0.75, output: 3.75, changes: [{ from: "2027-01-01", input: 1.5, output: 7.5 }, { input: 9 }] },
  ],
  estimates: [{ id: "auto", agent: "workbuddy", priceAs: "@agent-average", fallback: "glm-5.2", reason: "r" }, { priceAs: "x" }],
  families: [{ id: "gpt-mini", name: "GPT Mini 系列", match: "^gpt-.*-mini", priceAs: "gpt-5.4-mini" }],
};

test("price table: parsing keeps only safe links and known statuses", () => {
  const table = pricing.normalizePricing(TABLE);
  assert.equal(table.vendors.openai.pricingUrl, "https://developers.openai.com/api/docs/pricing");
  assert.equal(table.vendors.deepseek.pricingUrl, null, "only https links");
  assert.equal(table.models[1].source, null);
  assert.equal(table.models[3].status, null, "unknown status dropped");
  assert.equal(table.models[3].offPeak.schedule, "deepseek-peak");
  assert.equal(table.models[0].long.above, 272000);
  assert.deepEqual(table.models[4].changes.map((change) => change.from), ["2027-01-01"]);
  assert.deepEqual(table.models[1].aliases, ["gpt-5.5-2026-04-23"]);
  assert.equal(table.currency, "USD");
  assert.deepEqual(table.fx, [{ currency: "CNY", perUsd: 7.2, note: "x" }]);
  assert.equal(table.estimates.length, 1);
  assert.equal(table.families[0].match, "^gpt-.*-mini");
});

test("price formatting: exact values, thresholds, long-context and filled-in prices", () => {
  assert.equal(pricing.formatPrice(10), "$10");
  assert.equal(pricing.formatPrice(0.5), "$0.5");
  assert.equal(pricing.formatPrice(0.003625), "$0.003625");
  assert.equal(pricing.formatPrice(1.0000004), "$1");
  assert.equal(pricing.formatPrice(null), "—");
  assert.equal(pricing.formatThreshold(272000), "272K");
  assert.equal(pricing.formatThreshold(200000), "200K");
  assert.equal(pricing.formatThreshold(1000000), "1M");
  const table = pricing.normalizePricing(TABLE);
  assert.equal(pricing.longLabel(table.models[0]), ">272K 输入 $20 · 输出 $75");
  assert.equal(pricing.longLabel(table.models[1]), null);
  assert.equal(pricing.priceSummary(table.models[3].offPeak.prices), "输入 $0.66 · 输出 $1.98");
  const gpt55 = table.models[1].prices;
  assert.deepEqual(pricing.effectivePrice(gpt55, "cacheRead"), { value: 0.5, inherited: false });
  assert.deepEqual(pricing.effectivePrice(gpt55, "cacheWrite"), { value: 5, inherited: true }, "no write price: input price");
  assert.deepEqual(pricing.effectivePrice(gpt55, "cacheWrite1h"), { value: 5, inherited: true }, "no 1-hour price: write price");
  const sol = table.models[2].prices;
  assert.deepEqual(pricing.effectivePrice(sol, "cacheRead"), { value: 4, inherited: true }, "no cache discount: input price");
  assert.equal(pricing.priceRowId("models:gpt-5.5"), "price-models-gpt-5.5");
  assert.equal(pricing.priceRowId("families:a/b c"), "price-families-a_b_c");
});

test("price table grouping: vendors in table order, models used here first", () => {
  const table = pricing.normalizePricing(TABLE);
  const rows = cost.normalizeModelRows([
    { model: "gpt-5.5-2026-04-23", basis: "official", priceRef: { section: "models", id: "gpt-5.5" }, costUsd: 3 },
    { model: "gpt-5.7-mini", basis: "family", priceAs: "gpt-5.4-mini", priceRef: { section: "families", id: "gpt-mini" }, costUsd: 1 },
    { model: "auto", basis: "estimate", priceAs: "@agent-average", priceRef: { section: "estimates", id: "auto" }, costUsd: 1 },
    { model: "x", basis: "unpriced", costUsd: 0 },
  ]);
  const used = pricing.usedPriceIds(rows);
  assert.deepEqual([...used].sort(), ["estimates:auto", "families:gpt-mini", "models:gpt-5.4-mini", "models:gpt-5.5"]);
  const groups = pricing.groupByVendor(table, used);
  assert.deepEqual(groups.map((group) => group.id), ["openai", "deepseek", "google"]);
  assert.deepEqual(groups[0].models.map((model) => model.id), ["gpt-5.5", "gpt-6-astra", "gpt-5.6-sol"], "used first, then table order");
  assert.equal(groups[0].usedCount, 1);
  assert.equal(groups[0].name, "OpenAI");
  assert.equal(groups[2].name, "google", "a vendor missing from the list shows its id");
  assert.equal(pricing.nameOf(table, "gpt-5.5"), "GPT-5.5");
  assert.equal(pricing.nameOf(table, "missing"), "missing");
});
