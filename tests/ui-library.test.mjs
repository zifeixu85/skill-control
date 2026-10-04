import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./helpers/load-ts.mjs";

const library = await loadTs("app/lib/library.ts");
const cli = await loadTs("app/lib/cli-tools.ts");
const history = await loadTs("app/lib/history.ts");

const view = {
  root: "~/.agents/skills",
  realRoot: "~/.agents/skills",
  exists: true,
  entries: [
    { name: "rev-1", kind: "link-external", target: "~/.codex/skills/rev-1", fanout: { codex: { tier: "native", state: "visible" }, openclaw: { tier: "native", state: "hidden", reason: "链接的真实路径在库外，该产品拒绝加载" } } },
    { name: "shared-a", kind: "real", fanout: { codex: { tier: "native", state: "duplicate", reason: "自有目录里有相同副本" }, openclaw: { tier: "native", state: "visible" }, hermes: { tier: "config", state: "missing", reason: "skills.external_dirs 中没有库目录" } } },
    { name: "odd", kind: "weird", fanout: { codex: { tier: "?", state: "?" } } },
  ],
  agents: [{ agentId: "codex", name: "Codex", tier: "native", primary: true, collapsed: false }, { agentId: "hermes", tier: "config", collapsed: true }],
  issues: [{ id: "library-external-link", severity: "warn", title: "t", detail: "d", names: ["rev-1"] }],
  trash: [{ trashId: "t1", name: "x", links: ["~/.claude/skills/x"] }],
};

test("library view: kinds, tiers and per-Agent counts with reasons", () => {
  const data = library.normalizeLibrary(view);
  assert.equal(data.entries[2].kind, "real", "unknown kinds fall back");
  assert.equal(data.entries[2].fanout.codex.state, "none");
  assert.equal(data.agents[1].name, "hermes", "name falls back to the id");
  assert.equal(library.TIER_LABELS[data.agents[1].tier], "配置额外目录");
  const codex = library.agentCounts(data, "codex");
  assert.deepEqual([codex.visible, codex.duplicate], [1, 1]);
  const openclaw = library.agentCounts(data, "openclaw");
  assert.equal(openclaw.hidden, 1);
  assert.deepEqual(openclaw.topReasons, ["链接的真实路径在库外，该产品拒绝加载"]);
  assert.ok(library.isLibraryPath("~/.agents/skills/rev-1"));
  assert.ok(!library.isLibraryPath("~/.agents/skills-old/x"));
});

test("library plans: items, choices and the value sent when a box is ticked", () => {
  const plan = library.normalizeLibraryPlan({
    planId: "p",
    action: "batch",
    summary: { adopt: 1, conflict: 1 },
    needsChoice: 1,
    items: [
      { id: "adopt-link:rev-1", title: "收编", kind: "adopt", skill: "rev-1", choices: ["adopt", "skip"], choice: "adopt", steps: [{ type: "move", from: "~/a", to: "~/b" }] },
      { id: "conflict:claude:x", kind: "conflict", skill: "x", agentId: "claude", choices: ["keep-library", "use-this", "save-as", "skip"], choice: "skip", requiresChoice: true, steps: [] },
      { id: "config:hermes", kind: "config", skill: "", choices: ["config", "skip"], choice: "skip", steps: [{ type: "command", command: "hermes config set skills.external_dirs '[\"~/.agents/skills\"]'" }] },
    ],
  });
  assert.equal(plan.items[1].requiresChoice, true);
  assert.equal(library.enabledChoice(plan.items[2]), "config");
  assert.match(plan.items[2].steps[0].command, /^hermes config set skills\.external_dirs/);
  const sections = library.BATCH_SECTIONS.map((section) => plan.items.filter((item) => section.kinds.includes(item.kind)).length);
  assert.equal(sections.reduce((sum, count) => sum + count, 0), 3, "every batch kind has a section");
  const applied = library.normalizeLibraryApply({ results: [{ id: "a", title: "t", status: "rolled-back", error: "e" }], backups: ["~/b"], visibility: { "rev-1": { openclaw: { tier: "native", state: "visible" } } } });
  assert.equal(applied.results[0].status, "rolled-back");
  assert.equal(applied.visibility["rev-1"].openclaw.state, "visible");
});

