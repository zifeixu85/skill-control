import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { lstat, mkdtemp, readFile, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDirLink } from "../server/fs-links.mjs";
import { assertSafeWrite } from "../server/home-guard.mjs";
import { createLibraryService } from "../server/library-service.mjs";
import { createLibraryHome, libraryAgents } from "./fixtures/library.mjs";

const POSIX = process.platform !== "win32";
const LIMIT = { timeout: 30_000, skip: !POSIX };

async function setup(context, overrides = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "library-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await createLibraryHome(home);
  const stateDirectory = path.join(home, ".agent-skill-manager");
  const config = { agents: libraryAgents(home), primaryAgentIds: ["codex", "claude"] };
  const service = createLibraryService({
    homeDirectory: home,
    homes: [home],
    stateDirectory,
    backupDirectory: path.join(stateDirectory, "backups"),
    historyFile: path.join(stateDirectory, "history.jsonl"),
    getConfig: async () => overrides.config || config,
    findCommand: async () => null,
    ...overrides.service,
  });
  return { home, service, stateDirectory };
}

const states = (view, agentId) => Object.fromEntries(view.entries.map((entry) => [entry.name, entry.fanout[agentId]?.state]));

test("library view: entry kinds and each Agent's visibility under its own rules", LIMIT, async (context) => {
  const { service, home } = await setup(context);
  const view = await service.view();
  assert.equal(view.root, "~/.agents/skills");
  assert.deepEqual(
    view.entries.map((entry) => [entry.name, entry.kind]),
    [["cindy", "link-external"], ["gstack", "real"], ["lark-shared", "real"], ["rev-1", "link-external"], ["shared-a", "real"], ["shared-b", "real"]],
  );
  assert.equal(view.entries.find((entry) => entry.name === "gstack").externalManaged, "git");
  assert.equal(view.entries.find((entry) => entry.name === "rev-1").target, "~/.codex/skills/rev-1");
  assert.deepEqual(view.entries.find((entry) => entry.name === "lark-shared").sourceFromLocks.sourceType, "well-known");
  // Codex reads the library natively; its identical own copy shows twice.
  assert.deepEqual(states(view, "codex"), { cindy: "visible", gstack: "visible", "lark-shared": "visible", "rev-1": "visible", "shared-a": "duplicate", "shared-b": "visible" });
  // Claude needs links: a drifted mirror, a missing skill, a link that resolves to the same folder.
  assert.deepEqual(states(view, "claude"), { cindy: "missing", gstack: "private-copy", "lark-shared": "missing", "rev-1": "visible", "shared-a": "private-copy", "shared-b": "private-copy" });
  // OpenClaw rejects links whose real path leaves the root.
  assert.equal(states(view, "openclaw")["rev-1"], "hidden");
  assert.match(view.entries.find((entry) => entry.name === "rev-1").fanout.openclaw.reason, /库外/u);
  // Hermes sees the library only through its local links (external_dirs not configured).
  assert.deepEqual([states(view, "hermes")["lark-shared"], states(view, "hermes")["shared-a"]], ["visible", "missing"]);
  assert.equal(view.agents.find((agent) => agent.agentId === "codex").tier, "native");
  assert.ok(view.issues.some((issue) => issue.id === "library-external-link"));
  assert.ok(view.issues.some((issue) => issue.id === "library-drift" && issue.agentId === "claude"));
  assert.equal(JSON.stringify(view).includes(home), false);
});

