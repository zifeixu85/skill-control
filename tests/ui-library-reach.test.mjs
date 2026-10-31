import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./helpers/load-ts.mjs";

const library = await loadTs("app/lib/library.ts");
const review = await loadTs("app/lib/library-review.ts");
const history = await loadTs("app/lib/history.ts");

const names = { claude: "Claude Code", codex: "Codex", workbuddy: "WorkBuddy", hermes: "Hermes", raccoon: "办公小浣熊" };
const name = (id) => names[id] || id;

/** A library of `count` skills; `states[agentId]` maps a skill index to its state (default visible). */
function libraryOf(count, agents, states = {}) {
  return library.normalizeLibrary({
    root: "~/.agents/skills",
    entries: Array.from({ length: count }, (_, index) => ({
      name: `skill-${index}`,
      kind: "real",
      fanout: Object.fromEntries(
        agents.map((agent) => [agent.agentId, { tier: agent.tier, state: states[agent.agentId]?.(index) || "visible", reason: null }]),
      ),
    })),
    agents,
    autoLink: { enabled: true, scope: "primary", pending: { claude: 1, workbuddy: 20, hermes: "x", codex: 0 }, lastRun: { at: "2026-11-01T10:00:00Z", items: [{ skill: "pdf-tools", agents: ["claude", "workbuddy"], historyId: "h-1" }, { skill: "", agents: ["claude"] }] } },
  });
}

const AGENTS = [
  { agentId: "claude", name: "Claude Code", tier: "link", primary: true },
  { agentId: "codex", name: "Codex", tier: "native", primary: true },
  { agentId: "workbuddy", name: "WorkBuddy", tier: "link", primary: true },
  { agentId: "hermes", name: "Hermes", tier: "config", primary: false, configured: false },
];

test("auto-link block: tolerant parse, positive pending counts only, last run without empty items", () => {
  const data = libraryOf(1, AGENTS);
  assert.deepEqual(data.autoLink.pending, { claude: 1, workbuddy: 20 });
  assert.equal(data.autoLink.scope, "primary");
  assert.equal(data.autoLink.lastRun.items.length, 1);
  assert.equal(library.normalizeAutoLink(null), null, "older services send nothing");
  assert.equal(library.normalizeAutoLink({ enabled: true, scope: "everything" }).scope, "primary");
  assert.equal(library.normalizeLibrary({ agents: [{ agentId: "raccoon", tier: "copy" }] }).agents[0].tier, "copy");
  assert.equal(library.normalizeLibrary({ agents: [{ agentId: "x", tier: "teleport" }] }).agents[0].tier, "none");
  assert.equal(library.normalizeLibrary({ agents: [{ agentId: "hermes", tier: "config", configured: false }] }).agents[0].configured, false);
});

test("header sentence: only says 都能用 when no primary Agent misses anything", () => {
  const all = libraryOf(20, AGENTS);
  assert.deepEqual(library.gapSentence(all, ["claude", "codex", "workbuddy"], name), { ok: true, text: "常用 Agent 都能用库里的 20 个技能", note: "", onlySkipped: false });

  const gaps = libraryOf(20, AGENTS, {
    claude: (index) => (index === 3 ? "missing" : index < 3 ? "private-copy" : "visible"),
    workbuddy: () => "missing",
  });
  const sentence = library.gapSentence(gaps, ["claude", "codex", "workbuddy"], name);
  assert.equal(sentence.ok, false);
  assert.equal(sentence.text, "Claude Code 还看不到库里的 1 个技能，WorkBuddy 还看不到 20 个");
  assert.equal(sentence.note, "Claude Code 有 3 个用的是自己的副本，库里更新后不会跟着变。");

  const skipped = libraryOf(3, AGENTS, { claude: (index) => (index === 0 ? "missing" : "visible") });
  skipped.entries[0].fanout.claude.skipped = true;
  const withSkip = library.gapSentence(skipped, ["claude", "codex"], name);
  assert.equal(withSkip.text, "Claude Code 还看不到库里的 1 个技能", "still counted: it can't see it");
  assert.equal(withSkip.note, "其中 1 个是你取消接入的，不会自动接回；需要时在技能详情里接入。");
  assert.equal(withSkip.onlySkipped, true, "nothing to fix: a calm tone");
  assert.equal(sentence.onlySkipped, false);
  assert.equal(library.agentCounts(skipped, "claude").skipped, 1);
  assert.equal(library.normalizeLibrary({ entries: [{ name: "x", fanout: { claude: { tier: "link", state: "missing", skipped: true } } }] }).entries[0].fanout.claude.skipped, true);

  const hidden = libraryOf(2, AGENTS, { codex: () => "hidden" });
  assert.equal(library.gapSentence(hidden, ["codex"], name).text, "Codex 还看不到库里的 2 个技能", "被隐藏 counts as not seeing it");

  const none = libraryOf(2, [{ agentId: "raccoon", name: "办公小浣熊", tier: "none", primary: true }], { raccoon: () => "missing" });
  assert.equal(library.gapSentence(none, ["raccoon"], name).text, "办公小浣熊 不读取技能库");
  assert.deepEqual(library.gapSentence(libraryOf(0, AGENTS), ["claude"], name), { ok: true, text: "技能库里还没有技能", note: "", onlySkipped: false });
});

