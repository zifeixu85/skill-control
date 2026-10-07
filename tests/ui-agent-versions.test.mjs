import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./helpers/load-ts.mjs";

const versions = await loadTs("app/lib/agent-versions.ts");
const agents = await loadTs("app/lib/agents.ts");

const REPORT = {
  checkedAt: "2026-10-07T01:00:00Z",
  nextCheckAt: "2026-10-08T01:00:00Z",
  offline: false,
  agents: [
    { agentId: "claude", name: "Claude Code", installed: { version: "2.1.0", source: "npm" }, latest: { version: "2.1.0", source: "npm" }, status: "up-to-date" },
    {
      agentId: "codex",
      name: "Codex",
      installed: { version: "0.40.0", source: "npm", path: "/usr/local/bin/codex" },
      latest: { version: "0.41.2", source: "npm", url: "https://example.com/codex", notesUrl: "https://example.com/codex/notes", releasedAt: "2026-10-06" },
      status: "update-available",
      remedy: { prompt: "把 Codex 更新到 0.41.2", commands: [{ command: "npm i -g @openai/codex@latest" }] },
    },
    { agentId: "workbuddy", name: "WorkBuddy", installed: { version: "3.2" }, latest: null, status: "unknown" },
    { agentId: "office-raccoon", name: "办公小浣熊", installed: { version: "1.0.17", source: "app-bundle" }, latest: { version: "1.1.0", source: "app-update" }, status: "update-available" },
    { agentId: "hermes", installed: null, latest: null, status: "error", error: "网络超时" },
    { agentId: "", status: "update-available" },
    { agentId: "kiro", status: "something-new" },
  ],
};

test("agent versions: tolerant parsing, needs-attention first, unknown statuses are 无法判断", () => {
  const report = versions.normalizeAgentVersions(REPORT);
  assert.equal(report.checkedAt, "2026-10-07T01:00:00Z");
  assert.equal(report.offline, false);
  assert.deepEqual(
    report.agents.map((agent) => `${agent.agentId}:${agent.status}`),
    ["codex:update-available", "office-raccoon:update-available", "hermes:error", "workbuddy:unknown", "kiro:unknown", "claude:up-to-date"],
  );
  const codex = report.agents[0];
  assert.equal(codex.latest.notesUrl, "https://example.com/codex/notes");
  assert.equal(codex.installed.path, "/usr/local/bin/codex");
  assert.equal(codex.remedy.commands[0].command, "npm i -g @openai/codex@latest");
  assert.equal(report.agents.find((agent) => agent.agentId === "hermes").name, "hermes", "name falls back to the id");
  assert.equal(report.agents.find((agent) => agent.agentId === "hermes").installed, null);
  assert.deepEqual(versions.normalizeAgentVersions(null), { checkedAt: null, nextCheckAt: null, offline: false, agents: [] });
});

test("agent versions: badge counts update-available agents; the home hint only primary ones", () => {
  const report = versions.normalizeAgentVersions(REPORT);
  assert.equal(versions.agentsWithUpdates(report).length, 2);
  assert.deepEqual(versions.agentsWithUpdates(report, ["codex", "claude"]).map((agent) => agent.agentId), ["codex"]);
  assert.deepEqual(versions.agentsWithUpdates(undefined), []);
});

test("agent versions: sources in plain words; apps without commands update themselves", () => {
  assert.equal(versions.versionSourceLabel("npm"), "官方 npm");
  assert.equal(versions.versionSourceLabel("app-update"), "应用更新源");
  assert.equal(versions.versionSourceLabel("Sparkle"), "应用更新源");
  assert.equal(versions.versionSourceLabel("custom-feed"), "custom-feed");
  assert.equal(versions.versionSourceLabel(null), null);
  assert.equal(versions.inAppHint("办公小浣熊"), "在 办公小浣熊 里检查更新");
});

test("office-raccoon: a known brand, and unknown agent ids still render", () => {
  const raccoon = agents.agentMeta("office-raccoon");
  assert.equal(raccoon.name, "办公小浣熊");
  assert.equal(raccoon.letter, "浣");
  assert.match(raccoon.color, /^#[0-9a-f]{6}$/i);
  const unknown = agents.agentMeta("brand-new-agent");
  assert.equal(unknown.name, "brand-new-agent");
  assert.equal(unknown.letter, "B");
});
