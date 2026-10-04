import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./helpers/load-ts.mjs";

const usage = await loadTs("app/lib/usage.ts");
const health = await loadTs("app/lib/health.ts");
const extras = await loadTs("app/lib/agent-extras.ts");

const summaryPayload = {
  generatedAt: "2026-10-04T08:00:00.000Z",
  windowDays: 30,
  index: { complete: false, updatedAt: null, indexedFiles: 120, totalFiles: 2000 },
  status: { state: "indexing", indexedFiles: 120, totalFiles: 2000, updatedAt: null, error: null },
  agents: [
    {
      agentId: "claude",
      sessions: 39,
      activeDays: 19,
      tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100 },
      costUsd: null,
      series: [
        { date: "2026-10-03", sessions: 2, tokens: 50 },
        { date: "2026-10-01", sessions: 1, tokens: 50 },
      ],
      sources: [{ id: "tokens", label: "会话记录", confidence: "exact" }],
    },
    { agentId: "workbuddy", sessions: 3, activeDays: 2, tokens: { total: 5 }, costUsd: null, credits: 643, series: [], sources: [] },
  ],
  topSkills: [
    { name: "pdf", count: 4, tokens: 9, agents: [{ agentId: "codex", count: 4, confidence: "inferred", lastUsedAt: "2026-10-02" }] },
    { name: "docs", count: 9, tokens: 1, agents: [{ agentId: "claude", count: 6, confidence: "exact" }, { agentId: "codex", count: 3, confidence: "inferred" }] },
  ],
};

test("usage summary keeps documented fields and sorts top skills", () => {
  const summary = usage.normalizeUsageSummary(summaryPayload);
  assert.equal(summary.days, 30);
  assert.equal(summary.agents.length, 2);
  const claude = summary.agents[0];
  assert.equal(claude.tokens.total, 100);
  assert.equal(claude.costUsd, null);
  assert.deepEqual(claude.series.map((point) => point.date), ["2026-10-01", "2026-10-03"]);
  assert.equal(claude.sources[0].confidence, "exact");
  assert.equal(summary.agents[1].credits, 643);
  assert.deepEqual(summary.topSkills.map((skill) => skill.name), ["docs", "pdf"]);
  assert.deepEqual(summary.topSkills[0].byAgent, { claude: 6, codex: 3 });
  assert.equal(summary.topSkills[1].confidenceByAgent.codex, "inferred");
  assert.equal(usage.confidenceLabel("reported"), "产品自报");
  assert.equal(usage.confidenceLabel("exact"), "精确");
  assert.equal(usage.confidenceLabel(null), "来源未注明");
});

test("indexing state drives the progress banner; finished indexes never show it", () => {
  const summary = usage.normalizeUsageSummary(summaryPayload);
  assert.equal(usage.isIndexing(summary.status, summary.index), true);
  assert.deepEqual(usage.indexProgress(summary.status, summary.index), { indexed: 120, total: 2000, ratio: 0.06 });
  const refreshing = usage.normalizeUsageStatus({ state: "indexing", indexedFiles: 5, totalFiles: 5 });
  assert.equal(usage.isIndexing(refreshing, { complete: true, updatedAt: "x", indexedFiles: 5, totalFiles: 5 }), false);
  assert.equal(usage.normalizeUsageStatus({ state: "weird" }).state, "unknown");
  assert.equal(usage.shouldPollUsage(summary.status, summary.index), true);
  assert.equal(usage.shouldPollUsage(usage.normalizeUsageStatus({ state: "partial" }), null), false, "partial does not poll");
  assert.equal(usage.isIndexing(usage.normalizeUsageStatus({ state: "partial" }), null), true, "but still shows progress");
  assert.equal(usage.normalizeUsageStatus(null), null);
});

test("series are zero-filled across the window by local date", () => {
  const filled = usage.fillSeries([{ date: "2026-10-03", sessions: 2, tokens: 5 }], 4, "2026-10-04");
  assert.deepEqual(filled.map((point) => [point.date, point.sessions]), [
    ["2026-10-01", 0],
    ["2026-10-02", 0],
    ["2026-10-03", 2],
    ["2026-10-04", 0],
  ]);
  assert.equal(usage.localDate("not a date"), "");
});

