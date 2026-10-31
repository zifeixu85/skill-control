import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { markInstalled } from "./fixtures/agents.mjs";
import { startTestServer } from "./fixtures/server.mjs";
import { writeFixtureFile } from "./fixtures/smartorder.mjs";

const POSIX = process.platform !== "win32";
const skill = (name, body = "") => `---\nname: ${name}\ndescription: ${name} fixture\n---\n# ${name}\n${body}`;
const HEADER = { "x-skill-manager-confirm": "yes" };

async function createHome(home) {
  await writeFixtureFile(home, ".agents/skills/old-a/SKILL.md", skill("old-a", "api_key=ZZ9v030skillsecret01"));
  await writeFixtureFile(home, ".agents/skills/old-b/SKILL.md", skill("old-b"));
  await mkdir(path.join(home, ".claude", "skills"), { recursive: true });
  await mkdir(path.join(home, ".kiro", "skills"), { recursive: true });
  await writeFixtureFile(home, ".workbuddy/skills/wb-own/SKILL.md", skill("wb-own"));
  await writeFixtureFile(home, ".workbuddy/skills/wb-two/SKILL.md", skill("wb-two"));
  await markInstalled(home, "codex", "claude", "workbuddy", "kiro");
  await writeFixtureFile(home, ".agent-skill-manager/config.json", `${JSON.stringify({
    version: 3,
    agents: [
      { id: "codex", name: "Codex", paths: ["~/.codex/skills", "~/.agents/skills"] },
      { id: "claude", name: "Claude Code", paths: ["~/.claude/skills"] },
      { id: "workbuddy", name: "WorkBuddy", paths: ["~/.workbuddy/skills"] },
      { id: "kiro", name: "Kiro", paths: ["~/.kiro/skills"] },
    ],
    primaryAgentIds: ["codex", "claude", "workbuddy"],
    knownAgentIds: ["codex", "claude", "workbuddy", "kiro"],
    syncMode: "copy",
  })}\n`);
}