test("card reasons: why it can't see some, never the reasons of its own copies", () => {
  const data = libraryOf(4, AGENTS, { claude: (index) => (index < 3 ? "private-copy" : "missing") });
  data.entries.forEach((entry, index) => (entry.fanout.claude.reason = index < 3 ? "独立副本" : "没有链接到库"));
  const counts = library.agentCounts(data, "claude");
  assert.deepEqual(counts.topReasons, ["独立副本", "没有链接到库"]);
  assert.deepEqual(counts.gapReasons, ["没有链接到库"]);
});

test("primary Agents come from the service's flags, else the app's list", () => {
  const data = libraryOf(1, AGENTS);
  assert.deepEqual(library.primaryLibraryAgents(data, ["hermes"]), ["claude", "codex", "workbuddy"]);
  const unflagged = libraryOf(1, AGENTS.map((agent) => ({ ...agent, primary: false })));
  assert.deepEqual(library.primaryLibraryAgents(unflagged, ["hermes", "gone"]), ["hermes"]);
});

test("auto-link toast: wording, once per batch, and only recent batches on a fresh Mac", () => {
  assert.equal(library.autoLinkMessage([{ skill: "pdf-tools", agents: ["claude", "workbuddy"] }], name), "已把 pdf-tools 接入 Claude Code、WorkBuddy");
  assert.equal(
    library.autoLinkMessage([{ skill: "a", agents: ["claude"] }, { skill: "b", agents: ["codex", "workbuddy", "hermes"] }], name),
    "已把 a 等 2 个技能 接入 Claude Code、Codex、WorkBuddy 等 4 个 Agent",
  );
  assert.equal(library.autoLinkMessage([], name), "");

  const autoLink = libraryOf(1, AGENTS).autoLink;
  const at = Date.parse("2026-11-01T10:00:00Z");
  const fresh = library.freshAutoLinkRun(autoLink, null, at + 60_000, name);
  assert.deepEqual(fresh, { at: "2026-11-01T10:00:00Z", message: "已把 pdf-tools 接入 Claude Code、WorkBuddy", historyId: "h-1" });
  assert.equal(library.freshAutoLinkRun(autoLink, null, at + 60 * 60_000, name), null, "an old batch is not news on first sight");
  assert.equal(library.freshAutoLinkRun(autoLink, "2026-11-01T10:00:00Z", at + 1, name), null, "already shown");
  assert.ok(library.freshAutoLinkRun(autoLink, "2026-11-01T09:00:00Z", at + 60 * 60_000, name), "newer than the last one shown");
  assert.equal(library.freshAutoLinkRun(null, null, at, name), null);
});

