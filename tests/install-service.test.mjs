import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { contentHash } from "../server/fs-links.mjs";
import { createInstallService } from "../server/install-service.mjs";
import { createLibraryService } from "../server/library-service.mjs";
import { writeFixtureFile } from "./fixtures/smartorder.mjs";

const POSIX = process.platform !== "win32";
const LIMIT = { timeout: 30_000, skip: !POSIX };
const skill = (name, body = "") => `---\nname: ${name}\ndescription: ${name} fixture\n---\n# ${name}\n${body}`;
const AGENTS = [
  { id: "codex", name: "Codex", paths: ["~/.codex/skills", "~/.agents/skills"] },
  { id: "claude", name: "Claude Code", paths: ["~/.claude/skills"] },
  { id: "workbuddy", name: "WorkBuddy", paths: ["~/.workbuddy/skills"] },
  { id: "kiro", name: "Kiro", paths: ["~/.kiro/skills"] },
];

async function setup(context, { installMode = "library", primary = ["codex", "claude", "workbuddy"] } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "install-service-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await writeFixtureFile(home, ".agents/skills/existing/SKILL.md", skill("existing"));
  await mkdir(path.join(home, ".claude", "skills"), { recursive: true });
  await writeFixtureFile(home, ".workbuddy/skills/shared/SKILL.md", skill("shared"));
  await writeFixtureFile(home, "imports/shared/SKILL.md", skill("shared"));
  await writeFixtureFile(home, "imports/existing/SKILL.md", skill("existing", "a newer version"));
  const stateDirectory = path.join(home, ".agent-skill-manager");
  const getConfig = async () => ({ agents: AGENTS, primaryAgentIds: primary, library: { installMode, autoLink: { enabled: true, scope: "primary" } } });
  const library = createLibraryService({ homeDirectory: home, stateDirectory, backupDirectory: path.join(stateDirectory, "backups"), historyFile: path.join(stateDirectory, "history.jsonl"), getConfig, autoLink: { noWatch: true } });
  const perAgentCalls = [];
  const installs = createInstallService({
    library,
    getConfig,
    resolveSource: async (source) => {
      const sourcePath = path.join(home, "imports", source.importId);
      return { sourcePath, name: source.importId, sourceHash: await contentHash(sourcePath), label: source.importId };
    },
    perAgent: {
      plan: async (input) => {
        perAgentCalls.push(["plan", input]);
        return { actions: input.targetAgentIds.map((agentId) => ({ agentId, action: "create" })) };
      },
      apply: async (input) => {
        perAgentCalls.push(["apply", input]);
        return { actions: [], historyEntry: { id: "per-agent" } };
      },
    },
  });
  return { home, library, installs, perAgentCalls };
}

test("scope 'primary': into the library, linked to the primary Agents; an identical own copy becomes a link", LIMIT, async (context) => {
  const { home, installs } = await setup(context);
  const plan = await installs.plan({ source: { importId: "shared" }, scope: "primary" });
  assert.equal(plan.mode, "library");
  assert.ok(plan.planId);
  assert.deepEqual(plan.items.map((item) => [item.id, item.kind]), [["add:shared", "add"], ["link:claude:shared", "link"], ["dedupe:workbuddy:shared", "link"]]);
  assert.deepEqual(plan.items.slice(1).map((item) => item.dependsOn), ["add:shared", "add:shared"]);
  assert.deepEqual(plan.targets.map((target) => [target.agentId, target.outcome]), [["codex", "native"], ["claude", "link"], ["workbuddy", "link"]]);
  const result = await installs.apply({ planId: plan.planId, confirm: true });
  assert.ok(result.results.every((item) => item.status === "applied"));
  assert.equal((await lstat(path.join(home, ".agents", "skills", "shared"))).isDirectory(), true);
  assert.equal(await readlink(path.join(home, ".claude", "skills", "shared")), path.join("..", "..", ".agents", "skills", "shared"));
  assert.equal((await lstat(path.join(home, ".workbuddy", "skills", "shared"))).isSymbolicLink(), true, "WorkBuddy's identical copy was backed up and replaced by a link");
  assert.deepEqual([result.historyEntry.action, result.historyEntry.restorable], ["install", true]);
  await assert.rejects(installs.apply({ planId: plan.planId, confirm: true }), (error) => error.code === "plan-not-found");
});

