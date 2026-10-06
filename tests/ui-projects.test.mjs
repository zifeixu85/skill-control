import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./helpers/load-ts.mjs";

const projects = await loadTs("app/lib/projects.ts");
const usage = await loadTs("app/lib/usage.ts");

test("projects: folderless sessions are 未识别项目, cost order, totals reconcile through other", () => {
  const report = projects.normalizeProjectsReport({
    windowDays: 30,
    totals: { costUsd: 30, costBasis: { official: 28, estimate: 2, family: 0, reported: 0 }, unpricedTokens: 0 },
    projects: [
      { name: "cheap", sessions: 4, sessionsStarted: 2, tokens: 900, costUsd: 1, agents: [{ agentId: "codex", tokens: 900, costUsd: 1 }], topModels: [] },
      { name: null, sessions: 1, tokens: 500, costUsd: 9, topModels: [{ model: "claude-opus-5-5", name: "Claude Opus 5.5", costUsd: 9 }] },
      { name: "skill-manage", sessions: 3, tokens: { total: 2000 }, costUsd: 15, tokenSplit: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cacheWrite1h: 5 }, topModels: [
        { model: "gpt-6.1-sol", name: "GPT-6.1 Sol", costUsd: 10 },
        { model: "claude-opus-5-5", name: "Claude Opus 5.5", costUsd: 4 },
        { model: "glm-5.2", name: "GLM-5.2", costUsd: 1 },
        { name: "no id" },
      ] },
    ],
    other: { count: 7, costUsd: 5, tokens: 300 },
  });
  assert.deepEqual(report.projects.map((project) => projects.projectLabel(project.name)), ["skill-manage", "未识别项目", "cheap"]);
  const [top, unnamed, cheap] = report.projects;
  assert.equal(top.tokens, 2000, "a token object reads its total");
  assert.deepEqual(top.tokenSplit, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cacheWrite1h: 5 });
  assert.equal(top.topModels.length, 3, "models without an id are dropped");
  assert.equal(projects.topModelNames(top), "GPT-6.1 Sol、Claude Opus 5.5");
  assert.equal(unnamed.name, null);
  assert.equal(unnamed.sessionsStarted, 1, "falls back to sessions");
  assert.equal(cheap.sessionsStarted, 2);
  assert.deepEqual(cheap.agents, [{ agentId: "codex", tokens: 900, costUsd: 1 }]);
  assert.deepEqual(report.other, { count: 7, costUsd: 5, tokens: 300 });
  const listed = report.projects.reduce((sum, project) => sum + project.costUsd, 0);
  assert.equal(listed + report.other.costUsd, report.totals.costUsd, "the list plus 其余 equals the total");
  assert.equal(projects.normalizeProjectsReport({ projects: [], other: { count: 0 } }).other, null, "no 其余 row when nothing is left");
  assert.equal(projects.PROJECT_NOTE, "项目按文件夹名区分，不同位置的同名文件夹会合并");
});

test("agent usage: active vs started sessions, cost-ordered projects with the rest summed", () => {
  const agent = usage.normalizeAgentUsage({
    agentId: "claude",
    windowDays: 90,
    totals: { sessions: 27, sessionsStarted: 20, activeDays: 12, costUsd: 242.89, tokens: { total: 4.7e8 } },
    series: [{ date: "2026-10-06", sessions: 5, sessionsStarted: 2, tokens: 10, costUsd: 3 }],
    topProjects: [
      { name: "b", sessions: 1, tokens: 10, costUsd: 2 },
      { name: "a", sessions: 2, tokens: 20, costUsd: 5 },
    ],
    otherProjects: { count: 6, costUsd: 17.82, tokens: 3.4e7 },
  }, "claude");
  assert.equal(agent.sessions, 27);
  assert.equal(agent.sessionsStarted, 20);
  assert.deepEqual(agent.topProjects.map((project) => project.name), ["a", "b"]);
  assert.equal(agent.otherProjects.count, 6);
  const old = usage.normalizeAgentUsage({ totals: { sessions: 3 }, topProjects: [{ name: "x", sessions: 1, tokens: 5 }] }, "codex");
  assert.equal(old.sessionsStarted, 3, "older services: started = active");
  assert.equal(old.otherProjects, null);
  assert.equal(old.topProjects[0].costUsd, null, "no cost from older services");
  assert.match(usage.SESSIONS_HINT, /期间有活动的会话/);
});