test("CLI tools: checks explain each column in plain words", () => {
  const [tool] = cli.normalizeCliTools({
    tools: [{
      id: "lark-cli", name: "飞书 CLI", latest: "1.0.97", versionSkew: true,
      binaries: [{ path: "~/.hermes/node/bin/lark-cli", version: "1.0.56", kind: "bundled", via: "bundled" }],
      agents: [
        { agentId: "codex", pathSource: "shell snapshot", resolves: { path: "~/x/lark-cli", version: "1.0.97" }, workspace: "local", workspaceConfigured: true, keychainReachable: "needs-downgrade", skill: { name: "lark-shared", inLibrary: true, visible: true }, allowRule: "missing", sandboxNetwork: "blocked" },
        { agentId: "openclaw", pathSource: "图形界面默认 PATH", resolves: null, workspace: "openclaw", workspaceConfigured: false, allowRule: "n/a" },
      ],
      fixes: [{ id: "wrapper", label: "启动脚本", kind: "self", applicable: false, reason: "没有找到" }, { id: "workspace-binding", label: "绑定", kind: "guide", applicable: true, instructions: "lark-cli config bind --source hermes" }],
    }],
  });
  const codex = cli.agentChecks(tool.agents[0], tool.latest);
  assert.deepEqual(codex.map((check) => check.state), ["ok", "ok", "bad", "ok", "warn", "bad"]);
  const openclaw = cli.agentChecks(tool.agents[1], tool.latest);
  assert.equal(openclaw[0].state, "bad");
  assert.equal(openclaw[0].label, "找不到命令");
  assert.match(openclaw[0].detail, /PATH/);
  assert.equal(openclaw[1].detail, "OpenClaw 工作区还没有配置");
  assert.equal(tool.fixes[1].kind, "guide");
  const plan = cli.normalizeCliPlan({ planId: "p", kind: "self", steps: [{ type: "write", path: "~/.codex/rules/default.rules", diff: "+ x" }], notes: ["n"], skipped: [{ agentId: "hermes", reason: "无需放行" }] });
  assert.equal(plan.kind, "self");
  assert.deepEqual(plan.skipped[0], { agentId: "hermes", reason: "无需放行" });
  assert.equal(cli.normalizeCliPlan({ planId: null, kind: "guide", instructions: "x" }).kind, "guide");
});

test("history, restore, uninstall and trash payloads", () => {
  const entries = history.normalizeHistory({ entries: [
    { id: "h1", at: "2026-10-04T00:00:00Z", action: "sync", skill: "x", agents: ["claude"], backups: [{ agentId: "claude", path: "~/b", target: "~/t", restorable: true }], restorable: true },
    { id: "h0", action: "sync", restorable: false, reason: "旧记录没有恢复信息" },
  ] });
  assert.equal(entries[1].reason, "旧记录没有恢复信息");
  assert.equal(history.HISTORY_ACTION_LABELS[entries[0].action], "安装");
  const plan = history.normalizeRestorePlan({ planId: "p", historyId: "h1", steps: [{ type: "trash-created", agentId: "claude", target: "~/.claude/skills/x", precondition: "abcd" }], warnings: ["之后又被改过"] });
  assert.equal(plan.steps[0].type, "trash-created");
  const uninstall = history.normalizeUninstallPlan({ planId: "u", kind: "link", steps: [{ type: "unlink", path: "~/.claude/skills/x" }], alsoAffects: ["kiro"] });
  assert.equal(uninstall.kind, "link");
  assert.deepEqual(uninstall.alsoAffects, ["kiro"]);
  const trash = history.normalizeTrash({ items: [{ trashId: "a", name: "old", source: "uninstall", removedAt: "2026-10-01" }, { trashId: "b", name: "new", source: "library", removedAt: "2026-10-03" }, { name: "no id" }] });
  assert.deepEqual(trash.map((item) => item.name), ["new", "old"]);
  assert.equal(history.historyIdOf({ historyEntry: { id: "h9" } }), "h9");
  assert.equal(history.historyIdOf(null), null);
});
