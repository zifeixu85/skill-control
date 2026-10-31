import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { computeAutoLink, readAutoLinkState } from "../server/auto-link.mjs";
import { createLibraryService } from "../server/library-service.mjs";
import { createRestoreService } from "../server/restore-service.mjs";
import { writeFixtureFile } from "./fixtures/smartorder.mjs";

const POSIX = process.platform !== "win32";
const LIMIT = { timeout: 30_000, skip: !POSIX };
const skill = (name, body = "") => `---\nname: ${name}\ndescription: ${name} fixture\n---\n# ${name}\n${body}`;

const AGENTS = [
  { id: "codex", name: "Codex", paths: ["~/.codex/skills", "~/.agents/skills"] },
  { id: "claude", name: "Claude Code", paths: ["~/.claude/skills"] },
  { id: "workbuddy", name: "WorkBuddy", paths: ["~/.workbuddy/skills"] },
  { id: "kiro", name: "Kiro", paths: ["~/.kiro/skills"] },
  { id: "hermes", name: "Hermes Agent", paths: ["~/.hermes/skills"] },
  { id: "office-raccoon", name: "办公小浣熊", paths: ["~/.box-agent/skills"] },
];

/** A library with two skills, Claude / WorkBuddy / Kiro folders, a WorkBuddy private copy and Hermes. */
async function setup(context, { primary = ["codex", "claude", "workbuddy"], autoLink = { enabled: true, scope: "primary" }, options = {} } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "auto-link-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const library = path.join(home, ".agents", "skills");
  await writeFixtureFile(library, "old-a/SKILL.md", skill("old-a"));
  await writeFixtureFile(library, "old-b/SKILL.md", skill("old-b"));
  await mkdir(path.join(home, ".claude", "skills"), { recursive: true });
  await mkdir(path.join(home, ".kiro", "skills"), { recursive: true });
  await writeFixtureFile(home, ".workbuddy/skills/old-b/SKILL.md", skill("old-b", "WorkBuddy's own edit"));
  await writeFixtureFile(home, ".hermes/config.yaml", "model:\n  default: x\n");
  await mkdir(path.join(home, ".hermes", "skills"), { recursive: true });
  const stateDirectory = path.join(home, ".agent-skill-manager");
  const settings = { current: autoLink };
  const config = () => ({ agents: AGENTS, primaryAgentIds: primary, library: { installMode: "library", autoLink: settings.current } });
  const common = { homeDirectory: home, homes: [home], stateDirectory, backupDirectory: path.join(stateDirectory, "backups"), historyFile: path.join(stateDirectory, "history.jsonl") };
  const service = createLibraryService({
    ...common,
    getConfig: async () => config(),
    saveAutoLinkSettings: async (value) => {
      settings.current = value;
    },
    autoLink: { noWatch: true, ...options },
  });
  const restore = createRestoreService({ ...common, getScan: async () => null, getAgents: async () => [], materialize: async () => {}, onLinksChanged: (changes) => service.autoLink.record(changes) });
  return { home, library, stateDirectory, service, restore, settings };
}

const addSkill = (library, name) => writeFixtureFile(library, `${name}/SKILL.md`, skill(name));
const isLink = async (file) => (await lstat(file).catch(() => null))?.isSymbolicLink() || false;

