import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./helpers/load-ts.mjs";

const model = await loadTs("app/lib/skill-model.ts");

function instance(overrides) {
  return {
    id: overrides.id,
    agentId: overrides.agentId,
    agentName: overrides.agentId,
    root: `~/.${overrides.agentId}/skills`,
    path: `~/.${overrides.agentId}/skills/${overrides.name || "demo"}`,
    directoryName: overrides.name || "demo",
    name: overrides.name || "demo",
    displayName: overrides.name || "demo",
    hash: overrides.hash || "aaaa",
    shortHash: (overrides.hash || "aaaa").slice(0, 8),
    fileCount: 1,
    byteCount: 10,
    modifiedAt: overrides.modifiedAt || "2026-09-01T00:00:00.000Z",
    isSymlink: false,
    source: "local",
    managed: false,
    realPathId: overrides.realPathId || overrides.id,
    ...overrides,
  };
}

function skill(overrides) {
  return {
    id: overrides.id || "s1",
    name: overrides.name || "demo",
    displayName: overrides.displayName || overrides.name || "demo",
    description: overrides.description || "A demo skill",
    descriptionZh: overrides.descriptionZh ?? null,
    tags: overrides.tags || [],
    status: "single",
    conflict: false,
    coverage: 0,
    installedAgentIds: [],
    missingAgentIds: [],
    hashes: [],
    modifiedAt: null,
    fileCount: 1,
    duplicates: overrides.duplicates || [],
    primaryStatus: overrides.primaryStatus || "ok",
    newest: overrides.newest || null,
    instances: overrides.instances || [],
  };
}

function context({ primary = ["codex", "claude"], plugins = [], agents = [], usage = new Map() } = {}) {
  const agentList = agents.length ? agents : primary.map((id) => ({ id, name: id }));
  return {
    primary,
    agents: new Map(agentList.map((agent) => [agent.id, agent])),
    pluginSkills: model.buildPluginSkillIndex(plugins),
    usage,
  };
}

test("slots distinguish installed, read-only, plugin-provided, refused and missing", () => {
  const ctx = context({
    primary: ["codex", "claude", "hermes", "qclaw", "gemini"],
    agents: [
      { id: "codex", name: "Codex" },
      { id: "claude", name: "Claude Code" },
      { id: "hermes", name: "Hermes Agent" },
      { id: "qclaw", name: "QClaw", refuseInstall: "QClaw 的技能由 QClaw 同步管理，请在 QClaw 里安装。" },
      { id: "gemini", name: "Gemini CLI" },
    ],
    plugins: [
      { agentId: "claude", enabled: true, displayName: "Docs Plugin", name: "docs", components: { skills: ["skills/demo"] } },
    ],
  });
  const view = model.buildSkillView(
    skill({
      instances: [
        instance({ id: "a", agentId: "codex" }),
        instance({ id: "b", agentId: "hermes", source: "hermes-hub", readOnly: true }),
      ],
    }),
    ctx,
  );
  assert.equal(view.slots.codex.kind, "installed");
  assert.equal(view.slots.hermes.kind, "readonly");
  assert.match(view.slots.hermes.reason, /Skills Hub/);
  assert.equal(view.slots.claude.kind, "plugin");
  assert.match(view.slots.claude.label, /Docs Plugin/);
  assert.equal(view.slots.qclaw.kind, "refused");
  assert.equal(view.slots.gemini.kind, "missing");
  assert.equal(view.slots.gemini.label, "装到 Gemini CLI");
});

test("disabled plugins do not provide skills and Codex system copies are read-only", () => {
  const ctx = context({
    plugins: [{ agentId: "claude", enabled: "unknown", displayName: "X", name: "x", components: { skills: ["demo"] } }],
  });
  const view = model.buildSkillView(
    skill({ instances: [instance({ id: "a", agentId: "codex", source: "codex-system", readOnly: true })] }),
    ctx,
  );
  assert.equal(view.slots.claude.kind, "missing");
  assert.equal(view.slots.codex.kind, "readonly");
  assert.ok(model.isReadOnlyInstance(view.skill.instances[0]));
});

