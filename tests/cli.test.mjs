import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdtemp, readdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../server/cli.mjs";
import { withStateLock } from "../server/state-lock.mjs";
import { markInstalled } from "./fixtures/agents.mjs";
import { writeFixtureFile } from "./fixtures/smartorder.mjs";

const POSIX = process.platform !== "win32";
const LIMIT = { timeout: 120_000, skip: !POSIX };
const CLI = fileURLToPath(new URL("../server/cli.mjs", import.meta.url));
const skill = (name, body = "") => `---\nname: ${name}\ndescription: ${name} 技能 fixture\n---\n# ${name}\n${body}`;

/** A home with a config (Codex, Claude Code, WorkBuddy primary), a library and a skill folder to add. */
async function setup(context, { knownAgentIds = true } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "skill-control-cli-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await writeFixtureFile(home, ".agents/skills/old-a/SKILL.md", skill("old-a"));
  await writeFixtureFile(home, ".claude/skills/.keep", "");
  await writeFixtureFile(home, ".workbuddy/skills/wb-own/SKILL.md", skill("wb-own"));
  await writeFixtureFile(home, "src/new-skill/SKILL.md", skill("new-skill"));
  await writeFixtureFile(home, "src/new-skill/notes.md", "notes");
  await writeFixtureFile(home, "src/changed/SKILL.md", skill("new-skill", "another version"));
  await writeFixtureFile(home, "src/no-description/SKILL.md", "---\nname: x\n---\n");
  await markInstalled(home, "codex", "claude", "workbuddy");
  await writeFixtureFile(home, ".agent-skill-manager/config.json", `${JSON.stringify({
    version: 3,
    agents: [
      { id: "codex", name: "Codex", paths: ["~/.codex/skills", "~/.agents/skills"] },
      { id: "claude", name: "Claude Code", paths: ["~/.claude/skills"] },
      { id: "workbuddy", name: "WorkBuddy", paths: ["~/.workbuddy/skills"] },
    ],
    primaryAgentIds: ["codex", "claude", "workbuddy"],
    ...(knownAgentIds ? { knownAgentIds: ["codex", "claude", "workbuddy"] } : {}),
  })}\n`);
  return home;
}

