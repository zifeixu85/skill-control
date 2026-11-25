import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { lstat, mkdtemp, readFile, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { computeAutoLink } from "../server/auto-link.mjs";
import { createLibraryService } from "../server/library-service.mjs";
import { removeCodexSwitch } from "../server/library-switches.mjs";
import { PAUSED_FILE } from "../server/paused-skills.mjs";
import { createRestoreService } from "../server/restore-service.mjs";
import { createLibraryHome, libraryAgents } from "./fixtures/library.mjs";

const POSIX = process.platform !== "win32";
const LIMIT = { timeout: 30_000, skip: !POSIX };

async function setup(context) {
  const home = await mkdtemp(path.join(tmpdir(), "pause-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await createLibraryHome(home);
  const stateDirectory = path.join(home, ".agent-skill-manager");
  const service = createLibraryService({
    homeDirectory: home,
    homes: [home],
    stateDirectory,
    backupDirectory: path.join(stateDirectory, "backups"),
    historyFile: path.join(stateDirectory, "history.jsonl"),
    getConfig: async () => ({ agents: libraryAgents(home), primaryAgentIds: ["codex", "claude"] }),
    findCommand: async () => null,
  });
  return { home, service, stateDirectory };
}

const exists = async (target) => Boolean(await lstat(target).catch(() => null));
const entryOf = (view, name) => view.entries.find((entry) => entry.name === name);
const CODEX_CONFIG = 'model = "gpt-5"\n\n# trusted folders\n[projects."/work"]\ntrust_level = "trusted"\n';

test("pause turns a skill off in each Agent its own way, and resume puts back exactly that", LIMIT, async (context) => {
  const { service, home, stateDirectory } = await setup(context);
  const codexConfig = path.join(home, ".codex", "config.toml");
  await fs.writeFile(codexConfig, CODEX_CONFIG);

  const plan = await service.plan({ action: "pause", skill: "lark-shared" });
  const byAgent = Object.fromEntries(plan.items.map((item) => [item.agentId, item]));
  assert.deepEqual(Object.keys(byAgent).sort(), ["codex", "hermes", "kiro", "openclaw"], "Claude has no copy of lark-shared");
  assert.deepEqual([byAgent.codex.kind, byAgent.openclaw.kind, byAgent.kiro.kind], ["pause", "pause", "pause"]);
  assert.match(byAgent.codex.steps[0].diff, /name = "lark-shared"\n\+ enabled = false/u);
  assert.deepEqual(byAgent.kiro.steps.map((step) => step.type), ["unlink"]);
  // Hermes has a switch, but without its CLI it is left to the user.
  assert.deepEqual([byAgent.hermes.kind, byAgent.hermes.choice, byAgent.hermes.steps], ["unpausable", "skip", []]);
  await service.apply({ planId: plan.planId, confirm: true });

  assert.match(await readFile(codexConfig, "utf8"), /\[\[skills\.config\]\]\nname = "lark-shared"\nenabled = false\n$/u);
  assert.equal(await exists(path.join(home, ".kiro", "skills", "lark-shared")), false);
  let view = await service.view();
  assert.deepEqual([...entryOf(view, "lark-shared").paused.agents].sort(), ["codex", "kiro", "openclaw"]);
  assert.ok(Date.parse(entryOf(view, "lark-shared").paused.since));
  assert.equal(entryOf(view, "lark-shared").fanout.kiro.paused, true);
  assert.equal(entryOf(view, "lark-shared").fanout.hermes.paused, undefined, "Hermes is still on");
  assert.equal(entryOf(view, "shared-a").paused, undefined);

  // Codex rewrites its config while the skill is paused: resume removes only its own table.
  await fs.appendFile(codexConfig, '\n[projects."/other"]\ntrust_level = "trusted"\n');
  const resume = await service.plan({ action: "resume", skill: "lark-shared" });
  assert.deepEqual(resume.items.map((item) => [item.agentId, item.kind]).sort(), [["codex", "resume"], ["kiro", "resume"], ["openclaw", "resume"]]);
  const result = await service.apply({ planId: resume.planId, confirm: true });
  assert.deepEqual(result.results.filter((item) => item.status !== "applied"), []);
  assert.equal(await readFile(codexConfig, "utf8"), `${CODEX_CONFIG}\n[projects."/other"]\ntrust_level = "trusted"\n`);
  assert.deepEqual(JSON.parse(await readFile(path.join(home, ".openclaw", "openclaw.json"), "utf8")), { skills: { entries: {} } });
  assert.equal(await readlink(path.join(home, ".kiro", "skills", "lark-shared")), path.join("..", "..", ".agents", "skills", "lark-shared"));
  view = await service.view();
  assert.equal(entryOf(view, "lark-shared").paused, undefined);
  assert.deepEqual(["codex", "kiro", "openclaw"].map((agentId) => entryOf(view, "lark-shared").fanout[agentId].state), ["visible", "visible", "visible"]);
  assert.deepEqual(JSON.parse(await readFile(path.join(stateDirectory, PAUSED_FILE), "utf8")).skills, {});
  await assert.rejects(service.plan({ action: "resume", skill: "lark-shared" }), /没有暂停/u);
});

test("a link-tier Agent's own copy is moved aside while paused and put back on resume", LIMIT, async (context) => {
  const { service, home } = await setup(context);
  const copy = path.join(home, ".claude", "skills", "shared-b");
  const plan = await service.plan({ action: "pause", skill: "shared-b" });
  const claude = plan.items.find((item) => item.agentId === "claude");
  assert.deepEqual([claude.kind, claude.steps.map((step) => step.type)], ["pause", ["stash"]]);
  assert.match(claude.steps[0].to, /^~\/\.agent-skill-manager\/paused\//u);
  await service.apply({ planId: plan.planId, confirm: true });
  assert.equal(await exists(copy), false);
  assert.ok(entryOf(await service.view(), "shared-b").paused.agents.includes("claude"));

  // Something new took the name meanwhile: resume leaves both alone and says where the copy is.
  await fs.mkdir(copy);
  let resume = await service.plan({ action: "resume", skill: "shared-b" });
  assert.match(resume.items.find((item) => item.agentId === "claude").title, /原来的位置已经有同名的 shared-b，移开的那份还在 ~\/\.agent-skill-manager\/paused\//u);
  await fs.rmdir(copy);
  resume = await service.plan({ action: "resume", skill: "shared-b" });
  assert.deepEqual(resume.items.find((item) => item.agentId === "claude").steps.map((step) => step.type), ["move"]);
  await service.apply({ planId: resume.planId, confirm: true });
  assert.match(await readFile(path.join(copy, "SKILL.md"), "utf8"), /claude edit/u);
  assert.equal(entryOf(await service.view(), "shared-b").paused, undefined);
});

test("a pause ends when what it did is undone by hand", LIMIT, async (context) => {
  const { service, home } = await setup(context);
  const plan = await service.plan({ action: "pause", skill: "lark-shared", choices: { "pause:codex:lark-shared": "skip", "pause:openclaw:lark-shared": "skip" } });
  assert.deepEqual(plan.items.filter((item) => item.choice !== "skip").map((item) => item.agentId), ["kiro"]);
  await service.apply({ planId: plan.planId, confirm: true });
  assert.deepEqual(entryOf(await service.view(), "lark-shared").paused.agents, ["kiro"]);
  await symlink(path.join("..", "..", ".agents", "skills", "lark-shared"), path.join(home, ".kiro", "skills", "lark-shared"));
  assert.equal(entryOf(await service.view(), "lark-shared").paused, undefined);
});

test("auto-link leaves paused skills alone and keeps their baseline", () => {
  const entries = [
    { name: "a", kind: "real", fanout: { claude: { state: "missing" } } },
    { name: "b", kind: "real", fanout: { claude: { state: "missing" } } },
  ];
  const agents = [{ agentId: "claude", primary: true, linkDir: "/x/.claude/skills" }];
  const state = { baseline: { at: "2026-01-01T00:00:00.000Z", names: ["a"], agents: ["claude"] }, agentBaselines: {}, handled: {}, skip: {}, runs: [] };
  const decision = computeAutoLink({ entries, agents, settings: { enabled: true, scope: "primary" }, state, paused: new Set(["b"]) });
  assert.deepEqual(decision.connect, []);
  assert.deepEqual(decision.pending, { claude: ["a"] });
  assert.deepEqual(decision.state.baseline.names, ["a"]);
  assert.equal(decision.flags.get("claude:b").skipped, true);
});

test("removing Codex's switch keeps every other line and refuses tables it did not write", () => {
  const text = 'model = "x"\n\n[[skills.config]]\nname = "a"\nenabled = false\n\n# keep\n[projects."/x"]\ntrust_level = "trusted"\n\n[[skills.config]]\nname = "b"\nenabled = false\n';
  assert.equal(removeCodexSwitch(text, "a"), 'model = "x"\n\n# keep\n[projects."/x"]\ntrust_level = "trusted"\n\n[[skills.config]]\nname = "b"\nenabled = false\n');
  assert.equal(removeCodexSwitch(text, "b"), 'model = "x"\n\n[[skills.config]]\nname = "a"\nenabled = false\n\n# keep\n[projects."/x"]\ntrust_level = "trusted"\n');
  assert.equal(removeCodexSwitch(text, "c"), null);
  assert.equal(removeCodexSwitch('[[skills.config]]\nname = "a"\nenabled = false\npath = "/x"\n', "a"), null, "a table with more settings is the user's");
});

test("resume keeps the Agents left unticked paused, and a later run drops ones turned back on by hand", LIMIT, async (context) => {
  const { service, home } = await setup(context);
  await fs.writeFile(path.join(home, ".codex", "config.toml"), CODEX_CONFIG);
  const plan = await service.plan({ action: "pause", skill: "lark-shared" });
  await service.apply({ planId: plan.planId, confirm: true });
  const resume = await service.plan({ action: "resume", skill: "lark-shared", choices: { "resume:codex:lark-shared": "skip" } });
  await service.apply({ planId: resume.planId, confirm: true });
  let view = await service.view();
  assert.deepEqual(entryOf(view, "lark-shared").paused.agents, ["codex"], "Codex stays paused and can still be resumed");
  assert.equal(entryOf(view, "lark-shared").fanout.codex.paused, true);

  // Codex is switched back on by hand; the next library run forgets that pause, so a later
  // manual 停用 is not taken for one.
  await fs.writeFile(path.join(home, ".codex", "config.toml"), CODEX_CONFIG);
  const other = await service.plan({ action: "pause", skill: "shared-b", choices: { "pause:claude:shared-b": "skip" } });
  await service.apply({ planId: other.planId, confirm: true });
  const disable = await service.plan({ action: "disable", skill: "lark-shared", agents: ["codex"] });
  await service.apply({ planId: disable.planId, confirm: true });
  view = await service.view();
  assert.equal(entryOf(view, "lark-shared").paused, undefined);
  assert.equal(entryOf(view, "lark-shared").fanout.codex.state, "hidden");
});

test("undo from history ends a pause, and undoing a resume pauses again", LIMIT, async (context) => {
  const { service, home, stateDirectory } = await setup(context);
  const restore = createRestoreService({
    homeDirectory: home,
    homes: [home],
    stateDirectory,
    backupDirectory: path.join(stateDirectory, "backups"),
    historyFile: path.join(stateDirectory, "history.jsonl"),
    getScan: async () => ({ skills: [] }),
    getAgents: async () => [],
    materialize: async () => null,
    onLinksChanged: (changes) => service.afterRestore(changes),
  });
  const undo = async (historyId) => {
    const plan = await restore.planRestore({ historyId });
    return restore.applyRestore({ planId: plan.planId, confirm: true });
  };
  const paused = await service.apply({ planId: (await service.plan({ action: "pause", skill: "lark-shared" })).planId, confirm: true });
  await undo(paused.historyEntry.id);
  assert.equal(entryOf(await service.view(), "lark-shared").paused, undefined);
  assert.deepEqual(JSON.parse(await readFile(path.join(stateDirectory, PAUSED_FILE), "utf8")).skills, {});

  await service.apply({ planId: (await service.plan({ action: "pause", skill: "lark-shared" })).planId, confirm: true });
  const resumed = await service.apply({ planId: (await service.plan({ action: "resume", skill: "lark-shared" })).planId, confirm: true });
  await undo(resumed.historyEntry.id);
  const view = await service.view();
  assert.deepEqual([...entryOf(view, "lark-shared").paused.agents].sort(), ["codex", "kiro", "openclaw"]);
  const again = await service.plan({ action: "resume", skill: "lark-shared" });
  assert.equal(again.items.filter((item) => item.kind === "resume").length, 3);
});

test("a planned config edit does not run over a file the Agent changed meanwhile", LIMIT, async (context) => {
  const { service, home } = await setup(context);
  const codexConfig = path.join(home, ".codex", "config.toml");
  await fs.writeFile(codexConfig, CODEX_CONFIG);
  const plan = await service.plan({ action: "pause", skill: "lark-shared" });
  await fs.appendFile(codexConfig, '\n[projects."/new"]\ntrust_level = "trusted"\n');
  const result = await service.apply({ planId: plan.planId, confirm: true });
  const codex = result.results.find((item) => item.agentId === "codex");
  assert.equal(codex.status, "failed");
  assert.match(codex.error, /在生成计划后被改过/u);
  assert.doesNotMatch(await readFile(codexConfig, "utf8"), /skills\.config/u);
  assert.deepEqual([...entryOf(await service.view(), "lark-shared").paused.agents].sort(), ["kiro", "openclaw"]);
});

test("an Agent folder outside the home is left alone by a pause", LIMIT, async (context) => {
  const { home } = await setup(context);
  const outside = await mkdtemp(path.join(tmpdir(), "pause-outside-"));
  context.after(() => rm(outside, { recursive: true, force: true }));
  await fs.mkdir(path.join(outside, "skills"), { recursive: true });
  await symlink(path.join(home, ".agents", "skills", "lark-shared"), path.join(outside, "skills", "lark-shared"));
  const stateDirectory = path.join(home, ".agent-skill-manager");
  const agents = libraryAgents(home).map((agent) => (agent.id === "kiro" ? { ...agent, paths: [path.join(outside, "skills")] } : agent));
  const service = createLibraryService({
    homeDirectory: home,
    homes: [home],
    stateDirectory,
    backupDirectory: path.join(stateDirectory, "backups"),
    historyFile: path.join(stateDirectory, "history.jsonl"),
    getConfig: async () => ({ agents, primaryAgentIds: ["codex", "claude"] }),
    findCommand: async () => null,
  });
  const plan = await service.plan({ action: "pause", skill: "lark-shared" });
  const kiro = plan.items.find((item) => item.agentId === "kiro");
  assert.deepEqual([kiro.kind, kiro.steps], ["unpausable", []]);
  assert.match(kiro.title, /不在主目录下/u);
});
