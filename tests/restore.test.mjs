import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { contentHash } from "../server/fs-links.mjs";
import { materializeSkillDirectory, scanAll } from "../server/local-server.mjs";
import { createRestoreService } from "../server/restore-service.mjs";
import { writeFixtureFile } from "./fixtures/smartorder.mjs";

const POSIX = process.platform !== "win32";
const LIMIT = { timeout: 30_000, skip: !POSIX };
const skill = (name, body) => `---\nname: ${name}\ndescription: ${name}\n---\n# ${name}\n\n${body}\n`;

const NAMES = { codex: "Codex", claude: "Claude Code" };

async function setup(context, options = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "restore-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const state = path.join(home, ".agent-skill-manager");
  const agent = (id, paths) => ({ id, name: NAMES[id], shortName: id.slice(0, 2), color: "#8fc9ef", paths });
  const agents = [
    agent("codex", [path.join(home, ".codex", "skills"), path.join(home, ".agents", "skills")]),
    agent("claude", [path.join(home, ".claude", "skills")]),
  ];
  const config = { agents, visibleAgentIds: ["codex", "claude"], primaryAgentIds: ["codex", "claude"] };
  const service = createRestoreService({
    homeDirectory: home,
    homes: [home],
    stateDirectory: state,
    backupDirectory: path.join(state, "backups"),
    historyFile: path.join(state, "history.jsonl"),
    getScan: async () => JSON.parse(JSON.stringify(await scanAll(config, { homeDirectory: home }))),
    getAgents: async () => agents,
    materialize: materializeSkillDirectory,
    ...options,
  });
  return { home, state, service, config };
}

