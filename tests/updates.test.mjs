import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { localTreeSha, sha256FolderHash, treeShaFromListing, gitBlobSha } from "../server/git-tree.mjs";
import { materializeSkillDirectory, scanAll } from "../server/local-server.mjs";
import { createTransport } from "../server/update-transport.mjs";
import { createUpdateService } from "../server/update-service.mjs";
import { createMockNetwork, createUpdatesHome, GH_TOKEN, HEAD, testAgents, UPSTREAM } from "./fixtures/updates.mjs";

const POSIX = process.platform !== "win32";
// Every test is fully mocked; anything slow means a real network or process call slipped in.
const LIMIT = { timeout: 30_000 };

async function setup(context, network = createMockNetwork(), overrides = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "updates-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const { binDir } = await createUpdatesHome(home);
  const agents = testAgents(home);
  const config = { agents, visibleAgentIds: agents.map((agent) => agent.id), primaryAgentIds: ["codex", "claude"] };
  let scan = JSON.parse(JSON.stringify(await scanAll(config, { homeDirectory: home })));
  const stateDirectory = path.join(home, ".agent-skill-manager");
  const service = createUpdateService({
    homeDirectory: home,
    homes: [home],
    stateDirectory,
    backupDirectory: path.join(stateDirectory, "backups"),
    historyFile: path.join(stateDirectory, "history.jsonl"),
    getScan: async () => scan,
    getAgents: async () => agents,
    getConfig: async () => overrides.config || {},
    materialize: overrides.materialize || materializeSkillDirectory,
    fetchImpl: network.fetchImpl,
    lsRemoteImpl: network.lsRemoteImpl,
    run: overrides.run,
    searchDirectories: overrides.searchDirectories || [{ directory: binDir, nvm: false }, ...(overrides.extraDirectories || [])],
    restrictCommands: overrides.restrictCommands === true,
  });
  const rescan = async () => {
    scan = JSON.parse(JSON.stringify(await scanAll(config, { homeDirectory: home })));
  };
  return { home, service, network, stateDirectory, rescan, binDir };
}

const byTitle = (view) => Object.fromEntries(view.units.map((unit) => [`${unit.sourceType}:${unit.title}`, unit]));

test("git tree hash matches git write-tree and its GitHub listing form", { ...LIMIT, skip: !POSIX }, async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "tree-vector-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  // Known vector, computed with `git add -A && git write-tree` on the same layout.
  await mkdir(path.join(directory, "a", "b"), { recursive: true });
  await mkdir(path.join(directory, "empty"));
  await writeFile(path.join(directory, "a", "b", "x.txt"), "hello\n");
  await writeFile(path.join(directory, "run.sh"), "#!/bin/sh\n");
  await chmod(path.join(directory, "run.sh"), 0o755);
  await writeFile(path.join(directory, "a.txt"), "k");
  await symlink("a/b/x.txt", path.join(directory, "link"));
  assert.equal(await localTreeSha(directory), "2ab254896b61eae38f75d9b37fe706d1d8273679");
  const listing = [
    { path: "a/b/x.txt", mode: "100644", type: "blob", sha: gitBlobSha(Buffer.from("hello\n")).toString("hex") },
    { path: "run.sh", mode: "100755", type: "blob", sha: gitBlobSha(Buffer.from("#!/bin/sh\n")).toString("hex") },
    { path: "a.txt", mode: "100644", type: "blob", sha: gitBlobSha(Buffer.from("k")).toString("hex") },
    { path: "link", mode: "120000", type: "blob", sha: gitBlobSha(Buffer.from("a/b/x.txt")).toString("hex") },
  ];
  assert.equal(treeShaFromListing(listing, ""), "2ab254896b61eae38f75d9b37fe706d1d8273679");
  assert.match(await sha256FolderHash(directory), /^[a-f0-9]{64}$/u);
});