test("a different library version blocks the plan until the user chooses; 'use-new' backs the old one up", LIMIT, async (context) => {
  const { home, installs } = await setup(context);
  const blocked = await installs.plan({ source: { importId: "existing" }, scope: "agents", agentIds: ["claude"] });
  assert.deepEqual([blocked.planId, blocked.needsChoice], [null, 1]);
  assert.deepEqual(blocked.items[0], { id: "replace:existing", title: "技能库里已有不同内容的 existing", kind: "conflict", skill: "existing", choices: ["use-new", "keep-library"], choice: "keep-library", requiresChoice: true, steps: [] });
  const keep = await installs.plan({ source: { importId: "existing" }, scope: "agents", agentIds: ["claude"], choices: { "replace:existing": "keep-library" } });
  assert.deepEqual(keep.items.map((item) => item.id), ["replace:existing", "link:claude:existing"]);
  const replace = await installs.plan({ source: { importId: "existing" }, scope: "agents", agentIds: ["claude"], choices: { "replace:existing": "use-new" } });
  assert.deepEqual(replace.items[0].steps.map((step) => step.type), ["stash", "copy"]);
  await installs.apply({ planId: replace.planId, confirm: true });
  assert.match(await readFile(path.join(home, ".agents", "skills", "existing", "SKILL.md"), "utf8"), /newer version/u);
  assert.deepEqual(replace.alsoVisibleTo, ["codex"], "native readers see it anyway");
});

test("'agent-only' and the per-agent install mode copy into each Agent's folder (the old way)", LIMIT, async (context) => {
  const only = await setup(context);
  const plan = await only.installs.plan({ source: { importId: "shared" }, scope: "agent-only", agentIds: ["claude"] });
  assert.deepEqual([plan.mode, plan.targetAgentIds], ["per-agent", ["claude"]]);
  await only.installs.apply({ planId: plan.planId, confirm: true });
  assert.deepEqual(only.perAgentCalls.map(([kind, input]) => [kind, input.targetAgentIds]), [["plan", ["claude"]], ["apply", ["claude"]]]);
  await assert.rejects(only.installs.plan({ source: { importId: "shared" }, scope: "agent-only", agentIds: ["claude", "codex"] }), (error) => error.code === "invalid-request");

  const perAgent = await setup(context, { installMode: "per-agent" });
  const copy = await perAgent.installs.plan({ source: { importId: "shared" }, scope: "primary" });
  assert.deepEqual([copy.mode, copy.installMode, copy.targetAgentIds], ["per-agent", "per-agent", ["codex", "claude", "workbuddy"]]);
  const none = await setup(context, { primary: [] });
  await assert.rejects(none.installs.plan({ source: { importId: "shared" }, scope: "primary" }), (error) => error.code === "no-primary-agents");
  await assert.rejects(none.installs.plan({ source: { importId: "shared" }, scope: "everyone" }), (error) => error.code === "invalid-request");
});

test("scopes 'agents' and 'agent-only' tombstone the Agents left unticked, so auto-link does not connect them a moment later", LIMIT, async (context) => {
  const { home, library, installs } = await setup(context);
  assert.deepEqual((await library.autoLink.run({ reason: "startup" })).connect, [], "the first run records the baseline");

  // WorkBuddy only: Claude Code (primary, link tier) is tombstoned; Codex reads the library natively.
  const plan = await installs.plan({ source: { importId: "shared" }, scope: "agents", agentIds: ["workbuddy"] });
  assert.deepEqual(plan.autoLinkSkip, ["claude"]);
  await installs.apply({ planId: plan.planId, confirm: true });
  const run = await library.autoLink.run({ reason: "scan" });
  assert.deepEqual(run.connect, [], "a scan right after the install links nothing");
  assert.equal(await lstat(path.join(home, ".claude", "skills", "shared")).catch(() => null), null);
  assert.ok((await library.autoLink.readState()).skip["claude:shared"]);
  const entry = (await library.view()).entries.find((item) => item.name === "shared");
  assert.deepEqual([entry.fanout.claude.state, entry.fanout.claude.skipped, entry.fanout.workbuddy.state], ["missing", true, "visible"]);

  // "Only this Agent" (a copy outside the library): the other in-scope Agents are tombstoned too.
  const only = await installs.plan({ source: { importId: "existing" }, scope: "agent-only", agentIds: ["claude"] });
  assert.deepEqual([only.mode, only.autoLinkSkip], ["per-agent", ["workbuddy"]]);
  await installs.apply({ planId: only.planId, confirm: true });
  assert.ok((await library.autoLink.readState()).skip["workbuddy:existing"]);

  // Every primary Agent: nothing to tombstone.
  assert.deepEqual((await installs.plan({ source: { importId: "existing" }, scope: "primary", choices: { "replace:existing": "keep-library" } })).autoLinkSkip, []);
});