test("copies count distinct real directories and honor declared duplicates", () => {
  const ctx = context();
  const view = model.buildSkillView(
    skill({
      duplicates: [{ agentId: "codex", count: 3, identical: false }],
      instances: [
        instance({ id: "a", agentId: "codex", realPathId: "r1" }),
        instance({ id: "b", agentId: "codex", realPathId: "r1" }),
        instance({ id: "c", agentId: "codex", realPathId: "r2" }),
        instance({ id: "d", agentId: "claude", realPathId: "r1" }),
      ],
    }),
    ctx,
  );
  assert.equal(model.distinctCopies(view.writable.codex), 2);
  assert.equal(view.slots.codex.copies, 3);
  assert.equal(view.multi, true);
  const groups = model.groupCopies(view, ["codex", "claude"]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.find((group) => group.key === "r1").agentIds.sort(), ["claude", "codex"]);
});

test("filters: both, only, none, multi and differs (differs excludes multi)", () => {
  const ctx = context();
  const views = [
    skill({ id: "both", instances: [instance({ id: "1", agentId: "codex" }), instance({ id: "2", agentId: "claude" })] }),
    skill({ id: "codex", instances: [instance({ id: "3", agentId: "codex" })] }),
    skill({ id: "none", instances: [instance({ id: "4", agentId: "cursor" })] }),
    skill({
      id: "multi",
      primaryStatus: "differs",
      duplicates: [{ agentId: "claude", count: 2, identical: false }],
      instances: [instance({ id: "5", agentId: "claude" }), instance({ id: "6", agentId: "claude", realPathId: "x" })],
    }),
    skill({
      id: "differs",
      primaryStatus: "differs",
      instances: [instance({ id: "7", agentId: "codex", hash: "b" }), instance({ id: "8", agentId: "claude", hash: "c" })],
    }),
  ].map((item) => model.buildSkillView(item, ctx));
  const chips = model.filterChips(views, ctx.primary, { codex: "Codex", claude: "Claude Code" });
  const count = (id) => chips.find((chip) => chip.id === id).count;
  assert.equal(count("all"), 5);
  assert.equal(count("both"), 2);
  assert.equal(count("only:codex"), 1);
  assert.equal(count("only:claude"), 1);
  assert.equal(count("none"), 1);
  assert.equal(count("multi"), 1);
  assert.equal(count("differs"), 1);
  assert.equal(chips.find((chip) => chip.id === "both").label, "两边都有");
  assert.ok(model.matchesFilter(views[2], "agent:cursor", ctx.primary));
});

test("search matches names, descriptions and tags; sort puts used skills first", () => {
  const usage = new Map([["beta", { codex: 4 }]]);
  const ctx = context({ usage });
  const views = [
    model.buildSkillView(skill({ id: "a", name: "alpha", descriptionZh: "整理笔记", tags: ["notes"] }), ctx),
    model.buildSkillView(skill({ id: "b", name: "beta" }), ctx),
  ];
  assert.ok(model.matchesQuery(views[0], "笔记"));
  assert.ok(model.matchesQuery(views[0], "NOTES"));
  assert.ok(!model.matchesQuery(views[1], "笔记"));
  assert.equal(views[0].summary, "整理笔记");
  assert.deepEqual(model.sortViews(views).map((view) => view.id), ["b", "a"]);
});

test("usage index merges summary counts (incl. plugin:skill) with product counters", () => {
  const skills = [
    skill({ name: "demo", instances: [instance({ id: "h", agentId: "hermes", usage: { count: 7 } })] }),
  ];
  const index = model.buildUsageIndex(skills, [
    { name: "demo", count: 3, byAgent: { codex: 3 } },
    { name: "plugin:other", count: 2, byAgent: { claude: 2 } },
  ]);
  assert.deepEqual(index.get("demo"), { codex: 3, hermes: 7 });
  assert.deepEqual(index.get("other"), { claude: 2 });
});

test("install source prefers the newest copy, then writable primary copies", () => {
  const ctx = context();
  const base = skill({
    instances: [
      instance({ id: "sys", agentId: "codex", source: "codex-system", readOnly: true, modifiedAt: "2026-10-01T00:00:00Z" }),
      instance({ id: "user", agentId: "codex", modifiedAt: "2026-09-01T00:00:00Z" }),
      instance({ id: "cursor", agentId: "cursor", modifiedAt: "2026-10-02T00:00:00Z" }),
    ],
  });
  assert.equal(model.pickSourceInstance(model.buildSkillView(base, ctx), "claude", ctx.primary).id, "user");
  const withNewest = { ...base, newest: { agentId: "cursor", instanceId: "cursor", modifiedAt: null, version: null, shortHash: "x" } };
  assert.equal(model.pickSourceInstance(model.buildSkillView(withNewest, ctx), "claude", ctx.primary).id, "cursor");
  assert.equal(model.pickSourceInstance(model.buildSkillView(skill({ instances: [] }), ctx), "claude", ctx.primary), null);
});