test("baseline: skills already in the library are not linked automatically; new ones are, as relative links", LIMIT, async (context) => {
  const { home, library, stateDirectory, service } = await setup(context);
  const before = await service.view();
  assert.deepEqual(before.autoLink.pending, { claude: 2, workbuddy: 1 }, "the baseline gaps (WorkBuddy's own old-b is not a gap)");
  assert.equal(before.autoLink.baselineAt, null, "no run yet");
  assert.deepEqual([before.coverage.workbuddy.privateCopy, before.coverage.claude.missing], [1, 2]);
  assert.deepEqual(before.entries.find((entry) => entry.name === "old-a").fanout.claude, { tier: "link", state: "missing", reason: "没有链接到库", autoLinkable: false, catchUp: true });

  const first = await service.autoLink.run({ reason: "startup" });
  assert.deepEqual([first.connect, first.connected], [[], []], "right after an upgrade nothing happens");
  assert.deepEqual(await readdir(path.join(home, ".claude", "skills")), []);
  const state = await readAutoLinkState(stateDirectory);
  assert.deepEqual([state.baseline.names.sort(), state.baseline.agents.sort()], [["old-a", "old-b"], ["claude", "workbuddy"]]);
  assert.equal((await stat(path.join(stateDirectory, "auto-link.json"))).mode & 0o777, 0o600);

  await addSkill(library, "fresh-skill");
  const second = await service.autoLink.run({ reason: "watch" });
  assert.deepEqual(second.connected.map((item) => [item.skill, item.agents.sort()]), [["fresh-skill", ["claude", "workbuddy"]]]);
  assert.equal(await readlink(path.join(home, ".claude", "skills", "fresh-skill")), path.join("..", "..", ".agents", "skills", "fresh-skill"));
  assert.equal(await readlink(path.join(home, ".workbuddy", "skills", "fresh-skill")), path.join("..", "..", ".agents", "skills", "fresh-skill"));
  assert.equal(await isLink(path.join(home, ".kiro", "skills", "fresh-skill")), false, "not a primary Agent");
  assert.match(await readFile(path.join(home, ".workbuddy", "skills", "old-b", "SKILL.md"), "utf8"), /own edit/u, "an Agent's own copy is never touched");

  const view = await service.view();
  assert.deepEqual(view.autoLink.lastRun.items, [{ skill: "fresh-skill", agents: second.connected[0].agents, unitIds: second.connected[0].unitIds, historyId: second.historyId }]);
  assert.equal(view.entries.find((entry) => entry.name === "fresh-skill").fanout.claude.state, "visible");
  const history = (await readFile(path.join(stateDirectory, "history.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual([history.at(-1).type, history.at(-1).action, history.at(-1).restorable, history.at(-1).items.length], ["library", "auto-link", true, 2]);
  assert.deepEqual((await service.autoLink.run({ reason: "watch" })).connected, [], "nothing more to do");
});

test("a pair is linked once: a link removed by hand, by the app or by undo is not brought back", LIMIT, async (context) => {
  const { home, library, service, restore } = await setup(context);
  await service.autoLink.run({ reason: "startup" });
  await addSkill(library, "new-a");
  await addSkill(library, "new-b");
  const run = await service.autoLink.run({ reason: "watch" });
  assert.equal(run.connected.length, 2);
  // Removed by hand (Finder): the pair is handled, so it stays removed.
  await unlink(path.join(home, ".claude", "skills", "new-a"));
  assert.deepEqual((await service.autoLink.run({ reason: "watch" })).connected, []);
  // Removed in the app ("取消接入"): a tombstone.
  const unlinkPlan = await service.plan({ action: "unlink", skill: "new-b", agents: ["claude"] });
  await service.apply({ planId: unlinkPlan.planId, confirm: true });
  assert.ok((await service.autoLink.readState()).skip["claude:new-b"]);
  assert.equal((await service.view()).entries.find((entry) => entry.name === "new-b").fanout.claude.skipped, true);
  assert.deepEqual((await service.autoLink.run({ reason: "watch" })).connected, []);
  // Linking it again by hand clears the tombstone.
  const linkPlan = await service.plan({ action: "link", skill: "new-b", agents: ["claude"] });
  await service.apply({ planId: linkPlan.planId, confirm: true });
  assert.equal((await service.autoLink.readState()).skip["claude:new-b"], undefined);
  // Undoing one skill of an auto-link run from history: removed, tombstoned, not relinked.
  const undo = await restore.planRestore({ historyId: run.historyId, select: run.connected.find((item) => item.skill === "new-b").unitIds.filter((id) => id.includes("workbuddy")) });
  await restore.applyRestore({ planId: undo.planId, confirm: true });
  assert.equal(await isLink(path.join(home, ".workbuddy", "skills", "new-b")), false);
  assert.ok((await service.autoLink.readState()).skip["workbuddy:new-b"]);
  assert.deepEqual((await service.autoLink.run({ reason: "watch" })).connected, []);
});

test("turning auto-link off and on records a fresh baseline; scope 'all' adds Agents with their own baseline", LIMIT, async (context) => {
  const { home, library, service, settings } = await setup(context);
  await service.autoLink.run({ reason: "startup" });
  await service.autoLink.setSettings({ enabled: false });
  await addSkill(library, "while-off");
  assert.deepEqual((await service.autoLink.run({ reason: "watch" })).connected, [], "off: nothing");
  const block = (await service.view()).autoLink;
  assert.deepEqual([block.enabled, block.pending.claude], [false, 3], "while off every gap is a catch-up candidate");
  await service.autoLink.setSettings({ enabled: true });
  assert.equal(settings.current.enabled, true);
  assert.equal(await isLink(path.join(home, ".claude", "skills", "while-off")), false, "added while off: part of the new baseline");
  // Scope "all": Kiro (link tier, own folder) joins with its own baseline, so no burst.
  await service.autoLink.setSettings({ scope: "all" });
  assert.deepEqual(await readdir(path.join(home, ".kiro", "skills")), []);
  const state = await service.autoLink.readState();
  assert.ok(state.agentBaselines.kiro && state.agentBaselines["office-raccoon"] === undefined, "办公小浣熊 has no folder, so it is not in scope");
  await addSkill(library, "after-all");
  const run = await service.autoLink.run({ reason: "watch" });
  assert.deepEqual(run.connected[0].agents.sort(), ["claude", "kiro", "workbuddy"]);
  // Hermes is in scope but its config is never changed automatically.
  assert.deepEqual(run.needsConfirmation.map((item) => [item.agentId, item.id]), [["hermes", "hermes-external-dirs"]]);
});

test("agents that skip links get a copy; Hermes needs a confirmation; the catch-up plan fills baseline gaps", LIMIT, async (context) => {
  const { home, library, service } = await setup(context, { primary: ["codex", "claude", "office-raccoon", "hermes"] });
  await mkdir(path.join(home, ".box-agent", "skills"), { recursive: true });
  await service.autoLink.run({ reason: "startup" });
  await addSkill(library, "copied");
  const run = await service.autoLink.run({ reason: "watch" });
  assert.deepEqual(run.connected[0].agents.sort(), ["claude", "office-raccoon"]);
  const copy = path.join(home, ".box-agent", "skills", "copied");
  assert.equal((await lstat(copy)).isDirectory(), true, "a real folder, not a link");
  const view = await service.view();
  assert.deepEqual(view.entries.find((entry) => entry.name === "copied").fanout["office-raccoon"].state, "visible");
  assert.equal(view.agents.find((agent) => agent.agentId === "office-raccoon").method, "复制");
  assert.deepEqual(view.autoLink.needsConfirmation.map((item) => [item.agentId, item.missing]), [["hermes", 3]]);

  // Catch-up: the baseline gaps per Agent, Hermes' config change as an opt-in item.
  const plan = await service.autoLink.catchUpPlan({});
  assert.deepEqual(plan.byAgent, { claude: { link: 2 }, "office-raccoon": { copy: 2 } });
  const hermes = plan.items.find((item) => item.id === "hermes-external-dirs");
  assert.deepEqual([hermes.choice, hermes.steps], ["skip", []], "Hermes' config only changes when chosen");
  const applied = await service.apply({ planId: plan.planId, confirm: true });
  assert.ok(applied.results.every((result) => result.status === "applied"));
  assert.deepEqual([applied.historyEntry.action, applied.historyEntry.items.length], ["catch-up", 4]);
  const after = await service.view();
  assert.deepEqual(after.autoLink.pending, {});
  assert.deepEqual([after.coverage.claude.missing, after.coverage["office-raccoon"].missing], [0, 0]);
  // Choosing Hermes in the catch-up plan writes its config (with a backup).
  const configure = await service.autoLink.catchUpPlan({ agents: ["hermes"], choices: { "hermes-external-dirs": "configure" } });
  await service.apply({ planId: configure.planId, confirm: true });
  assert.match(await readFile(path.join(home, ".hermes", "config.yaml"), "utf8"), /external_dirs/u);
  assert.equal((await service.view()).coverage.hermes.missing, 0);
});

test("file-system watching: a skill dropped into the library is linked after the debounce", LIMIT, async (context) => {
  // An injected watcher (the test fires its events) and the run hook: no timing guesses.
  const listeners = new Map();
  const watchImpl = (directory, options, listener) => {
    listeners.set(directory, listener);
    return { close: () => listeners.delete(directory), on: () => {} };
  };
  const runs = [];
  let notify = null;
  const onRun = (record) => {
    runs.push(record);
    notify?.();
  };
  const { home, library, service } = await setup(context, { options: { noWatch: false, debounceMs: 20, watchImpl, onRun } });
  await service.autoLink.run({ reason: "startup" });
  await service.autoLink.start();
  context.after(() => service.autoLink.stop());
  assert.ok(listeners.has(library), "the library folder is watched");
  assert.ok(listeners.has(path.join(home, ".claude", "skills")), "and the in-scope Agents' link folders");
  await addSkill(library, "dropped-in");
  const linked = new Promise((resolve) => {
    notify = () => runs.some((record) => record.items.some((item) => item.skill === "dropped-in")) && resolve();
  });
  listeners.get(library)("rename", "dropped-in");
  await linked;
  assert.equal(await isLink(path.join(home, ".claude", "skills", "dropped-in")), true);
  assert.equal(runs.at(-1).reason, "watch");
  assert.equal((await service.view()).autoLink.watching, true);
});

test("read-only: describe and dry runs never write", LIMIT, async (context) => {
  const { home, library, stateDirectory } = await setup(context);
  const service = createLibraryService({ homeDirectory: home, stateDirectory, backupDirectory: path.join(stateDirectory, "b"), historyFile: path.join(stateDirectory, "h.jsonl"), getConfig: async () => ({ agents: AGENTS, primaryAgentIds: ["claude"], library: { installMode: "library", autoLink: { enabled: true, scope: "primary" } } }), readOnly: true, autoLink: { noWatch: true } });
  await addSkill(library, "new-x");
  const run = await service.autoLink.run({ reason: "cli" });
  assert.deepEqual([run.dryRun, run.connect.length], [true, 0], "first run: everything is baseline");
  await assert.rejects(service.apply({ planId: "x", confirm: true }), (error) => error.code === "plan-not-found" || error.code === "read-only");
  assert.equal(await stat(stateDirectory).catch(() => null), null, "no state folder at all");
});

test("computeAutoLink: broken entries and invalid names are skipped; an Agent without a folder cannot be linked", () => {
  const entries = [
    { name: "ok", kind: "real", fanout: { claude: { state: "missing" }, kiro: { state: "missing" } } },
    { name: "broken", kind: "broken", fanout: { claude: { state: "missing" } } },
    { name: "bad/name", kind: "real", fanout: { claude: { state: "missing" } } },
  ];
  const agents = [
    { agentId: "claude", primary: true, linkDir: "/x/.claude/skills" },
    { agentId: "kiro", primary: true, linkDir: null },
  ];
  const state = { baseline: { at: "2026-11-01T00:00:00.000Z", names: [], agents: ["claude", "kiro"] }, agentBaselines: {}, handled: {}, skip: {}, runs: [] };
  const decision = computeAutoLink({ entries, agents, settings: { enabled: true, scope: "primary" }, state });
  assert.deepEqual(decision.connect, [{ agentId: "claude", skill: "ok" }]);
});