test("batch plan: adopt reverse links, link identical copies, mark git and app folders external", LIMIT, async (context) => {
  const { service, home, stateDirectory } = await setup(context);
  const plan = await service.plan({ action: "batch" });
  const byId = Object.fromEntries(plan.items.map((item) => [item.id, item]));
  assert.ok(byId["adopt-link:rev-1"]);
  assert.equal(byId["external:cindy"].kind, "external");
  assert.equal(byId["external:gstack"].kind, "external");
  assert.equal(byId["dedupe:codex:shared-a"].kind, "dedupe");
  assert.equal(byId["dedupe:claude:shared-a"].kind, "link");
  assert.deepEqual([byId["conflict:claude:shared-b"].requiresChoice, byId["conflict:claude:shared-b"].choice], [true, "skip"]);
  assert.equal(plan.needsChoice, 1);
  assert.deepEqual(byId["adopt-link:rev-1"].steps.map((step) => step.type), ["backup", "unlink", "move", "unlink", "link"]);

  const result = await service.apply({ planId: plan.planId, confirm: true });
  assert.deepEqual(result.results.filter((item) => item.status !== "applied"), []);
  const library = path.join(home, ".agents", "skills");
  assert.equal((await lstat(path.join(library, "rev-1"))).isDirectory(), true, "the real folder now lives in the library");
  await assert.rejects(lstat(path.join(home, ".codex", "skills", "rev-1")));
  assert.equal(await readlink(path.join(home, ".claude", "skills", "rev-1")), path.join("..", "..", ".agents", "skills", "rev-1"));
  assert.equal(await readlink(path.join(home, ".claude", "skills", "shared-a")), path.join("..", "..", ".agents", "skills", "shared-a"));
  await assert.rejects(lstat(path.join(home, ".codex", "skills", "shared-a")), "the Codex duplicate moved to backups");
  const [group] = await fs.readdir(path.join(stateDirectory, "backups"));
  assert.match(await readFile(path.join(stateDirectory, "backups", group, "codex", "shared-a", "SKILL.md"), "utf8"), /shared-a/u);
  // gstack, the app folder and the conflict are untouched.
  assert.equal((await lstat(path.join(library, "cindy"))).isSymbolicLink(), true);
  assert.equal((await lstat(path.join(home, ".claude", "skills", "shared-b"))).isDirectory(), true);
  const after = await service.view();
  assert.equal(states(after, "openclaw")["rev-1"], "visible");
  assert.equal(states(after, "codex")["shared-a"], "visible");
  assert.equal(states(after, "claude")["shared-a"], "visible");
  const lock = JSON.parse(await readFile(path.join(stateDirectory, "library-lock.json"), "utf8"));
  assert.deepEqual(Object.keys(lock.skills), [...Object.keys(lock.skills)].sort());
  assert.equal(lock.skills["rev-1"].adoptedFrom, "library-link");
  assert.equal(lock.skills["lark-shared"].sourceType, "well-known");
  assert.equal(lock.skills["shared-a"].fanout.claude.mode, "link");
  assert.deepEqual(Object.keys(lock.skills["shared-a"]), [...Object.keys(lock.skills["shared-a"])].sort());
  assert.match(await readFile(path.join(stateDirectory, "history.jsonl"), "utf8"), /"type":"library"/u);
  await assert.rejects(service.apply({ planId: plan.planId, confirm: true }), /不存在或已过期/u);
});

test("conflict choices: save-as keeps the Agent's version beside the library one", LIMIT, async (context) => {
  const { service, home } = await setup(context);
  const plan = await service.plan({ action: "batch", choices: { "conflict:claude:shared-b": "save-as", "adopt-link:rev-1": "skip", "dedupe:codex:shared-a": "skip", "dedupe:claude:shared-a": "skip" } });
  assert.deepEqual(plan.items.filter((item) => item.steps.length).map((item) => item.id), ["conflict:claude:shared-b"]);
  await service.apply({ planId: plan.planId, confirm: true });
  const library = path.join(home, ".agents", "skills");
  assert.match(await readFile(path.join(library, "shared-b@claude", "SKILL.md"), "utf8"), /claude edit/u);
  assert.match(await readFile(path.join(home, ".claude", "skills", "shared-b", "SKILL.md"), "utf8"), /library version/u, "Claude now links to the library version");

  const useThis = await setup(context);
  const planned = await useThis.service.plan({ action: "adopt", skill: "shared-b", agents: ["claude"], choice: "use-this" });
  await useThis.service.apply({ planId: planned.planId, confirm: true });
  assert.match(await readFile(path.join(useThis.home, ".agents", "skills", "shared-b", "SKILL.md"), "utf8"), /claude edit/u);
  assert.equal((await lstat(path.join(useThis.home, ".claude", "skills", "shared-b"))).isSymbolicLink(), true);
});

test("a failing step rolls the item back; a failed visibility check undoes it", LIMIT, async (context) => {
  const failing = await setup(context, {
    service: {
      platform: "darwin",
      fsImpl: {
        ...fs,
        symlink: async () => {
          throw Object.assign(new Error("denied"), { code: "EPERM" });
        },
      },
    },
  });
  const plan = await failing.service.plan({ action: "adopt", skill: "shared-b", agents: ["claude"], choice: "keep-library" });
  const result = await failing.service.apply({ planId: plan.planId, confirm: true });
  assert.equal(result.results[0].status, "failed");
  assert.match(await readFile(path.join(failing.home, ".claude", "skills", "shared-b", "SKILL.md"), "utf8"), /claude edit/u, "the stashed copy is back");

  // A link that resolves somewhere else passes the write but fails the visibility check.
  const wrong = await setup(context, {
    service: { platform: "darwin", fsImpl: { ...fs, symlink: (target, linkPath, type) => fs.symlink("/nonexistent-zz-target", linkPath, type) } },
  });
  const linkPlan = await wrong.service.plan({ action: "link", skill: "shared-a", agents: ["kiro"] });
  const linked = await wrong.service.apply({ planId: linkPlan.planId, confirm: true });
  assert.equal(linked.results[0].status, "rolled-back");
  await assert.rejects(lstat(path.join(wrong.home, ".kiro", "skills", "shared-a")));
});

