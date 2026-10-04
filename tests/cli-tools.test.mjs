import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createCliManager, fixesFor, wrapperScript } from "../server/cli-fixes.mjs";
import { detectCliTools, pathFromSnapshot } from "../server/cli-tools.mjs";
import { readLibrary } from "../server/library.mjs";
import { createLarkCliHome, createLibraryHome, libraryAgents } from "./fixtures/library.mjs";

const POSIX = process.platform !== "win32";
const LIMIT = { timeout: 30_000, skip: !POSIX };

async function setup(context) {
  const home = await mkdtemp(path.join(tmpdir(), "cli-tools-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await createLibraryHome(home);
  const { nvmBin, native } = await createLarkCliHome(home);
  const stateDirectory = path.join(home, ".agent-skill-manager");
  const detect = async () =>
    detectCliTools({
      homeDirectory: home,
      homes: [home],
      // Only the fixture's folders: never a real lark-cli on this machine.
      searchDirectories: [{ directory: path.join(home, ".local", "bin"), nvm: false }, { directory: nvmBin, nvm: true }],
      agents: ["codex", "claude", "hermes", "gemini", "openclaw"],
      library: await readLibrary({ config: { agents: libraryAgents(home), primaryAgentIds: ["codex", "claude"] }, homeDirectory: home, homes: [home], stateDirectory }),
      latest: { "lark-cli": "1.0.97" },
      launchctlPath: [],
    });
  const manager = createCliManager({ homeDirectory: home, homes: [home], backupDirectory: path.join(stateDirectory, "backups"), historyFile: path.join(stateDirectory, "history.jsonl"), detect });
  return { home, detect, manager, native, nvmBin };
}

test("reads PATH from zsh and bash snapshots", () => {
  assert.deepEqual(pathFromSnapshot("x\nexport -T PATH path=( /h/.local/bin '/h/bin' /usr/bin )\n", "/h"), ["/h/.local/bin", "/h/bin", "/usr/bin"]);
  assert.deepEqual(pathFromSnapshot('export PATH="~/.local/bin:$HOME/bin:/usr/bin"\n', "/h"), ["/h/.local/bin", "/h/bin", "/usr/bin"]);
  assert.equal(pathFromSnapshot("echo nothing\n", "/h"), null);
});

test("lark-cli card: binaries, what each Agent resolves, workspace, keychain, allow rules", LIMIT, async (context) => {
  const { detect, home } = await setup(context);
  const [lark] = await detect();
  assert.equal(lark.id, "lark-cli");
  assert.deepEqual(lark.binaries.map((binary) => [binary.version, binary.kind, binary.via]), [["1.0.97", "npm-global", "nvm"], ["1.0.56", "bundled", "bundled"]]);
  assert.equal(lark.versionSkew, true);
  const agent = (id) => lark.agents.find((row) => row.agentId === id);
  assert.deepEqual(agent("codex").resolves, { path: "~/.nvm/versions/node/v24.0.0/bin/lark-cli", version: "1.0.97" });
  assert.deepEqual(
    [agent("codex").workspace, agent("codex").workspaceConfigured, agent("codex").secretSource, agent("codex").keychainReachable, agent("codex").allowRule, agent("codex").sandboxNetwork],
    ["local", true, "keychain", "needs-downgrade", "missing", "blocked"],
  );
  assert.deepEqual([agent("codex").skill.name, agent("codex").skill.visible], ["lark-shared", true]);
  assert.deepEqual([agent("claude").allowRule, agent("claude").keychainReachable, agent("claude").skill.visible], ["present", "yes", false]);
  // Hermes' gateway PATH (from its launchd plist) finds its own bundled copy and switches workspace.
  assert.deepEqual(agent("hermes").resolves, { path: "~/.hermes/node/bin/lark-cli", version: "1.0.56" });
  assert.deepEqual([agent("hermes").workspace, agent("hermes").workspaceConfigured, agent("hermes").plist], ["hermes", false, "~/Library/LaunchAgents/ai.hermes.gateway.plist"]);
  assert.equal(agent("gemini").pathSource, "终端（参考最新 shell snapshot）");
  assert.equal(agent("openclaw").resolves, null, "the GUI default PATH has no lark-cli");
  const fixes = Object.fromEntries(fixesFor(lark, { homes: [home] }).map((fix) => [fix.id, fix]));
  assert.deepEqual(Object.keys(fixes).sort(), ["allow-rules", "hermes-path", "keychain-downgrade", "workspace-binding", "wrapper"]);
  assert.equal(fixes.wrapper.applicable, true);
  assert.match(fixes["workspace-binding"].instructions, /lark-cli config bind --source hermes\nlark-cli config bind --source openclaw/u);
  const body = JSON.stringify({ ...lark, internal: undefined, fixes: Object.values(fixes) });
  assert.doesNotMatch(body, /ZZ9/u);
  assert.equal(body.includes(home), false);
});

test("wrapper fix: plan, confirm, backup, then Agents resolve the stable launcher", LIMIT, async (context) => {
  const { manager, home, native, detect } = await setup(context);
  const plan = await manager.plan({ toolId: "lark-cli", fixId: "wrapper" });
  assert.equal(plan.kind, "self");
  assert.equal(plan.steps[0].path, "~/.local/bin/lark-cli");
  await assert.rejects(manager.apply({ planId: plan.planId, confirm: false }), /明确确认/u);
  await manager.apply({ planId: plan.planId, confirm: true });
  const target = path.join(home, ".local", "bin", "lark-cli");
  // The launcher points at the native program's real location, not the nvm shim.
  assert.equal(await readFile(target, "utf8"), wrapperScript(await realpath(native)));
  assert.ok((await stat(target)).mode & 0o100);
  const [lark] = await detect();
  assert.equal(lark.agents.find((row) => row.agentId === "codex").resolves.path, "~/.local/bin/lark-cli");
  assert.ok(lark.binaries.some((binary) => binary.kind === "wrapper" && binary.target.endsWith("/bin/lark-cli")));
  assert.equal((await manager.plan({ toolId: "lark-cli", fixId: "wrapper" })).kind, "none", "already current");
});

test("allow-rule fix edits each config with a backup and keeps other keys", LIMIT, async (context) => {
  const { manager, home, detect } = await setup(context);
  const plan = await manager.plan({ toolId: "lark-cli", fixId: "allow-rules" });
  assert.deepEqual(plan.steps.map((step) => step.path).sort(), ["~/.codex/rules/default.rules", "~/.gemini/settings.json"]);
  assert.ok(plan.skipped.some((item) => item.agentId === "hermes"));
  assert.ok(plan.notes.some((note) => /沙箱外/u.test(note)));
  const result = await manager.apply({ planId: plan.planId, confirm: true });
  assert.equal(await readFile(path.join(home, ".codex", "rules", "default.rules"), "utf8"), 'prefix_rule(pattern=["lark-cli"], decision="allow")\n');
  const gemini = JSON.parse(await readFile(path.join(home, ".gemini", "settings.json"), "utf8"));
  assert.deepEqual(gemini.tools.allowed, ["run_shell_command(lark-cli)"]);
  assert.ok(gemini.mcpServers.x, "other keys survive");
  const backup = result.changed.find((item) => item.path === "~/.gemini/settings.json").backup;
  assert.match(await readFile(path.join(home, backup.slice(2)), "utf8"), /mcpServers/u);
  const [lark] = await detect();
  assert.deepEqual([lark.agents.find((row) => row.agentId === "codex").allowRule, lark.agents.find((row) => row.agentId === "codex").sandboxNetwork], ["present", "ok"]);
  assert.doesNotMatch(JSON.stringify(result), /ZZ9/u);
  assert.equal((await manager.plan({ toolId: "lark-cli", fixId: "hermes-path" })).kind, "guide");
});

async function restoreService(home) {
  const { createRestoreService } = await import("../server/restore-service.mjs");
  const stateDirectory = path.join(home, ".agent-skill-manager");
  return createRestoreService({ homeDirectory: home, homes: [home], stateDirectory, backupDirectory: path.join(stateDirectory, "backups"), historyFile: path.join(stateDirectory, "history.jsonl"), getScan: async () => ({ skills: [], agents: [] }), getAgents: async () => [], materialize: async () => {} });
}

test("CLI fixes are undone per file; a file changed since needs an explicit choice", LIMIT, async (context) => {
  const { manager, home } = await setup(context);
  const { writeFile: write } = await import("node:fs/promises");
  const rules = path.join(home, ".codex", "rules", "default.rules");
  const gemini = path.join(home, ".gemini", "settings.json");
  const geminiBefore = await readFile(gemini, "utf8");
  const plan = await manager.plan({ toolId: "lark-cli", fixId: "allow-rules" });
  await manager.apply({ planId: plan.planId, confirm: true });
  await write(gemini, `${JSON.stringify({ edited: "by hand" })}\n`);
  const restore = await restoreService(home);
  const [entry] = (await restore.listHistory(5)).entries;
  assert.deepEqual([entry.action, entry.restorable, entry.units.length], ["cli-fix", true, 2]);
  const undo = await restore.planRestore({ historyId: entry.id });
  const units = Object.fromEntries(undo.units.map((unit) => [unit.title, unit]));
  assert.equal(units["~/.codex/rules/default.rules"].selected, true);
  assert.equal(units["~/.gemini/settings.json"].selected, false);
  assert.match(units["~/.gemini/settings.json"].conflict, /又被修改过/u);
  await restore.applyRestore({ planId: undo.planId, confirm: true });
  await assert.rejects(readFile(rules, "utf8"), "the created rules file moved to backups");
  assert.match(await readFile(gemini, "utf8"), /by hand/u, "the changed file is left alone");
  const forced = await restore.planRestore({ historyId: entry.id, select: [undo.units.find((unit) => unit.title === "~/.gemini/settings.json").id] });
  await restore.applyRestore({ planId: forced.planId, confirm: true });
  assert.equal(await readFile(gemini, "utf8"), geminiBefore);

  const wrapper = await manager.plan({ toolId: "lark-cli", fixId: "wrapper" });
  await manager.apply({ planId: wrapper.planId, confirm: true });
  const [wrapperEntry] = (await restore.listHistory(5)).entries;
  const removeWrapper = await restore.planRestore({ historyId: wrapperEntry.id });
  await restore.applyRestore({ planId: removeWrapper.planId, confirm: true });
  await assert.rejects(readFile(path.join(home, ".local", "bin", "lark-cli"), "utf8"));
});

test("CLI fix reasons use display names and list agentIds", LIMIT, async (context) => {
  const { detect, home } = await setup(context);
  const [lark] = await detect();
  const fixes = Object.fromEntries(fixesFor(lark, { homes: [home] }).map((fix) => [fix.id, fix]));
  assert.deepEqual(fixes["allow-rules"].agentIds.sort(), ["codex", "gemini", "hermes"]);
  assert.match(fixes["allow-rules"].reason, /Codex/u);
  assert.match(fixes["allow-rules"].reason, /Gemini CLI/u);
  assert.doesNotMatch(fixes["allow-rules"].reason, /\bcodex\b/u);
  assert.deepEqual(fixes["workspace-binding"].agentIds.sort(), ["hermes", "openclaw"]);
  assert.match(fixes["workspace-binding"].reason, /Hermes Agent、OpenClaw/u);
  assert.deepEqual(fixes["keychain-downgrade"].agentIds, ["codex"]);
  assert.deepEqual(fixes.wrapper.agentIds, ["openclaw"]);
});