function cli(home, args, env = {}) {
  return new Promise((resolve) => {
    // Commands and apps are looked up inside the synthetic home only (never the machine's /Applications).
    const sandbox = { SKILL_MANAGER_COMMAND_DIRS: path.join(home, "bin"), SKILL_MANAGER_APPLICATION_DIRS: path.join(home, "Applications") };
    const child = spawn(process.execPath, [CLI, ...args], { env: { HOME: home, PATH: "/usr/bin:/bin", ...sandbox, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("exit", (code) => resolve({ code, stdout, stderr, json: () => JSON.parse(stdout) }));
  });
}

const link = (home, agentDir, name) => readlink(path.join(home, agentDir, name)).catch(() => null);

test("argument parsing", () => {
  assert.deepEqual(parseArgs(["add", "./x", "--link", "a,b", "--json", "--name=foo"]), { command: "add", positional: ["./x"], flags: { link: "a,b", json: true, name: "foo" } });
  assert.throws(() => parseArgs(["status", "--nope"]), /未知选项/u);
  assert.throws(() => parseArgs(["add", "x", "--link"]), /需要一个值/u);
});

test("help, version and usage errors", LIMIT, async (context) => {
  const home = await setup(context);
  const help = await cli(home, []);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /skill-control status/u);
  const version = await cli(home, ["--version"]);
  assert.match(version.stdout, /^skill-control \d+\.\d+\.\d+/u);
  const unknown = await cli(home, ["frobnicate"]);
  assert.equal(unknown.code, 2);
  const json = await cli(home, ["link", "--json"]);
  assert.deepEqual([json.code, json.json().ok, json.json().code], [2, false, "usage"]);
});

test("add → status → unlink (tombstone) → link → undo, with history ids and relative links", LIMIT, async (context) => {
  const home = await setup(context);
  const added = await cli(home, ["add", path.join(home, "src", "new-skill"), "--json"]);
  assert.equal(added.code, 0, added.stdout + added.stderr);
  const result = added.json();
  assert.deepEqual([result.ok, result.skill, result.library], [true, "new-skill", "~/.agents/skills"]);
  assert.match(result.historyId, /^[0-9a-f]{12}$/u);
  assert.equal(result.undo, `撤销：skill-control undo ${result.historyId}`);
  assert.equal(await link(home, ".claude/skills", "new-skill"), path.join("..", "..", ".agents", "skills", "new-skill"));
  assert.equal(await link(home, ".workbuddy/skills", "new-skill"), path.join("..", "..", ".agents", "skills", "new-skill"));
  assert.equal(await readFile(path.join(home, ".agents", "skills", "new-skill", "notes.md"), "utf8"), "notes");

  const status = (await cli(home, ["status", "new-skill", "--json"])).json();
  assert.deepEqual(status.skill.agents.map((agent) => [agent.agentId, agent.state]), [["codex", "visible"], ["claude", "visible"], ["workbuddy", "visible"]]);
  const human = await cli(home, ["status", "new-skill"]);
  assert.match(human.stdout, /Claude Code\s+软链接\s+能看到/u);

  // The same content again: nothing to do. Other content: refused without --replace (exit 3).
  assert.equal((await cli(home, ["add", path.join(home, "src", "new-skill"), "--json"])).json().nothingToDo, true);
  const conflict = await cli(home, ["add", path.join(home, "src", "changed"), "--name", "new-skill"]);
  assert.equal(conflict.code, 3);
  assert.match(conflict.stdout, /--replace/u);
  const replaced = await cli(home, ["add", path.join(home, "src", "changed"), "--name", "new-skill", "--replace", "--json"]);
  assert.equal(replaced.code, 0, replaced.stdout);
  assert.match(await readFile(path.join(home, ".agents", "skills", "new-skill", "SKILL.md"), "utf8"), /another version/u);
  assert.equal((await cli(home, ["add", path.join(home, "src", "no-description")])).code, 2);

  const unlinked = (await cli(home, ["unlink", "new-skill", "--agents", "claude", "--json"])).json();
  assert.equal(unlinked.ok, true);
  assert.equal(await link(home, ".claude/skills", "new-skill"), null);
  const state = JSON.parse(await readFile(path.join(home, ".agent-skill-manager", "auto-link.json"), "utf8"));
  assert.ok(state.skip["claude:new-skill"], "unlink writes a tombstone");
  assert.equal((await cli(home, ["sync", "--json"])).json().connected.length, 0);

  const undone = await cli(home, ["undo", unlinked.historyId]);
  assert.equal(undone.code, 0, undone.stdout + undone.stderr);
  assert.equal(await link(home, ".claude/skills", "new-skill"), path.join("..", "..", ".agents", "skills", "new-skill"));
  assert.equal(JSON.parse(await readFile(path.join(home, ".agent-skill-manager", "auto-link.json"), "utf8")).skip["claude:new-skill"], undefined, "undoing the unlink clears the tombstone");
});

test("adopt, sync with a baseline, doctor", LIMIT, async (context) => {
  const home = await setup(context);
  const adopted = await cli(home, ["adopt", "workbuddy", "wb-own", "--json"]);
  assert.equal(adopted.code, 0, adopted.stdout);
  assert.equal((await lstat(path.join(home, ".agents", "skills", "wb-own"))).isDirectory(), true);
  assert.equal((await lstat(path.join(home, ".workbuddy", "skills", "wb-own"))).isSymbolicLink(), true);
  assert.ok((await readdir(path.join(home, ".agent-skill-manager", "backups"))).length > 0, "backed up before moving");

  const first = (await cli(home, ["sync", "--json"])).json();
  assert.deepEqual([first.connected.length, first.pending.claude], [0, 2], "the first run records the baseline");
  await writeFixtureFile(home, ".agents/skills/dropped/SKILL.md", skill("dropped"));
  const dry = (await cli(home, ["sync", "--dry-run", "--json"])).json();
  assert.deepEqual(dry.connect.map((pair) => pair.agentId).sort(), ["claude", "workbuddy"]);
  assert.equal(await link(home, ".claude/skills", "dropped"), null, "--dry-run writes nothing");
  const synced = await cli(home, ["sync"]);
  assert.match(synced.stdout, /dropped → claude、workbuddy|dropped → workbuddy、claude/u);
  assert.match(synced.stdout, /skill-control undo [0-9a-f]{12}/u);
  assert.equal(await link(home, ".claude/skills", "dropped"), path.join("..", "..", ".agents", "skills", "dropped"));

  const doctor = await cli(home, ["doctor", "--json"]);
  const claude = doctor.json().agents.find((agent) => agent.agentId === "claude");
  assert.deepEqual(claude.problems.map((problem) => [problem.state, problem.skills.sort()]), [["missing", ["old-a", "wb-own"]]]);
  assert.match((await cli(home, ["doctor"])).stdout, /Claude Code（软链接）：能看到 1 \/ 3/u);
});

test("add --link a,b and --link none: the Agents left out are not auto-linked afterwards", LIMIT, async (context) => {
  const home = await setup(context);
  assert.equal((await cli(home, ["sync", "--json"])).json().connected.length, 0, "the first run records the baseline");
  const some = await cli(home, ["add", path.join(home, "src", "new-skill"), "--link", "workbuddy", "--json"]);
  assert.equal(some.code, 0, some.stdout + some.stderr);
  assert.deepEqual(some.json().autoLinkSkip, ["claude"]);
  await writeFixtureFile(home, "src/lonely/SKILL.md", skill("lonely"));
  const none = await cli(home, ["add", path.join(home, "src", "lonely"), "--link", "none"]);
  assert.equal(none.code, 0, none.stdout + none.stderr);
  assert.match(none.stdout, /不会再自动接入：Claude Code、WorkBuddy/u);
  const state = JSON.parse(await readFile(path.join(home, ".agent-skill-manager", "auto-link.json"), "utf8"));
  assert.deepEqual(Object.keys(state.skip).sort(), ["claude:lonely", "claude:new-skill", "workbuddy:lonely"]);
  // Without the tombstones, this sync would link both new skills into Claude Code and "lonely" into WorkBuddy.
  assert.deepEqual((await cli(home, ["sync", "--json"])).json().connect, []);
  assert.equal(await link(home, ".claude/skills", "new-skill"), null);
  assert.equal(await link(home, ".claude/skills", "lonely"), null);
  assert.equal(await link(home, ".workbuddy/skills", "lonely"), null);
  assert.equal(await link(home, ".workbuddy/skills", "new-skill"), path.join("..", "..", ".agents", "skills", "new-skill"));
  // A later explicit link still works and clears the tombstone.
  assert.equal((await cli(home, ["link", "lonely", "--agents", "claude", "--json"])).json().ok, true);
  assert.equal(JSON.parse(await readFile(path.join(home, ".agent-skill-manager", "auto-link.json"), "utf8")).skip["claude:lonely"], undefined);
});

test("read-only mode writes nothing, not even the config or a lock file", LIMIT, async (context) => {
  const home = await setup(context, { knownAgentIds: false });
  const state = path.join(home, ".agent-skill-manager");
  const before = { files: (await readdir(state)).sort(), config: await readFile(path.join(state, "config.json"), "utf8") };
  for (const args of [["status", "old-a"], ["doctor"], ["link", "old-a", "--agents", "claude", "--read-only"], ["sync", "--read-only"], ["add", path.join(home, "src", "new-skill"), "--read-only"]]) {
    const result = await cli(home, args, args.includes("--read-only") ? {} : { SKILL_MANAGER_DRY_RUN: "1" });
    assert.equal(result.code, 0, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
  }
  assert.match((await cli(home, ["link", "old-a", "--agents", "claude"], { SKILL_MANAGER_DRY_RUN: "1" })).stdout, /只读模式：没有写入/u);
  assert.deepEqual((await readdir(state)).sort(), before.files);
  assert.equal(await readFile(path.join(state, "config.json"), "utf8"), before.config);
  assert.equal(await link(home, ".claude/skills", "old-a"), null);
  assert.equal(await stat(path.join(home, ".agents", "skills", "new-skill")).catch(() => null), null);
});

test("the CLI waits for the app's lock instead of writing at the same time", LIMIT, async (context) => {
  const home = await setup(context);
  const state = path.join(home, ".agent-skill-manager");
  let cliResult;
  const started = Date.now();
  await withStateLock(state, async () => {
    const pending = cli(home, ["link", "old-a", "--agents", "claude", "--json"]);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(await link(home, ".claude/skills", "old-a"), null, "nothing happens while the app holds the lock");
    cliResult = pending;
  }, { label: "Skill Control" });
  const result = await cliResult;
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.ok(Date.now() - started >= 1_500);
  assert.equal(await link(home, ".claude/skills", "old-a"), path.join("..", "..", ".agents", "skills", "old-a"));
  await writeFile(path.join(state, "unrelated"), "x");
});