test("补齐接入: pending rows by scope, per-Agent plan counts, Hermes consent", () => {
  const data = libraryOf(3, AGENTS, { hermes: () => "missing" });
  assert.deepEqual(library.pendingRows(data.autoLink, ["claude", "workbuddy"]), [
    { agentId: "claude", count: 1 },
    { agentId: "workbuddy", count: 20 },
  ], "in the header's order");
  assert.deepEqual(library.pendingRows(data.autoLink).map((row) => row.agentId), ["workbuddy", "claude"], "else biggest first");
  assert.deepEqual(library.pendingRows(data.autoLink, ["claude"]), [{ agentId: "claude", count: 1 }]);
  assert.deepEqual(library.pendingRows(null), []);

  const item = (id, agentId, choice = "link", steps = 1) => ({ id, agentId, choice, steps: Array.from({ length: steps }, () => ({ type: "link" })) });
  assert.deepEqual(
    library.catchUpCounts([item("0", "claude"), item("1", "workbuddy"), item("2", "workbuddy"), item("4", "claude", "skip"), item("5", "claude", "link", 0), item("6", null)]),
    [
      { agentId: "claude", count: 1 },
      { agentId: "workbuddy", count: 2 },
    ],
    "in the plan's order, like its sections",
  );

  // The service's own list wins: here it names nobody.
  assert.deepEqual(library.needsConsent(data, ["hermes"]), []);
  const listed = { ...data, autoLink: { ...data.autoLink, needsConfirmation: [{ agentId: "hermes", id: "hermes-external-dirs", title: "t", missing: 3 }] } };
  assert.deepEqual(library.needsConsent(listed, []).map((agent) => agent.agentId), ["hermes"]);
  // Without an autoLink block (older services) it is read from the fanout, within the scope.
  const old = { ...data, autoLink: null };
  assert.deepEqual(library.needsConsent(old, ["claude", "codex", "workbuddy"]), [], "Hermes isn't in scope");
  assert.deepEqual(library.needsConsent(old, ["hermes"]).map((agent) => agent.agentId), ["hermes"]);
  const configured = { ...old, agents: old.agents.map((agent) => (agent.agentId === "hermes" ? { ...agent, configured: true } : agent)) };
  assert.deepEqual(library.needsConsent(configured, ["hermes"]), []);
  const parsed = library.normalizeAutoLink({ enabled: true, next: 2.4, needsConfirmation: [{ agentId: "hermes", missing: 20 }, { missing: 1 }], lastRun: { at: "x", items: [], failed: [{ skill: "a", error: "e" }] } });
  assert.equal(parsed.next, 2);
  assert.deepEqual(parsed.needsConfirmation, [{ agentId: "hermes", id: "", title: "", missing: 20 }]);
  assert.deepEqual(parsed.lastRun.failed, [{ skill: "a", agentId: null, error: "e" }]);
});

test("consent review: scoped to the config item and ticked, never overriding the user's choice", () => {
  const request = review.consentRequest("hermes", "Hermes");
  assert.equal(request.action, "catch-up");
  assert.deepEqual(request.agents, ["hermes"]);
  assert.deepEqual(request.scope, { label: "Hermes 的额外目录", kinds: ["config"], agentId: "hermes", select: true });
  const items = [
    { id: "config:hermes", kind: "config", agentId: "hermes", choice: "skip", choices: ["config", "skip"], steps: [{ type: "command" }] },
    { id: "link:claude:x", kind: "link", agentId: "claude", choice: "link", choices: ["link", "skip"], steps: [{ type: "link" }] },
    { id: "conflict:hermes:y", kind: "conflict", agentId: "hermes", choice: "skip", choices: ["keep-library", "use-this", "skip"], steps: [] },
  ];
  assert.deepEqual(review.preselectItems(items, request.scope, {}).map((item) => item.id), ["config:hermes"]);
  assert.deepEqual(review.preselectItems(items, request.scope, { "config:hermes": "skip" }), [], "the user unticked it");
  assert.deepEqual(review.preselectItems(items, { ...request.scope, select: false }, {}), []);
  assert.deepEqual(review.preselectItems(items, undefined, {}), []);
  assert.equal(library.ITEM_KIND_LABELS.link, "接入（软链接）");
  assert.equal(library.ITEM_KIND_LABELS.unlink, "取消接入");
  assert.equal(library.choiceLabel({ id: "replace:pdf-tools" }, "keep-library").title, "保留库里的版本");
  assert.match(library.choiceLabel({ id: "replace:pdf-tools" }, "use-new").detail, /旧版本先备份/);
  assert.match(library.choiceLabel({ id: "conflict:claude:x" }, "keep-library").detail, /副本先备份/, "same key, other context");
  assert.equal(library.choiceLabel({ id: "x" }, "mystery").title, "mystery");
});

test("tier words: every tier has a label, a hint and a one-liner", () => {
  for (const tier of ["native", "config", "link", "copy", "none"]) {
    assert.ok(library.TIER_LABELS[tier] && library.TIER_HINTS[tier] && library.TIER_SHORT[tier], tier);
  }
  assert.deepEqual(
    ["native", "link", "config", "copy", "none"].map((tier) => library.TIER_LABELS[tier]),
    ["会自动读取技能库", "需要逐个接入", "通过额外目录读取", "需要复制一份", "不读取技能库"],
    "plain words, not 原生读取 / 软链接",
  );
});

test("history titles say which library write it was", () => {
  const [auto, catchUp, install, plain, old] = history.normalizeHistory({
    entries: [
      { id: "a", action: "library", operation: "auto-link", origin: "auto" },
      { id: "b", action: "library", operation: "catch-up" },
      { id: "c", action: "library", operation: "install" },
      { id: "d", action: "library", operation: "something-new" },
      { id: "e", action: "sync" },
    ],
  });
  assert.equal(auto.origin, "auto");
  assert.deepEqual([auto, catchUp, install, plain, old].map(history.historyTitle), ["自动接入", "补齐接入", "安装到技能库", "整理技能库", "安装"]);
});