async function writeHistory(state, entries) {
  await mkdir(state, { recursive: true });
  await writeFile(path.join(state, "history.jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

test("history lists restorable writes; restoring backs up the current state and can be undone", LIMIT, async (context) => {
  const { home, state, service } = await setup(context);
  const target = path.join(home, ".claude", "skills", "demo");
  const backup = path.join(state, "backups", "g1", "claude", "demo");
  await writeFixtureFile(target, "SKILL.md", skill("demo", "v2 written by sync"));
  await writeFixtureFile(backup, "SKILL.md", skill("demo", "v1 before sync"));
  const created = path.join(home, ".codex", "skills", "fresh");
  await writeFixtureFile(created, "SKILL.md", skill("fresh", "installed"));
  await writeHistory(state, [
    { id: "old000000001", type: "sync", skillName: "legacy", targets: ["Claude Code"], backups: 1, createdAt: "2026-09-01T00:00:00Z" },
    {
      id: "sync00000001",
      type: "sync",
      skillName: "demo",
      mode: "copy",
      // Two Agents reached the same real folder: it is restored once.
      actions: [
        { agentId: "claude", action: "replace", mode: "copy", destination: target, realDestination: target, backup, afterHash: await contentHash(target) },
        { agentId: "codex", action: "replace", mode: "copy", destination: target, realDestination: target, backup, afterHash: await contentHash(target) },
      ],
      createdAt: "2026-10-01T00:00:00Z",
    },
    { id: "import000001", type: "import", skillName: "fresh", actions: [{ agentId: "codex", action: "create", mode: "copy", destination: created, realDestination: created, backup: null, afterHash: await contentHash(created) }], createdAt: "2026-10-02T00:00:00Z" },
  ]);
  const { entries } = await service.listHistory(10);
  assert.deepEqual(entries.map((entry) => [entry.id, entry.action, entry.restorable]), [["import000001", "import", true], ["sync00000001", "sync", true], ["old000000001", "sync", false]]);
  assert.match(entries[2].reason, /旧记录/u);
  assert.deepEqual(entries[1].backups.map((item) => [item.agentId, item.restorable]), [["claude", true], ["codex", true]]);

  const plan = await service.planRestore({ historyId: "sync00000001" });
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].type, "restore-backup");
  await assert.rejects(service.applyRestore({ planId: plan.planId, confirm: false }), /明确确认/u);
  const result = await service.applyRestore({ planId: plan.planId, confirm: true });
  assert.match(await readFile(path.join(target, "SKILL.md"), "utf8"), /v1 before sync/u);
  // What was there before the restore is itself backed up, so the restore can be undone.
  assert.match(await readFile(path.join(home, result.restored[0].backup.replace(/^~\//u, ""), "SKILL.md"), "utf8"), /v2 written by sync/u);
  const undo = await service.planRestore({ historyId: result.historyEntry.id });
  await service.applyRestore({ planId: undo.planId, confirm: true });
  assert.match(await readFile(path.join(target, "SKILL.md"), "utf8"), /v2 written by sync/u);

  // A "create" is undone by moving the created folder to the trash, from where it can return.
  const reverse = await service.planRestore({ historyId: "import000001" });
  assert.equal(reverse.steps[0].type, "trash-created");
  const trashed = await service.applyRestore({ planId: reverse.planId, confirm: true });
  await assert.rejects(lstat(created));
  const { items } = await service.listTrash();
  assert.deepEqual(items.map((item) => [item.name, item.source]), [["fresh", "restore"]]);
  await service.trashRestore({ trashId: trashed.trashed[0].trashId });
  assert.match(await readFile(path.join(created, "SKILL.md"), "utf8"), /installed/u);
});

test("a restore refuses when the target changed after the plan", LIMIT, async (context) => {
  const { home, state, service } = await setup(context);
  const target = path.join(home, ".claude", "skills", "demo");
  const backup = path.join(state, "backups", "g1", "claude", "demo");
  await writeFixtureFile(target, "SKILL.md", skill("demo", "v2"));
  await writeFixtureFile(backup, "SKILL.md", skill("demo", "v1"));
  await writeHistory(state, [{ id: "sync00000002", type: "sync", skillName: "demo", actions: [{ agentId: "claude", action: "replace", realDestination: target, backup, afterHash: "stale" }], createdAt: "x" }]);
  const plan = await service.planRestore({ historyId: "sync00000002" });
  assert.match(plan.warnings[0], /又被修改过/u);
  await writeFile(path.join(target, "SKILL.md"), skill("demo", "edited after the plan"));
  await assert.rejects(service.applyRestore({ planId: plan.planId, confirm: true }), (error) => error.statusCode === 409 && error.code === "stale-plan" && /生成计划后有变化/u.test(error.message));
  assert.match(await readFile(path.join(target, "SKILL.md"), "utf8"), /edited after the plan/u);
});

test("uninstall from one Agent: a link is only unlinked, a shared folder warns and goes to the trash, managed copies are refused", LIMIT, async (context) => {
  const { home, service } = await setup(context);
  const library = path.join(home, ".agents", "skills");
  await writeFixtureFile(library, "shared/SKILL.md", skill("shared", "library copy"));
  await mkdir(path.join(home, ".claude", "skills"), { recursive: true });
  await symlink(path.join(library, "shared"), path.join(home, ".claude", "skills", "shared"));
  await writeFixtureFile(home, ".codex/skills/.system/builtin/SKILL.md", skill("builtin", "codex"));
  const scan = JSON.parse(JSON.stringify(await scanAll({ agents: (await setupAgents(home)), visibleAgentIds: ["codex", "claude"] }, { homeDirectory: home })));
  const shared = scan.skills.find((item) => item.name === "shared");

  const linkPlan = await service.planUninstall({ skillId: shared.id, agentId: "claude" });
  assert.deepEqual([linkPlan.kind, linkPlan.steps[0].type, linkPlan.alsoAffects], ["link", "unlink", []]);
  const removed = await service.applyUninstall({ planId: linkPlan.planId, confirm: true });
  await assert.rejects(lstat(path.join(home, ".claude", "skills", "shared")));
  assert.match(await readFile(path.join(library, "shared", "SKILL.md"), "utf8"), /library copy/u, "the target folder stays");
  await service.trashRestore({ trashId: removed.trashId });
  assert.equal(await readlink(path.join(home, ".claude", "skills", "shared")), path.join(library, "shared"));

  const realPlan = await service.planUninstall({ skillId: shared.id, agentId: "codex" });
  assert.deepEqual([realPlan.kind, realPlan.alsoAffects], ["real", ["claude"]]);
  assert.equal(realPlan.warning, "Claude Code 也会因此看不到这个技能。", "display names, not Agent ids");
  const moved = await service.applyUninstall({ planId: realPlan.planId, confirm: true });
  await assert.rejects(lstat(path.join(library, "shared")));
  const { entries } = await service.listHistory(5);
  assert.deepEqual([entries[0].action, entries[0].restorable, entries[0].trashId], ["uninstall", true, moved.trashId]);
  const back = await service.planRestore({ historyId: entries[0].id });
  await service.applyRestore({ planId: back.planId, confirm: true });
  assert.match(await readFile(path.join(library, "shared", "SKILL.md"), "utf8"), /library copy/u);

  const builtin = scan.skills.find((item) => item.name === "builtin");
  await assert.rejects(service.planUninstall({ skillId: builtin.id, agentId: "codex" }), (error) => error.code === "refused" && /Codex 的.*不能在这里卸载/u.test(error.message));
});

async function setupAgents(home) {
  const agent = (id, paths) => ({ id, name: id, shortName: id.slice(0, 2), color: "#8fc9ef", paths });
  return [agent("codex", [path.join(home, ".codex", "skills"), path.join(home, ".agents", "skills")]), agent("claude", [path.join(home, ".claude", "skills")])];
}

test("scan reports which Agents have an app icon without converting anything", { timeout: 30_000 }, async (context) => {
  const home = await mkdtemp(path.join(tmpdir(), "icon-flag-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const applications = path.join(home, "Applications");
  await writeFixtureFile(applications, "Codex.app/Contents/Info.plist", '<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>com.openai.codex</string><key>CFBundleIconFile</key><string>electron.icns</string></dict></plist>');
  await writeFixtureFile(applications, "Codex.app/Contents/Resources/electron.icns", "icns");
  const agents = await setupAgents(home);
  const scan = await scanAll({ agents, visibleAgentIds: ["codex", "claude"] }, { homeDirectory: home, applicationDirectories: [applications] });
  const icons = Object.fromEntries(scan.agents.map((agent) => [agent.id, agent.iconAvailable]));
  assert.deepEqual(icons, { codex: process.platform === "darwin", claude: false });
});
