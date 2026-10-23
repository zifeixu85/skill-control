import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./helpers/load-ts.mjs";

const win = await loadTs("app/lib/usage-window.ts");
const usage = await loadTs("app/lib/usage.ts");
const cost = await loadTs("app/lib/cost.ts");
const projects = await loadTs("app/lib/projects.ts");

const DAY = 86_400_000;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

test("window: 所有时间 is a fourth option and its label never reads 近 N 天", () => {
  assert.deepEqual(win.WINDOW_OPTIONS.map((option) => option.id), ["7", "30", "90", "all"]);
  assert.equal(win.WINDOW_OPTIONS.at(-1).label, "所有时间");
  assert.equal(win.windowParam("all"), "all");
  assert.equal(win.windowParam("30"), 30);
  assert.equal(win.windowLabel(30), "近 30 天");
  assert.equal(win.windowLabel(null), "所有时间");
  assert.equal(win.windowLabel(null, "所有时间"), "所有时间");
  assert.equal(win.windowLabel(7, "近 7 天"), "近 7 天");
});

test("window: summaries, models and projects keep days null for 所有时间", () => {
  const all = usage.normalizeUsageSummary({ windowDays: null, windowLabel: "所有时间", agents: [] }, null);
  assert.equal(all.days, null);
  assert.equal(all.windowLabel, "所有时间");
  // An older service that ignores days=all still yields an honest label for what was asked.
  const legacy = usage.normalizeUsageSummary({ windowDays: 30 }, null);
  assert.equal(legacy.days, null);
  assert.equal(legacy.windowLabel, "所有时间");
  const thirty = usage.normalizeUsageSummary({ windowDays: 30 }, 30);
  assert.equal(thirty.windowLabel, "近 30 天");
  assert.equal(cost.normalizeModelsReport({ windowDays: null, models: [] }, null).days, null);
  assert.equal(projects.normalizeProjectsReport({ windowDays: null, projects: [] }, null).days, null);
});

test("window: days up to ~120, weeks up to ~1.5 years, then months", () => {
  assert.equal(win.periodFor(7), "day");
  assert.equal(win.periodFor(120), "day");
  assert.equal(win.periodFor(121), "week");
  assert.equal(win.periodFor(540), "week");
  assert.equal(win.periodFor(541), "month");
});

test("window: short windows zero-fill every day; sessions are the daily active count", () => {
  const { period, points } = win.chartPoints(
    [{ date: "2026-10-05", sessions: 3, sessionsStarted: 1, tokens: 10, costUsd: 0.5 }],
    7,
    "2026-10-07",
  );
  assert.equal(period, "day");
  assert.equal(points.length, 7);
  assert.equal(points[0].date, "2026-10-01");
  assert.equal(points.at(-1).label, "10月7日");
  assert.equal(points.find((point) => point.date === "2026-10-05").sessions, 3);
  assert.equal(points.reduce((sum, point) => sum + point.tokens, 0), 10);
});

test("window: ~400 days of 所有时间 aggregate to Monday weeks, summing sessions started", () => {
  const end = Date.UTC(2026, 9, 7); // Wed 2026-10-07
  const series = [];
  for (let index = 0; index < 400; index += 1) {
    series.push({ date: isoDay(end - index * DAY), sessions: 5, sessionsStarted: 2, tokens: 100, costUsd: 0.25 });
  }
  const { period, points } = win.chartPoints(series, null, "2026-10-07");
  assert.equal(period, "week");
  assert.ok(points.length >= 57 && points.length <= 59, `about 58 weeks, got ${points.length}`);
  for (const point of points) assert.equal(new Date(`${point.date}T00:00:00Z`).getUTCDay(), 1, "weeks start on Monday");
  assert.equal(points.at(-1).date, "2026-10-05");
  assert.equal(points.at(-1).sessions, 3 * 2, "Mon–Wed of the last week, started sessions");
  assert.equal(points.at(-1).label, "10月5日起");
  assert.match(points[0].label, /^2025年\d+月\d+日起$/u, "earlier years are spelled out");
  assert.equal(points.reduce((sum, point) => sum + point.tokens, 0), 400 * 100, "nothing lost or doubled");
  assert.equal(win.sessionsMetricLabel(period), "每周开始的会话数");
});

test("window: multi-year history aggregates to months", () => {
  const series = [{ date: "2024-01-15", sessions: 1, sessionsStarted: 1, tokens: 7, costUsd: 0 }, { date: "2026-10-01", sessions: 4, sessionsStarted: 4, tokens: 1, costUsd: 0 }];
  const { period, points } = win.chartPoints(series, null, "2026-10-07");
  assert.equal(period, "month");
  assert.equal(points[0].date, "2024-01-01");
  assert.equal(points[0].label, "2024年1月");
  assert.equal(points.at(-1).sessions, 4);
  assert.equal(points.length, 34);
  assert.equal(win.sessionsMetricLabel("day"), "每天活跃的会话数");
});

test("window: a bad end date or empty series charts nothing instead of throwing", () => {
  assert.deepEqual(win.chartPoints([], null, "").points, []);
  assert.equal(win.chartPoints([], null, "2026-10-07").points.length, 1);
});

test("usage notes: notes or note, strings or { text }, deduplicated", () => {
  assert.deepEqual(usage.usageNotes({ notes: ["Codex 把旧会话移进了数据库，这部分是估算。", { text: "另一条" }, "Codex 把旧会话移进了数据库，这部分是估算。", " "] }), [
    "Codex 把旧会话移进了数据库，这部分是估算。",
    "另一条",
  ]);
  assert.deepEqual(usage.usageNotes({ note: "部分是估算" }), ["部分是估算"]);
  assert.deepEqual(usage.usageNotes({}), []);
  const summary = usage.normalizeUsageSummary({ agents: [{ agentId: "codex", sessions: 3, note: "部分是估算" }, { agentId: "claude", sessions: 1 }] }, 30);
  assert.deepEqual(summary.agents.find((agent) => agent.agentId === "codex").notes, ["部分是估算"]);
  assert.deepEqual(summary.agents.find((agent) => agent.agentId === "claude").notes, []);
});
