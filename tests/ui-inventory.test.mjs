import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./helpers/load-ts.mjs";

const secrets = await loadTs("app/lib/secrets.ts");
const totals = await loadTs("app/lib/totals.ts");
const discovery = await loadTs("app/lib/discovery.ts");
const cli = await loadTs("app/lib/cli-tools.ts");
const versions = await loadTs("app/lib/agent-versions.ts");

test("secrets: tolerant parsing, plaintext first, never a value in the AI prompt", () => {
  const report = secrets.normalizeSecrets({
    generatedAt: "2026-10-24T00:00:00Z",
    items: [
      { id: "a", service: "OpenAI", keyName: "OPENAI_API_KEY", location: "~/.codex/config.toml · mcp_servers.x.env.OPENAI_API_KEY", storage: "env-ref", agents: ["codex"], usedBy: [{ kind: "mcp", name: "x" }], fingerprint: "a1b2c3d4" },
      { id: "b", service: "OpenAI", keyName: "token", location: "~/.npmrc · line 1", storage: "plaintext", usedBy: [{ kind: "weird", name: "y" }], fingerprint: "sk-not-a-fingerprint-value-1234567890" },
      { id: "c", service: "GitHub", keyName: "oauth_token", storage: "mystery" },
      { service: "no id" },
    ],
    changes: [{ id: "b", kind: "changed", at: "2026-10-23T00:00:00Z" }, { id: "x", kind: "odd" }],
    summary: { total: 3, plaintext: 1, byStorage: { plaintext: 1, "env-ref": 1 } },
  });
  assert.equal(report.items.length, 3);
  assert.equal(report.items[1].fingerprint, null, "only a short hex tag is ever kept");
  assert.equal(report.items[1].usedBy[0].kind, "other");
  assert.equal(report.items[2].storage, "unknown");
  assert.equal(report.changes[1].kind, "changed");
  const groups = secrets.groupSecrets(report.items);
  assert.deepEqual(groups.map((group) => group.service), ["OpenAI", "GitHub"], "services with plaintext first");
  assert.equal(groups[0].items[0].keyName, "token");
  const prompt = secrets.secretPrompt(report.items[1]);
  assert.match(prompt, /环境变量引用/u);
  assert.match(prompt, /不要在回复里显示密钥的值/u);
  assert.doesNotMatch(prompt, /sk-not-a-fingerprint/u);
  assert.equal(secrets.secretPrompt({ ...report.items[0], remedy: { prompt: "service prompt", commands: [], action: null } }), "service prompt");
});

test("totals: every window at once, by-Agent shares sorted by cost, unknown windows dropped", () => {
  const data = totals.normalizeTotals({
    generatedAt: "x",
    windows: [
      { id: "all", label: "全部", tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, costUsd: 9, sessions: 3, activeDays: 2, byAgent: [{ agentId: "codex", tokens: { total: 5 }, costUsd: 1 }, { agentId: "claude", tokens: 7, costUsd: 8 }] },
      { id: "today", tokens: {}, costUsd: null },
      { id: "365", tokens: {} },
    ],
  });
  assert.deepEqual(data.windows.map((window) => window.id), ["today", "all"]);
  assert.equal(data.windows[0].label, "今天");
  assert.equal(data.windows[1].tokens.total, 10, "total computed when missing");
  assert.deepEqual(data.windows[1].byAgent.map((agent) => agent.agentId), ["claude", "codex"]);
  assert.equal(data.windows[1].byAgent[1].tokens, 5);
  assert.equal(totals.totalsFor(data, "30"), null);
  assert.deepEqual(totals.HOME_WINDOWS, ["today", "7", "30", "all"]);
});

test("discovery: new Agents, open candidates and a custom Agent entry", () => {
  const candidates = discovery.normalizeDiscovery({
    candidates: [
      { id: "mystery-agent", guessName: "Mystery", path: "~/.mystery-agent/skills", skillCount: 2, reason: "r" },
      { id: "ignored", guessName: "I", path: "~/.ignored/skills" },
      { id: "", path: "~/.x" },
    ],
  });
  assert.equal(candidates.length, 2);
  const config = { agents: [{ id: "mystery-agent", paths: [] }], ignoredDiscoveries: ["ignored"] };
  const open = discovery.openCandidates(candidates, { ...config, agents: [] });
  assert.deepEqual(open.map((item) => item.id), ["mystery-agent"]);
  assert.equal(discovery.openCandidates(candidates, config).length, 0, "already added");
  const entry = discovery.customAgentFrom(candidates[0], [{ id: "mystery-agent" }]);
  assert.equal(entry.id, "mystery-agent-2", "a taken id gets a suffix");
  assert.deepEqual(entry.paths, ["~/.mystery-agent/skills"]);
  assert.equal(discovery.customAgentFrom({ ...candidates[0], path: "~/.foo" }, []).paths[0], "~/.foo/skills");
  assert.deepEqual(
    discovery.newAgents([{ id: "a", available: true, isNew: true }, { id: "b", available: false, isNew: true }, { id: "c", available: true }]).map((agent) => agent.id),
    ["a"],
  );
});