test("three-way states, every source type and the actions they offer", LIMIT, async (context) => {
  const { service, network } = await setup(context);
  const before = await service.view();
  assert.equal(before.checkedAt, null);
  assert.equal(network.calls.length, 0, "viewing never touches the network");
  assert.equal(byTitle(before)["skills-cli:old-skill"].status, "unchecked");
  // lark-cli's own last check is used before Skill Control checks.
  assert.equal(byTitle(before)["lark-cli:lark-cli 与飞书官方技能"].latest, "1.0.90");

  const summary = await service.check();
  assert.ok(summary.requests > 5 && summary.requests < 30);
  const view = await service.view();
  const units = byTitle(view);
  assert.deepEqual(
    ["fresh-skill", "old-skill", "edited-skill", "both-skill", "drift-skill"].map((name) => [name, units[`skills-cli:${name}`].status]),
    [["fresh-skill", "up-to-date"], ["old-skill", "update-available"], ["edited-skill", "locally-modified"], ["both-skill", "conflict"], ["drift-skill", "up-to-date"]],
  );
  assert.equal(units["skills-cli:drift-skill"].lockDrift, true);
  // One folder, three Agents: Codex and OpenClaw read ~/.agents/skills, Claude through a link.
  assert.deepEqual(units["skills-cli:old-skill"].instances.map((instance) => instance.agentId).sort(), ["claude", "codex", "openclaw"]);
  assert.equal(units["skills-cli:old-skill"].action.kind, "self");
  assert.equal(units["skills-cli:old-skill"].latest, HEAD.slice(0, 7));

  const lark = units["lark-cli:lark-cli 与飞书官方技能"];
  assert.deepEqual([lark.status, lark.current, lark.latest], ["update-available", "1.0.66", "1.0.97"]);
  assert.deepEqual(lark.changes, [{ title: "新增官方技能 lark-meeting" }]);
  assert.deepEqual(lark.binaries.map((binary) => [binary.version, binary.hermes]), [["1.0.66", false], ["1.0.56", true]]);
  assert.match(lark.action.command, /^~\/npm\/bin\/lark-cli update --json$/u);

  assert.deepEqual([units["claude-plugin:ecc@ecc-market"].status, units["claude-plugin:ecc@ecc-market"].latest], ["update-available", "2.2.3"]);
  assert.equal(units["claude-plugin:warp@warp-market"].status, "up-to-date");
  assert.equal(units["claude-plugin:nover@acme-market"].status, "up-to-date", "commit-versioned plugins compare by commit");
  assert.deepEqual([units["claude-plugin:old-name@acme-market"].status, units["claude-plugin:old-name@acme-market"].latest], ["update-available", "1.1.0"]);
  assert.match(units["claude-plugin:old-name@acme-market"].reason, /改名为 new-name/u);
  assert.deepEqual([units["claude-plugin:pinned@acme-market"].status, units["claude-plugin:pinned@acme-market"].latest], ["update-available", "4444444"]);
  assert.equal(units["codex-marketplace:chatcut-inc"].status, "up-to-date");
  assert.deepEqual([units["codex-remote-plugin:gmail"].status, units["codex-remote-plugin:gmail"].latest], ["update-available", "0.1.10"]);
  assert.equal(units["workbuddy-marketplace:official"].status, "up-to-date");
  assert.deepEqual([units["workbuddy-skillhub:hub-skill"].status, units["workbuddy-skillhub:hub-skill"].action.kind], ["update-available", "guide"]);
  assert.equal(units["clawhub:claw-skill"].status, "update-available");
  assert.match(units["clawhub:other-registry"].reason, /不在支持列表/u);
  assert.equal(units["clawhub:other-registry"].status, "check-failed");
  assert.match(units["clawhub:ambiguous"].reason, /多个同名技能/u);
  assert.deepEqual([units["git:gstack"].status, units["git:gstack"].action], ["update-available", { kind: "guide", label: "在 Claude Code 中运行 /gstack-upgrade 更新 gstack。", command: "/gstack-upgrade" }]);
  assert.equal(units["git:tooling"].action.kind, "delegate");
  assert.equal(units["unknown:homepage-skill"].possibleSource, "github.com/someone/homepage-skill");
  assert.equal(units["unknown:homepage-skill"].status, "unknown-source");
  // Never a cross-registry request, never npx, never a request to an unknown host.
  assert.equal(network.calls.some((call) => /registry\.example\.test/u.test(call.url)), false);
  assert.ok(view.hosts.every((host) => view.allowedHosts.includes(host)));
  assert.ok(view.counts["update-available"] >= 6);
});

