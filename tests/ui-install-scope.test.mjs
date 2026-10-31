import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./helpers/load-ts.mjs";

const scope = await loadTs("app/lib/install-scope.ts");
const plans = await loadTs("app/lib/install-plan.ts");
const integration = await loadTs("app/lib/integration.ts");
const library = await loadTs("app/lib/library.ts");

const names = { claude: "Claude Code", codex: "Codex", workbuddy: "WorkBuddy", hermes: "Hermes" };
const name = (id) => names[id] || id;
const base = { primary: ["claude", "codex", "workbuddy"], chosen: ["claude"], single: "claude", exclude: [] };

test("install method: config.library first, else the pre-0.3 syncMode", () => {
  assert.equal(scope.installMethod({ library: { installMode: "per-agent" }, syncMode: "symlink" }), "per-agent");
  assert.equal(scope.installMethod({ library: { installMode: "library" }, syncMode: "copy" }), "library");
  assert.equal(scope.installMethod({ syncMode: "copy" }), "per-agent");
  assert.equal(scope.installMethod({ syncMode: "symlink" }), "library");
  assert.equal(scope.installMethod(null), "library");
});

test("scope request and plan body: what each option sends", () => {
  const primary = scope.scopeRequest({ ...base, option: "primary", exclude: ["codex"] });
  assert.deepEqual(primary, { scope: "primary", agentIds: ["claude", "workbuddy"] });
  assert.deepEqual(scope.installBody({ importId: "imp" }, primary, {}), { source: { importId: "imp" }, scope: "primary" }, "the service uses its own 常用 list");
  const chosen = scope.scopeRequest({ ...base, option: "choose", chosen: ["claude", "claude", "hermes", "codex"], exclude: ["codex"] });
  assert.deepEqual(chosen, { scope: "agents", agentIds: ["claude", "hermes"] });
  assert.deepEqual(scope.installBody({ instanceId: "i1" }, chosen, { "replace:x": "use-new" }), {
    source: { instanceId: "i1" },
    scope: "agents",
    agentIds: ["claude", "hermes"],
    choices: { "replace:x": "use-new" },
  });
  assert.deepEqual(scope.scopeRequest({ ...base, option: "single" }), { scope: "agent-only", agentIds: ["claude"] });
  assert.deepEqual(scope.scopeRequest({ ...base, option: "single", exclude: ["claude"] }).agentIds, [], "the source can't be the target");
  assert.deepEqual(scope.scopeRequest({ ...base, option: "single", single: null }).agentIds, []);
});

test("scope texts explain each option and name native readers", () => {
  const texts = scope.scopeOptionTexts("library", ["Claude Code", "Codex", "WorkBuddy"], ["Codex", "Gemini CLI", "Cursor", "OpenClaw"]);
  assert.deepEqual(texts.map((text) => text.title), ["所有常用 Agent（推荐）", "选择 Agent", "只装到某个 Agent"]);
  assert.match(texts[0].detail, /放进技能库，再接入 Claude Code、Codex、WorkBuddy/);
  assert.match(texts[1].detail, /Codex、Gemini CLI、Cursor 等 4 个 Agent 会自动读取技能库，进库后也能看到它/);
  assert.match(texts[2].detail, /不进技能库，其他 Agent 看不到/);
  assert.match(scope.scopeOptionTexts("per-agent", [], [])[0].detail, /给 常用 Agent 各复制一份/);
  assert.equal(scope.initialOption("claude"), "choose");
  assert.equal(scope.initialOption(null), "primary");
  assert.equal(scope.shortNames(["A", "B"]), "A、B");
});

const LIBRARY_PLAN = {
  planId: "inst-1",
  mode: "library",
  scope: "primary",
  skillName: "pdf-tools",
  label: "PDF 工具",
  library: "~/.agents/skills",
  expiresAt: "2026-11-01T10:10:00Z",
  targets: [
    { agentId: "claude", name: "Claude Code", tier: "link", method: "软链接", outcome: "link" },
    { agentId: "codex", name: "Codex", tier: "native", outcome: "native" },
    { agentId: "hermes", tier: "config", outcome: "config" },
    { agentId: "", outcome: "link" },
  ],
  alsoVisibleTo: ["gemini"],
  items: [
    { id: "add:pdf-tools", kind: "add", skill: "pdf-tools", choices: ["add"], choice: "add", steps: [{ type: "copy" }] },
    { id: "link:claude:pdf-tools", kind: "link", skill: "pdf-tools", agentId: "claude", choices: ["link", "skip"], choice: "link", dependsOn: "add:pdf-tools", steps: [{ type: "link" }] },
    { id: "config:hermes", kind: "config", skill: "", agentId: "hermes", choices: ["configure", "skip"], choice: "configure", steps: [{ type: "command" }] },
  ],
  actions: [{ agentId: "x" }],
};

test("install plans: library mode keeps items and targets, per-Agent mode keeps copies", () => {
  const plan = plans.normalizeInstallPlan(LIBRARY_PLAN);
  assert.equal(plan.mode, "library");
  assert.equal(plan.label, "PDF 工具");
  assert.deepEqual(plan.targets.map((target) => [target.agentId, target.tier, target.outcome]), [
    ["claude", "link", "link"],
    ["codex", "native", "native"],
    ["hermes", "config", "config"],
  ]);
  assert.equal(plan.items.length, 3);
  assert.deepEqual(plan.actions, [], "copies only in per-Agent mode");
  assert.equal(plans.runningItems(plan), 3);
  assert.ok(plans.OUTCOME_TEXT[plan.targets[0].outcome]);

  const copy = plans.normalizeInstallPlan({ planId: "inst-2", mode: "per-agent", actions: [{ agentId: "claude", action: "create" }, { agentId: "codex", action: "noop" }, null], items: [{ id: "x" }] });
  assert.equal(copy.mode, "per-agent");
  assert.deepEqual(copy.items, []);
  assert.equal(copy.actions.length, 2);
  assert.equal(plans.runningItems(copy), 1);
  const empty = plans.normalizeInstallPlan({});
  assert.equal(empty.planId, null);
  assert.equal(empty.libraryRoot, "~/.agents/skills");
});