test("v0.3 routes: auto-link, catch-up, installs, the companion skill and the CLI launcher", { timeout: 90_000, skip: !POSIX }, async (context) => {
  const home = await mkdtemp(path.join(tmpdir(), "v030-routes-"));
  await createHome(home);
  // Background auto-link runs on; the home is removed after the server is stopped (hooks run in order).
  let server;
  try {
    server = await startTestServer(context, home, { SKILL_MANAGER_AUTO_LINK: "on", SKILL_MANAGER_AUTO_LINK_DEBOUNCE_MS: "50" });
  } finally {
    context.after(() => rm(home, { recursive: true, force: true }));
  }
  const { request, requestJson } = server;
  const bodies = [];
  const call = async (label, pathname, options = {}) => {
    const response = await request(pathname, options);
    const body = await response.text();
    bodies.push({ label, body });
    return { status: response.status, json: JSON.parse(body) };
  };
  const post = (label, pathname, payload, headers = {}) => call(label, pathname, { method: "POST", body: JSON.stringify(payload), headers });

  // Config: the old syncMode became the library, with a note.
  const config = await requestJson("/api/config");
  assert.deepEqual(config.library, { installMode: "library", installModeMigrated: { from: "copy" }, autoLink: { enabled: true, scope: "primary" } });

  // Start-up run records the baseline: nothing is linked.
  let library;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    library = (await call("library", "/api/library")).json;
    if (library.autoLink.baselineAt) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(library.autoLink.baselineAt, "the start-up run recorded a baseline");
  assert.deepEqual(library.autoLink.pending, { claude: 2, workbuddy: 2 });
  assert.deepEqual([library.coverage.claude.missing, library.coverage.claude.method, library.coverage.codex.method], [2, "软链接", "原生读取"]);
  assert.deepEqual(library.entries.find((entry) => entry.name === "old-a").fanout.claude, { tier: "link", state: "missing", reason: "没有链接到库", autoLinkable: false, catchUp: true });

  // A new library skill: linked by the run (after a scan, or on request), shown as the last run, undoable.
  await writeFixtureFile(home, ".agents/skills/fresh-skill/SKILL.md", skill("fresh-skill"));
  assert.equal((await post("run:no-header", "/api/library/auto-link/run", {})).status, 400);
  const run = await post("run", "/api/library/auto-link/run", { confirm: true }, HEADER);
  assert.deepEqual(run.json.connected.map((item) => [item.skill, item.agents.sort()]), [["fresh-skill", ["claude", "workbuddy"]]]);
  assert.equal(await readlink(path.join(home, ".claude", "skills", "fresh-skill")), path.join("..", "..", ".agents", "skills", "fresh-skill"));
  library = (await call("library:after-run", "/api/library")).json;
  assert.equal(library.autoLink.lastRun.items[0].skill, "fresh-skill");
  const undo = await post("undo", "/api/library/auto-link/undo", { historyId: run.json.historyId, skill: "fresh-skill", confirm: true }, HEADER);
  assert.equal(undo.status, 200, JSON.stringify(undo.json));
  assert.equal(await lstat(path.join(home, ".claude", "skills", "fresh-skill")).catch(() => null), null);
  library = (await call("library:after-undo", "/api/library")).json;
  assert.equal(library.entries.find((entry) => entry.name === "fresh-skill").fanout.claude.skipped, true, "undone pairs are tombstoned");

  // Settings: off, then on with scope "all" (Kiro joins with its own baseline).
  assert.deepEqual((await post("auto-link:off", "/api/library/auto-link", { enabled: false })).json.settings, { enabled: false, scope: "primary" });
  assert.equal((await post("auto-link:bad", "/api/library/auto-link", { scope: "everyone" })).status, 400);
  const on = (await post("auto-link:on", "/api/library/auto-link", { enabled: true, scope: "all" })).json;
  assert.deepEqual([on.settings, on.autoLink.pending.kiro], [{ enabled: true, scope: "all" }, 3]);
  assert.equal((await requestJson("/api/config")).library.autoLink.scope, "all");

  // Catch-up: plan per Agent, confirmed apply, undoable.
  const plan = (await post("catch-up:plan", "/api/library/catch-up/plan", { agents: ["claude"] })).json;
  assert.deepEqual(plan.byAgent, { claude: { link: 2 } });
  assert.equal((await post("catch-up:no-header", "/api/library/catch-up/apply", { planId: plan.planId, confirm: true })).status, 400);
  const caught = (await post("catch-up:apply", "/api/library/catch-up/apply", { planId: plan.planId, confirm: true }, HEADER)).json;
  assert.deepEqual([caught.results.length, caught.historyEntry.action], [2, "catch-up"]);
  assert.equal((await call("library:caught", "/api/library")).json.coverage.claude.missing, 1, "only the tombstoned fresh-skill is still missing");

  // Installs: a library skill to Kiro; an Agent's own copy to one other Agent only.
  const toKiro = (await post("install:plan", "/api/install/plan", { source: { library: "old-a" }, scope: "agents", agentIds: ["kiro"] })).json;
  assert.deepEqual([toKiro.mode, toKiro.targets[0].outcome, toKiro.alsoVisibleTo], ["library", "link", ["codex"]]);
  assert.equal((await post("install:bad-scope", "/api/install/plan", { source: { library: "old-a" }, scope: "x" })).status, 400);
  assert.equal((await post("install:apply", "/api/install/apply", { planId: toKiro.planId, confirm: true }, HEADER)).status, 200);
  assert.equal(await readlink(path.join(home, ".kiro", "skills", "old-a")), path.join("..", "..", ".agents", "skills", "old-a"));
  const scan = await requestJson("/api/scan?force=1");
  const wbOwn = scan.skills.find((item) => item.name === "wb-own").instances.find((instance) => instance.agentId === "workbuddy");
  const only = (await post("install:agent-only", "/api/install/plan", { source: { instanceId: wbOwn.id }, scope: "agent-only", agentIds: ["claude"] })).json;
  assert.equal(only.mode, "per-agent");
  assert.equal((await post("install:agent-only:apply", "/api/install/apply", { planId: only.planId, confirm: true }, HEADER)).status, 200);
  assert.equal((await lstat(path.join(home, ".claude", "skills", "wb-own"))).isDirectory(), true, "a copy, not in the library");
  assert.equal(await stat(path.join(home, ".agents", "skills", "wb-own")).catch(() => null), null);

  // Into the library for WorkBuddy only: Claude Code and Kiro (in scope, unticked) are tombstoned,
  // so the auto-link run after the next scan does not link it there anyway.
  const rescan = await requestJson("/api/scan?force=1");
  const wbTwo = rescan.skills.find((item) => item.name === "wb-two").instances.find((instance) => instance.agentId === "workbuddy");
  const picked = (await post("install:picked", "/api/install/plan", { source: { instanceId: wbTwo.id }, scope: "agents", agentIds: ["workbuddy"] })).json;
  assert.deepEqual([picked.mode, [...picked.autoLinkSkip].sort()], ["library", ["claude", "kiro"]]);
  assert.equal((await post("install:picked:apply", "/api/install/apply", { planId: picked.planId, confirm: true }, HEADER)).status, 200);
  await requestJson("/api/scan?force=1");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const afterInstall = (await post("run:after-install", "/api/library/auto-link/run", { confirm: true }, HEADER)).json;
  assert.deepEqual(afterInstall.connect.filter((pair) => pair.skill === "wb-two"), []);
  assert.equal(await lstat(path.join(home, ".claude", "skills", "wb-two")).catch(() => null), null);
  assert.equal(await lstat(path.join(home, ".kiro", "skills", "wb-two")).catch(() => null), null);
  assert.equal((await lstat(path.join(home, ".workbuddy", "skills", "wb-two"))).isSymbolicLink(), true);
  const pickedView = (await call("library:picked", "/api/library")).json.entries.find((entry) => entry.name === "wb-two");
  assert.deepEqual([pickedView.fanout.claude.skipped, pickedView.fanout.kiro.skipped], [true, true]);

  // The companion skill: bundled, then in the library and linked to the primary Agents.
  const companion = (await call("companion", "/api/library/companion-skill")).json;
  assert.deepEqual([companion.available, companion.inLibrary, companion.version], [true, false, "1.1.1"]);
  assert.equal((await post("companion:no-header", "/api/library/companion-skill/install", { confirm: true })).status, 400);
  const installed = (await post("companion:install", "/api/library/companion-skill/install", { confirm: true }, HEADER)).json;
  assert.deepEqual([installed.status.inLibrary, installed.status.upToDate, installed.status.fanout.claude.state], [true, true, "visible"]);
  assert.match(await readFile(path.join(home, ".agents", "skills", "skill-control", "SKILL.md"), "utf8"), /^---\nname: skill-control/u);
  assert.ok(await stat(path.join(home, ".agents", "skills", "skill-control", "references", "manual-install.md")));

  // The CLI launcher in the synthetic home's bin folder.
  const launcher = (await call("launcher", "/api/cli-launcher")).json;
  assert.deepEqual([launcher.supported, launcher.installed, launcher.path], [true, false, "~/.local/bin/skill-control"]);
  assert.equal((await post("launcher:no-header", "/api/cli-launcher/install", { confirm: true })).status, 400);
  assert.equal((await post("launcher:install", "/api/cli-launcher/install", { confirm: true }, HEADER)).json.installed, true);
  assert.equal(((await stat(path.join(home, ".local", "bin", "skill-control"))).mode & 0o777).toString(8), "755");
  assert.equal((await post("launcher:uninstall", "/api/cli-launcher/uninstall", { confirm: true }, HEADER)).json.installed, false);
  await writeFixtureFile(home, ".local/bin/skill-control", "#!/bin/sh\necho someone else\n");
  const foreign = await post("launcher:foreign", "/api/cli-launcher/install", { confirm: true }, HEADER);
  assert.deepEqual([foreign.status, foreign.json.code], [409, "foreign-file"]);

  // Privacy and cross-site rules.
  assert.deepEqual(bodies.filter((item) => item.body.includes(home)).map((item) => item.label), []);
  assert.deepEqual(bodies.filter((item) => /ZZ9/u.test(item.body)).map((item) => item.label), []);
  for (const [pathname, method] of [["/api/library/auto-link", "POST"], ["/api/library/catch-up/plan", "POST"], ["/api/install/plan", "POST"], ["/api/library/companion-skill", "GET"], ["/api/cli-launcher", "GET"], ["/api/cli-launcher/install", "POST"]]) {
    const crossSite = await request(pathname, { method, ...(method === "POST" ? { body: "{}" } : {}), headers: { "Sec-Fetch-Site": "cross-site" } });
    assert.equal(crossSite.status, 403, pathname);
  }
  assert.equal((await request("/api/library/auto-link", { method: "POST", body: "{}", headers: { Origin: "https://evil.example.test" } })).status, 403);
});