test("rate limits, budgets and offline runs keep earlier results", LIMIT, async (context) => {
  const network = createMockNetwork();
  const { service, home, stateDirectory } = await setup(context, network);
  await service.check();
  // Offline: previous facts remain, marked stale.
  const offline = createMockNetwork({ offline: true });
  const second = createUpdateService({
    homeDirectory: home,
    homes: [home],
    stateDirectory,
    backupDirectory: path.join(stateDirectory, "backups"),
    historyFile: path.join(stateDirectory, "history.jsonl"),
    getScan: async () => JSON.parse(JSON.stringify(await scanAll({ agents: testAgents(home), visibleAgentIds: testAgents(home).map((agent) => agent.id) }, { homeDirectory: home }))),
    getAgents: async () => testAgents(home),
    fetchImpl: offline.fetchImpl,
    lsRemoteImpl: offline.lsRemoteImpl,
    searchDirectories: [],
  });
  await second.check();
  const units = byTitle(await second.view());
  assert.equal(units["skills-cli:old-skill"].status, "update-available");
  assert.equal(units["skills-cli:old-skill"].stale, true);
  assert.equal(units["skills-cli:old-skill"].error.kind, "offline");

  // Rate limited: one GitHub API call, then no more until the reset time.
  const limited = createMockNetwork({ rateLimited: true });
  const transport = createTransport({ fetchImpl: limited.fetchImpl, lsRemoteImpl: limited.lsRemoteImpl });
  await assert.rejects(transport.getJson(`https://api.github.com/repos/acme/skills/git/trees/${HEAD}?recursive=1`), (error) => error.kind === "rate-limited" && error.resetAt > Date.now());
  await assert.rejects(transport.getJson("https://api.github.com/repos/acme/other/git/trees/x"), (error) => error.kind === "rate-limited");
  assert.equal(limited.calls.filter((call) => call.url.startsWith("https://api.github.com")).length, 1);

  // A tiny budget leaves later sources unchecked with a reason, earlier ones checked.
  const budget = await setup(context, createMockNetwork());
  await budget.service.check({ budget: 2 });
  const partial = byTitle(await budget.service.view());
  assert.equal(partial["skills-cli:old-skill"].status, "update-available");
  assert.equal(partial["claude-plugin:ecc@ecc-market"].status, "check-failed");
  assert.match(partial["claude-plugin:ecc@ecc-market"].reason, /请求数已用完/u);
  await assert.rejects(createTransport({ fetchImpl: network.fetchImpl }).getJson("https://evil.example.test/x"), (error) => error.kind === "invalid");
});

test("the gh token is used for api.github.com only and never stored or returned", LIMIT, async (context) => {
  const network = createMockNetwork();
  const run = async (file, args) => (args.join(" ") === "auth token" ? { exitCode: 0, stdout: `${GH_TOKEN}\n`, stderr: "" } : { exitCode: 1, stdout: "", stderr: "" });
  const ghDir = await mkdtemp(path.join(tmpdir(), "gh-"));
  context.after(() => rm(ghDir, { recursive: true, force: true }));
  await writeFile(path.join(ghDir, "gh"), "#!/bin/sh\nexit 1\n");
  await chmod(path.join(ghDir, "gh"), 0o755);
  const { service, stateDirectory } = await setup(context, network, { config: { updates: { useGhAuth: true } }, run, extraDirectories: [{ directory: ghDir, nvm: false }] });
  await service.check();
  const authed = network.calls.filter((call) => call.auth);
  assert.ok(authed.length >= 1);
  assert.ok(authed.every((call) => call.url.startsWith("https://api.github.com/")));
  const stored = await readFile(path.join(stateDirectory, "update-cache.json"), "utf8");
  assert.equal(stored.includes("ZZ9"), false);
  assert.equal(JSON.stringify(await service.view()).includes("ZZ9"), false);
  const changes = await service.changes((await service.view()).units.find((unit) => unit.title === "old-skill").unitKey);
  assert.deepEqual(changes.changes.map((change) => change.title), ["Update old-skill"]);
});