test("remove moves the entry to the trash and restore brings it and its links back", LIMIT, async (context) => {
  const { service, home } = await setup(context);
  const plan = await service.plan({ action: "remove", skill: "lark-shared" });
  assert.equal(plan.items[0].steps.filter((step) => step.type === "unlink").length, 3, "OpenClaw, Hermes and Kiro links");
  const result = await service.apply({ planId: plan.planId, confirm: true });
  const trashId = result.results[0].trashId;
  assert.ok(trashId);
  await assert.rejects(lstat(path.join(home, ".agents", "skills", "lark-shared")));
  await assert.rejects(lstat(path.join(home, ".kiro", "skills", "lark-shared")));
  assert.deepEqual((await service.view()).trash.map((item) => item.name), ["lark-shared"]);
  const restored = await service.restore({ trashId });
  assert.equal(restored.links.length, 3);
  assert.match(await readFile(path.join(home, ".agents", "skills", "lark-shared", "SKILL.md"), "utf8"), /lark-shared/u);
  assert.equal(await readlink(path.join(home, ".kiro", "skills", "lark-shared")), path.join("..", "..", ".agents", "skills", "lark-shared"));
  await assert.rejects(service.restore({ trashId }), /没有这个条目/u);
});

test("disable writes the Agent's own switch with a backup", LIMIT, async (context) => {
  const { service, home } = await setup(context);
  await fs.writeFile(path.join(home, ".codex", "config.toml"), 'model = "gpt-5"\n');
  const plan = await service.plan({ action: "disable", skill: "shared-b", agents: ["codex", "openclaw"] });
  const byAgent = Object.fromEntries(plan.items.map((item) => [item.agentId, item]));
  assert.match(byAgent.codex.steps[0].diff, /\[\[skills\.config\]\]\n\+ name = "shared-b"\n\+ enabled = false/u);
  await service.apply({ planId: plan.planId, confirm: true });
  assert.match(await readFile(path.join(home, ".codex", "config.toml"), "utf8"), /^model = "gpt-5"\n\n\[\[skills\.config\]\]\nname = "shared-b"\nenabled = false\n$/u);
  assert.deepEqual(JSON.parse(await readFile(path.join(home, ".openclaw", "openclaw.json"), "utf8")), { skills: { entries: { "shared-b": { enabled: false } } } });
  const view = await service.view();
  assert.deepEqual([states(view, "codex")["shared-b"], states(view, "openclaw")["shared-b"]], ["hidden", "hidden"]);
});

test("the home guard refuses writes into the real home from sandboxes and tests", async (context) => {
  const fake = await mkdtemp(path.join(tmpdir(), "guard-home-"));
  const sandbox = await mkdtemp(path.join(tmpdir(), "guard-sandbox-"));
  context.after(() => Promise.all([rm(fake, { recursive: true, force: true }), rm(sandbox, { recursive: true, force: true })]));
  await assert.rejects(assertSafeWrite(path.join(fake, ".agents", "skills", "x"), sandbox, { protectedHome: fake }), /拒绝写入真实主目录/u);
  // Under a test runner, even a service configured with the real home may not write there.
  assert.ok(process.env.NODE_TEST_CONTEXT);
  await assert.rejects(assertSafeWrite(path.join(fake, "x"), fake, { protectedHome: fake }), /拒绝写入真实主目录/u);
  await assertSafeWrite(path.join(sandbox, "x"), sandbox, { protectedHome: fake });
});

test("Windows links fall back from symlink to junction to a recorded copy", async () => {
  const calls = [];
  const make = (failures) => ({
    symlink: async (target, linkPath, type) => {
      calls.push(type);
      if (failures.includes(type)) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    },
    cp: async () => calls.push("cp"),
  });
  assert.deepEqual(await createDirLink({ linkPath: "C:\\a\\x", relativeTarget: "..\\lib\\x", absoluteTarget: "C:\\lib\\x", platform: "win32", fsImpl: make(["dir"]) }), { mode: "junction" });
  const copy = await createDirLink({ linkPath: "C:\\a\\x", relativeTarget: "..\\lib\\x", absoluteTarget: "C:\\lib\\x", platform: "win32", fsImpl: make(["dir", "junction"]), hashImpl: async () => "abc123" });
  assert.deepEqual(copy, { mode: "copy", sourceHash: "abc123" });
  assert.deepEqual(calls, ["dir", "junction", "dir", "junction", "cp"]);
  await assert.rejects(createDirLink({ linkPath: "/a/x", relativeTarget: "../x", absoluteTarget: "/x", platform: "darwin", fsImpl: make(["dir"]) }), /EPERM/u, "no junction or copy fallback outside Windows");
});