test("per-agent and per-skill usage detail parse tolerantly", () => {
  const agent = usage.normalizeAgentUsage(
    {
      agentId: "codex",
      windowDays: 90,
      totals: { sessions: 1330, activeDays: 89, tokens: { total: 7 }, costUsd: null },
      series: [{ date: "2026-10-01", sessions: 3, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } }],
      topSkills: [{ name: "gstack-review", count: 541, confidence: "inferred" }],
      topProjects: [{ name: "lumiclaw", sessions: 199, tokens: 714000 }],
    },
    "codex",
  );
  assert.equal(agent.sessions, 1330);
  assert.equal(agent.series[0].tokens, 2);
  assert.deepEqual(agent.topSkills[0].byAgent, { codex: 541 });
  assert.equal(agent.topProjects[0].name, "lumiclaw");
  const skill = usage.normalizeSkillUsage(
    { name: "pdf", agents: [{ agentId: "hermes", total: 3, reportedTotal: 12, series: [{ date: "2026-10-01", count: 1 }] }] },
    "pdf",
  );
  assert.equal(skill.agents[0].reportedTotal, 12);
  assert.equal(skill.agents[0].series.length, 1);
});

test("health report: severities map to groups, every category has a Chinese label", () => {
  const report = health.normalizeHealthReport({
    generatedAt: "2026-10-04T00:00:00Z",
    counts: { error: 1, warn: 1, info: 1 },
    findings: [
      { id: "a", severity: "warn", category: "differing-copies", title: "t1", detail: "d", fix: { kind: "reinstall", label: "重新安装" } },
      { id: "b", severity: "error", category: "broken-link", title: "t2", path: "~/.codex/skills/x", fix: { kind: "remove-link", label: "删除" } },
      { id: "c", severity: "info", category: "shared-root", title: "t3", fix: { kind: "none", label: "无需处理" } },
    ],
  });
  assert.equal(report.findings[2].fix, null, "fix kind none is not an action");
  const groups = health.groupFindings(report.findings);
  assert.deepEqual(groups.map((group) => group.severity), ["high", "medium", "info"]);
  assert.equal(groups[0].categories[0].label, "失效的软链接");
  const ids = [
    "broken-link", "missing-skill-md", "frontmatter", "name-mismatch", "oversize", "differing-copies",
    "hidden-by-product", "shadowed", "disabled", "archived", "missing-bin", "missing-env", "nvm-only",
    "mcp-command-missing", "mcp-literal-secret", "plugin-state", "shared-root",
  ];
  for (const id of ids) assert.ok(health.CATEGORY_LABELS[id], `label for ${id}`);
  assert.equal(health.severityOf("critical"), "high");
  assert.equal(health.severityOf("???"), "info");
});

test("agent files and tools normalize the documented shapes", () => {
  const files = extras.normalizeAgentFiles({
    agentId: "main",
    agents: ["main", "helper"],
    groups: [
      { id: "workspace", label: "工作区文件", note: "由 LumiClaw 写入", files: [{ id: "a".repeat(24), name: "SOUL.md", kind: "persona", size: 9, modifiedAt: "2026-10-01T00:00:00Z", displayPath: "~/x/SOUL.md" }] },
      { id: "empty", label: "空", files: [] },
    ],
    capabilities: [{ capabilityId: "cap1", name: "main", kind: "agent", origin: "agent" }],
  });
  assert.equal(files.groups.length, 1);
  assert.equal(files.groups[0].note, "由 LumiClaw 写入");
  assert.equal(files.agent, "main");
  assert.equal(files.capabilities[0].capabilityId, "cap1");
  const file = extras.normalizeAgentFile({ name: "jobs.json", language: "json", text: "{}", truncated: false, redactions: 2 });
  assert.equal(file.redactions, 2);
  const tools = extras.normalizeAgentTools({
    groups: [{ id: "perm", label: "权限规则", source: "~/.claude/settings.json", items: [{ name: "Bash(rm:*)", kind: "permission", enabled: null, tools: ["a"] }] }],
    notes: ["说明"],
  });
  assert.equal(tools.groups[0].items[0].enabled, null);
  assert.deepEqual(tools.groups[0].items[0].tools, ["a"]);
  assert.deepEqual(tools.notes, ["说明"]);
  assert.deepEqual(extras.normalizeAgentTools(null), { groups: [], notes: [] });
});