test("CLI inventory: every tool, owners, availability in any shape, summary", () => {
  const inventory = cli.normalizeCliInventory({
    tools: [
      { name: "whyai", path: "~/.local/bin/whyai", sourceLabel: "~/.local/bin", owner: { type: "uv", name: "yai-cli", version: "0.4.2" }, referencedBySkills: ["yai-research"], aiRelated: true, aiReasons: ["local-bin"], agents: [{ agentId: "codex", agentName: "Codex", available: true, detail: "PATH", allowed: false }, { agentId: "claude", state: "missing" }] },
      { name: "rg", owner: { type: "homebrew", name: "ripgrep" }, aiRelated: false },
      { name: "jq", path: "/usr/bin/jq", owner: { type: "brew?" }, referencedBySkills: 3, aiRelated: false, agents: { codex: true, claude: "unknown" } },
      { id: "lark-cli", name: "飞书 CLI", agents: [{ agentId: "codex", pathSource: "shell", resolves: { path: "~/x" } }], fixes: [{ id: "f", kind: "self" }] },
    ],
  });
  const [whyai, rg, jq, lark] = inventory.tools;
  assert.equal(rg.owner.type, "homebrew");
  assert.equal(cli.OWNER_LABELS.homebrew, "Homebrew");
  assert.equal(cli.OWNER_LABELS.pipx, "pipx 工具");
  assert.deepEqual(whyai.aiReasons, ["local-bin"]);
  assert.equal(whyai.sourceLabel, "~/.local/bin");
  assert.equal(whyai.availability[0].allowed, false, "the inventory's allow-rule field is `allowed`");
  assert.equal(whyai.deep, false, "inventory rows are not deep rows");
  assert.equal(whyai.id, "whyai", "the name is the id when there is none");
  assert.equal(whyai.owner.type, "uv");
  assert.deepEqual(whyai.availability.map((entry) => entry.available), [true, false]);
  assert.equal(jq.owner.type, "other");
  assert.equal(jq.referencedCount, 3);
  assert.deepEqual(jq.availability, [{ agentId: "codex", available: true, detail: null, allowed: null }, { agentId: "claude", available: false, detail: null, allowed: null }]);
  assert.equal(lark.deep, true);
  assert.equal(lark.aiRelated, true, "deep tools count as AI-related");
  assert.deepEqual(lark.availability, [{ agentId: "codex", available: true, detail: "~/x", allowed: null }]);
  assert.deepEqual(inventory.summary, { total: 4, aiRelated: 2 });
  assert.deepEqual(cli.normalizeCliInventory({ tools: [], summary: { total: 9, aiRelated: 4 } }).summary, { total: 9, aiRelated: 4 });
});

test("one-click update: plan and result shapes; only an agent-update action offers it", () => {
  assert.equal(versions.normalizeUpdatePlan({ steps: [] }), null, "no plan id, no plan");
  const plan = versions.normalizeUpdatePlan({ planId: "p", title: "更新 Codex", steps: [{ display: "npm i -g x", program: "/abs/npm", args: ["i"] }, { display: "" }], effects: ["替换 x"], afterCheck: { display: "codex --version" } });
  assert.deepEqual(plan.steps, [{ display: "npm i -g x" }], "programs and args never reach the page");
  assert.equal(plan.afterCheck, "codex --version");
  const result = versions.normalizeUpdateResult({ ok: true, steps: [{ display: "npm i -g x", exitCode: 0, output: "done" }], version: { before: "1", after: "2" } });
  assert.equal(result.version.after, "2");
  assert.equal(result.steps[0].exitCode, 0);
  const agent = (remedy) => ({ agentId: "codex", remedy });
  assert.equal(versions.oneClickUpdate(agent({ prompt: "p", commands: [], action: { kind: "agent-update", id: "codex" } })), "codex");
  assert.equal(versions.oneClickUpdate(agent({ prompt: "p", commands: [], action: { kind: "open-app", id: "codex" } })), null);
  assert.equal(versions.oneClickUpdate(agent(null)), null);
  const report = versions.normalizeAgentVersions({
    agents: [
      { id: "codex-cli", agentId: "codex", name: "Codex CLI", status: "update-available", remedy: { prompt: "p", action: { kind: "agent-update", id: "codex-cli" } } },
      { id: "codex-app", agentId: "codex", name: "Codex 桌面应用", status: "update-available", openApp: { bundleId: "com.openai.codex" }, downloadUrl: "https://example.com/dl", active: false },
      { agentId: "claude", status: "unknown", reason: "读不到本机安装的版本号。" },
    ],
  });
  assert.deepEqual(report.agents.map((row) => row.id), ["codex-cli", "codex-app", "claude"], "one Agent can have several rows; the id falls back to the Agent");
  assert.equal(versions.oneClickUpdate(report.agents[0]), "codex-cli");
  assert.equal(report.agents[1].openApp, true);
  assert.equal(report.agents[1].active, false);
  assert.equal(report.agents[2].reason, "读不到本机安装的版本号。");
});