test("self update: plan, confirm, verify, backup, replace once per real folder, rewrite the lock", LIMIT, async (context) => {
  const { service, home, stateDirectory, rescan } = await setup(context);
  await service.check();
  const unitKey = (await service.view()).units.find((unit) => unit.title === "old-skill").unitKey;
  const plan = await service.plan({ unitKey });
  assert.equal(plan.kind, "self");
  assert.deepEqual(plan.changes, { added: ["scripts/run.sh"], modified: ["SKILL.md"], removed: [] });
  assert.equal(plan.steps.filter((step) => step.type === "replace").length, 1, "the linked Claude copy is the same folder");
  await assert.rejects(service.apply({ planId: plan.planId, confirm: false }), /明确确认/u);
  const result = await service.apply({ planId: plan.planId, confirm: true });
  const target = path.join(home, ".agents", "skills", "old-skill");
  assert.equal(await readFile(path.join(target, "SKILL.md"), "utf8"), UPSTREAM["old-skill"]["SKILL.md"]);
  if (POSIX) assert.match(await readFile(path.join(target, "scripts", "run.sh"), "utf8"), /v2/u);
  assert.equal(result.changed.length, 1);
  assert.match(result.changed[0].backup, /^~\/\.agent-skill-manager\/backups\//u);
  const lock = JSON.parse(await readFile(path.join(home, ".agents", ".skill-lock.json"), "utf8"));
  const upstreamRaw = treeShaFromListing((await import("./fixtures/updates.mjs")).upstreamListing(), "skills/old-skill");
  assert.equal(lock.skills["old-skill"].skillFolderHash, upstreamRaw);
  assert.notEqual(lock.skills["old-skill"].updatedAt, "2026-09-01T00:00:00.000Z");
  assert.ok(result.lockBackup.endsWith("skill-lock.json"));
  assert.match(await readFile(path.join(stateDirectory, "history.jsonl"), "utf8"), /"type":"update"/u);
  await assert.rejects(service.apply({ planId: plan.planId, confirm: true }), /不存在或已过期/u, "a plan runs once");
  await rescan();
  assert.equal(byTitle(await service.view())["skills-cli:old-skill"].status, "up-to-date");
});

test("self update refuses tampered downloads and rolls back a failed write", LIMIT, async (context) => {
  const tampered = await setup(context, createMockNetwork({ tampered: false }));
  await tampered.service.check();
  // Swap in a network that serves altered content for the download.
  const unitKey = (await tampered.service.view()).units.find((unit) => unit.title === "old-skill").unitKey;
  const original = await readFile(path.join(tampered.home, ".agents", "skills", "old-skill", "SKILL.md"), "utf8");
  const bad = createMockNetwork({ tampered: true });
  const badService = createUpdateService({
    homeDirectory: tampered.home,
    homes: [tampered.home],
    stateDirectory: tampered.stateDirectory,
    backupDirectory: path.join(tampered.stateDirectory, "backups"),
    historyFile: path.join(tampered.stateDirectory, "history.jsonl"),
    getScan: async () => JSON.parse(JSON.stringify(await scanAll({ agents: testAgents(tampered.home), visibleAgentIds: testAgents(tampered.home).map((agent) => agent.id) }, { homeDirectory: tampered.home }))),
    getAgents: async () => testAgents(tampered.home),
    materialize: materializeSkillDirectory,
    fetchImpl: bad.fetchImpl,
    lsRemoteImpl: bad.lsRemoteImpl,
    searchDirectories: [],
  });
  const plan = await badService.plan({ unitKey });
  await assert.rejects(badService.apply({ planId: plan.planId, confirm: true }), /校验失败/u);
  assert.equal(await readFile(path.join(tampered.home, ".agents", "skills", "old-skill", "SKILL.md"), "utf8"), original);

  // A write that does not match the verified content is undone from the backup.
  const broken = await setup(context, createMockNetwork(), {
    materialize: async ({ destinationPath, backupPath }) => {
      const { cp } = await import("node:fs/promises");
      await mkdir(path.dirname(backupPath), { recursive: true });
      await cp(destinationPath, backupPath, { recursive: true });
      await writeFile(path.join(destinationPath, "SKILL.md"), "corrupted");
    },
  });
  await broken.service.check();
  const brokenKey = (await broken.service.view()).units.find((unit) => unit.title === "old-skill").unitKey;
  const brokenPlan = await broken.service.plan({ unitKey: brokenKey });
  const before = await readFile(path.join(broken.home, ".agents", "skills", "old-skill", "SKILL.md"), "utf8");
  await assert.rejects(broken.service.apply({ planId: brokenPlan.planId, confirm: true }), /已从备份恢复/u);
  assert.equal(await readFile(path.join(broken.home, ".agents", "skills", "old-skill", "SKILL.md"), "utf8"), before);
  const lock = JSON.parse(await readFile(path.join(broken.home, ".agents", ".skill-lock.json"), "utf8"));
  assert.equal(lock.skills["old-skill"].updatedAt, "2026-09-01T00:00:00.000Z", "the lock is untouched after a rollback");
});

test("locally modified skills need a choice; save-as keeps the local copy beside the update", LIMIT, async (context) => {
  const { service, home } = await setup(context);
  await service.check();
  const unitKey = (await service.view()).units.find((unit) => unit.title === "both-skill").unitKey;
  const question = await service.plan({ unitKey });
  assert.deepEqual([question.requiresChoice, question.choices, question.planId], [true, ["keep-local", "overwrite", "save-as"], undefined]);
  const keep = await service.plan({ unitKey, choice: "keep-local" });
  assert.equal(keep.kind, "none");
  const plan = await service.plan({ unitKey, choice: "save-as" });
  assert.ok(plan.steps.some((step) => step.type === "save-as"));
  await service.apply({ planId: plan.planId, confirm: true });
  assert.match(await readFile(path.join(home, ".agents", "skills", "both-skill@local", "SKILL.md"), "utf8"), /my edit/u);
  assert.match(await readFile(path.join(home, ".agents", "skills", "both-skill", "SKILL.md"), "utf8"), /v2/u);
});

test("delegated updates run the owning CLI without a shell and return a redacted tail", { ...LIMIT, skip: !POSIX }, async (context) => {
  const { service, home } = await setup(context);
  await service.check();
  const view = await service.view();
  const lark = view.units.find((unit) => unit.sourceType === "lark-cli");
  const plan = await service.plan({ unitKey: lark.unitKey });
  assert.deepEqual(plan.steps, [{ type: "command", command: "~/npm/bin/lark-cli update --json" }]);
  assert.match(plan.notes[0], /Hermes 自带的 lark-cli（1\.0\.56）/u);
  const result = await service.apply({ planId: plan.planId, confirm: true });
  assert.equal(result.ok, true);
  assert.equal(result.commands[0].exitCode, 0);
  assert.match(result.commands[0].stdout, /"args":"update --json"/u);
  assert.match(result.commands[0].stdout, /"dnt":"1"/u, "telemetry is turned off for delegated commands");
  const body = JSON.stringify(result);
  assert.doesNotMatch(body, /ZZ9/u);
  assert.equal(body.includes(home), false);

  // git: refused when the checkout has uncommitted changes.
  const calls = [];
  const dirty = await setup(context, createMockNetwork(), {
    run: async (file, args) => {
      calls.push(args);
      return { exitCode: 0, stdout: args.includes("status") ? " M SKILL.md\n" : "", stderr: "" };
    },
    extraDirectories: [{ directory: "/usr/bin", nvm: false }],
  });
  await dirty.service.check();
  const tooling = (await dirty.service.view()).units.find((unit) => unit.title === "tooling");
  await assert.rejects(dirty.service.plan({ unitKey: tooling.unitKey }), /未提交的改动/u);
  assert.ok(calls.every((args) => !args.includes("pull")));
  await assert.rejects(service.apply({ planId: "not-a-plan", confirm: true }), /不存在或已过期/u);
});

test("with pinned command folders, a binary outside them is never executed", { ...LIMIT, skip: !POSIX }, async (context) => {
  const empty = await mkdtemp(path.join(tmpdir(), "pinned-"));
  context.after(() => rm(empty, { recursive: true, force: true }));
  const executed = [];
  const { service } = await setup(context, createMockNetwork(), {
    searchDirectories: [{ directory: empty, nvm: false }],
    restrictCommands: true,
    run: async (file, args) => {
      executed.push([file, args]);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  await service.check();
  // Only Hermes' bundled lark-cli is found (it lives outside the pinned folder).
  const lark = (await service.view()).units.find((unit) => unit.sourceType === "lark-cli");
  const plan = await service.plan({ unitKey: lark.unitKey });
  await assert.rejects(service.apply({ planId: plan.planId, confirm: true }), /不在允许执行的目录/u);
  assert.deepEqual(executed, []);
});