test("install results: what changed, in one toast line", () => {
  const plan = plans.normalizeInstallPlan(LIBRARY_PLAN);
  const result = plans.normalizeInstallResult({
    mode: "library",
    results: [
      { id: "add:pdf-tools", status: "applied" },
      { id: "link:claude:pdf-tools", status: "applied" },
      { id: "config:hermes", status: "rolled-back" },
    ],
    historyEntry: { id: "h-9", restorable: true },
  });
  assert.equal(result.historyId, "h-9");
  assert.equal(result.failed, 1);
  const done = plans.installDone(plan, result);
  assert.deepEqual(done, { library: true, agents: ["claude"] });
  assert.equal(scope.installMessage("PDF 工具", done, false, name), "已把 PDF 工具 放进技能库，并接入 Claude Code");
  assert.equal(scope.installMessage("PDF 工具", { library: true, agents: [] }, false, name), "已把 PDF 工具 放进技能库");
  assert.equal(scope.installMessage("PDF 工具", { library: false, agents: ["claude"] }, false, name), "已把 PDF 工具 接入 Claude Code");
  assert.equal(scope.installMessage("PDF 工具", { library: false, agents: [] }, false, name), "PDF 工具 已经在技能库里，没有改动");

  const copy = plans.normalizeInstallResult({ mode: "per-agent", actions: [{ agentId: "claude", action: "create", result: "completed" }, { agentId: "codex", action: "noop", result: "skipped" }], historyEntry: { id: "h-1" } });
  assert.deepEqual(plans.installDone(plans.normalizeInstallPlan({ mode: "per-agent" }), copy), { library: false, agents: ["claude"] });
  assert.equal(scope.installMessage("PDF 工具", { library: false, agents: ["claude"] }, true, name), "已装到 Claude Code：PDF 工具");
  assert.equal(plans.normalizeInstallResult({}).historyId, null);
});

test("Agent 集成: launcher and companion status, who can use it, what installing does", () => {
  const empty = integration.normalizeLauncher(null);
  assert.deepEqual([empty.path, empty.installed, empty.foreign, empty.onPath, empty.supported], ["~/.local/bin/skill-control", false, false, null, true]);
  const windows = integration.normalizeLauncher({ supported: false, reason: "Windows 暂不支持", installed: false });
  assert.equal(windows.reason, "Windows 暂不支持");
  const foreign = integration.normalizeLauncher({ path: "~/.local/bin/skill-control", installed: false, foreign: true, onPath: false, pathHint: "加入 PATH" });
  assert.equal(foreign.foreign, true);
  assert.equal(foreign.pathHint, "加入 PATH");

  const status = integration.normalizeCompanion({ available: true, version: "0.1.0", inLibrary: true, upToDate: false, fanout: { claude: { tier: "link", state: "visible" }, workbuddy: { tier: "link", state: "missing" } } });
  assert.equal(status.upToDate, false);
  assert.deepEqual(integration.normalizeCompanion(null).fanout, {});

  const data = library.normalizeLibrary({
    entries: [{ name: "skill-control", fanout: { claude: { tier: "link", state: "visible" }, workbuddy: { tier: "link", state: "missing" }, codex: { tier: "native", state: "visible" } } }],
    agents: [
      { agentId: "claude", tier: "link", primary: true },
      { agentId: "codex", tier: "native", primary: true },
      { agentId: "workbuddy", tier: "link", primary: true },
      { agentId: "hermes", tier: "config", primary: true },
    ],
  });
  assert.deepEqual(integration.companionReach(data, status, ["claude", "workbuddy"]), [
    { agentId: "claude", visible: true },
    { agentId: "workbuddy", visible: false },
  ]);
  assert.deepEqual(integration.companionReach(null, status, ["claude", "workbuddy"]).map((row) => row.visible), [true, false], "falls back to the service's status");
  assert.equal(
    integration.companionPlanText(data, ["claude", "codex", "workbuddy", "hermes"], name),
    "放进技能库 ~/.agents/skills/skill-control，再接入 Claude Code（建链接）、WorkBuddy（建链接）、Hermes（加一次额外目录）；Codex 会自动读取，不用改动。",
  );
  const hermesReads = library.normalizeLibrary({
    entries: [{ name: "x", fanout: { hermes: { tier: "config", state: "visible" } } }],
    agents: [
      { agentId: "codex", tier: "native" },
      { agentId: "hermes", tier: "config" },
      { agentId: "claude", tier: "link" },
    ],
  });
  assert.equal(
    integration.companionPlanText(hermesReads, ["claude", "codex", "hermes"], name),
    "放进技能库 ~/.agents/skills/skill-control，再接入 Claude Code（建链接）；Codex 会自动读取、Hermes 已通过额外目录读取，不用改动。",
  );
  assert.ok(integration.CLI_EXAMPLES.every((example) => example.command.startsWith("skill-control ")));
});
