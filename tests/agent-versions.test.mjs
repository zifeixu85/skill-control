import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { compareVersions, createAgentVersionService } from "../server/agent-versions.mjs";
import { createRaccoonHome } from "./fixtures/office-raccoon.mjs";
import { writeFixtureFile } from "./fixtures/smartorder.mjs";

const POSIX = process.platform !== "win32";
const LIMIT = { timeout: 30_000, skip: !POSIX };
const plist = (bundleId, version, extra = "") =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleShortVersionString</key><string>${version}</string>${extra}</dict></plist>\n`;

async function createHome(home) {
  await createRaccoonHome(home);
  const apps = path.join(home, "Applications");
  // QClaw ships a placeholder feed; Cursor a Sparkle appcast.
  await writeFixtureFile(apps, "QClaw.app/Contents/Info.plist", plist("com.tencent.qclaw", "0.2.25"));
  await writeFixtureFile(apps, "QClaw.app/Contents/Resources/app-update.yml", "provider: generic\nurl: https://placeholder.example.com/qclaw\n");
  await writeFixtureFile(apps, "Cursor.app/Contents/Info.plist", plist("com.todesktop.230313mzl4w4u92", "3.20.17", "<key>SUFeedURL</key><string>https://appcast.cursor-fixture.com/mac.xml</string>"));
  await writeFixtureFile(apps, "WorkBuddy.app/Contents/Info.plist", plist("com.tencent.workbuddy.mac", "5.7.6"));

  const node = path.join(home, ".nvm", "versions", "node", "v24.0.0");
  await writeFixtureFile(node, "lib/node_modules/@openai/codex/package.json", JSON.stringify({ name: "@openai/codex", version: "0.150.0" }));
  await writeFixtureFile(node, "lib/node_modules/@openai/codex/bin/codex.js", "#!/usr/bin/env node\n");
  await writeFixtureFile(node, "bin/npm", "#!/bin/sh\n");
  await mkdir(path.join(node, "bin"), { recursive: true });
  await symlink(path.join(node, "lib", "node_modules", "@openai", "codex", "bin", "codex.js"), path.join(node, "bin", "codex"));

  await writeFixtureFile(home, ".local/share/claude/versions/2.1.283", "binary");
  await mkdir(path.join(home, ".local", "bin"), { recursive: true });
  await symlink(path.join(home, ".local", "share", "claude", "versions", "2.1.283"), path.join(home, ".local", "bin", "claude"));

  const hermes = path.join(home, ".hermes", "hermes-agent");
  await writeFixtureFile(hermes, "pyproject.toml", '[project]\nname = "hermes-agent"\nversion = "0.0.0"\n');
  await writeFixtureFile(hermes, "hermes_cli/__init__.py", '__release_date__ = "2026.9.1"\n');
  await writeFixtureFile(hermes, ".git/config", '[remote "origin"]\n\turl = git@github.com:NousResearch/hermes-agent.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
  await writeFixtureFile(home, ".hermes/node/lib/node_modules/@larksuite/cli/package.json", JSON.stringify({ name: "@larksuite/cli", version: "1.0.56" }));
  await writeFixtureFile(home, ".hermes/node/lib/node_modules/@larksuite/cli/scripts/run.js", "");
  await mkdir(path.join(home, ".hermes", "node", "bin"), { recursive: true });
  await symlink(path.join(home, ".hermes", "node", "lib", "node_modules", "@larksuite", "cli", "scripts", "run.js"), path.join(home, ".hermes", "node", "bin", "lark-cli"));
  return { searchDirectories: [{ directory: path.join(node, "bin") }, { directory: path.join(home, ".local", "bin") }] };
}

const FEEDS = {
  "https://registry.npmjs.org/@openai%2Fcodex/latest": { json: { name: "@openai/codex", version: "0.160.0" } },
  "https://registry.npmjs.org/@anthropic-ai%2Fclaude-code/latest": { json: { version: "2.1.283" } },
  "https://registry.npmjs.org/@larksuite%2Fcli/latest": { json: { version: "1.0.97" } },
  "https://api.github.com/repos/NousResearch/hermes-agent/releases/latest": { json: { tag_name: "v2026.9.24", published_at: "2026-09-24T00:00:00Z", html_url: "https://github.com/NousResearch/hermes-agent/releases/tag/v2026.9.24" } },
  "https://updates.raccoon-fixture.cn/office-agent/mac/latest-mac.yml": { text: "version: 1.0.20\nreleaseDate: '2026-10-01T00:00:00.000Z'\npath: x.zip\n" },
  "https://appcast.cursor-fixture.com/mac.xml": {
    text: '<rss><channel><item><title>3.21</title><pubDate>Mon, 05 Oct 2026 00:00:00 GMT</pubDate><enclosure url="https://x" sparkle:shortVersionString="3.21.0" sparkle:version="321"/></item><item><enclosure sparkle:shortVersionString="3.19.0"/></item></channel></rss>',
  },
};

function fakeFetch() {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    const feed = FEEDS[url];
    if (!feed) return new Response("missing", { status: 404 });
    return new Response(feed.json ? JSON.stringify(feed.json) : feed.text, { status: 200 });
  };
  return { fetchImpl, calls, maxInFlight: () => maxInFlight };
}

async function setup(context, options = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "agent-versions-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const { searchDirectories } = await createHome(home);
  const network = fakeFetch();
  const service = createAgentVersionService({
    homeDirectory: home,
    homes: [home],
    stateDirectory: path.join(home, ".agent-skill-manager"),
    applicationDirectories: [path.join(home, "Applications")],
    searchDirectories,
    fetchImpl: network.fetchImpl,
    offline: false,
    ...options,
  });
  context.after(() => service.stop());
  return { home, service, network };
}

const rows = (view) => Object.fromEntries(view.agents.map((row) => [row.id, row]));

test("versions compare numerically; a pre-release sorts before its release", () => {
  assert.equal(compareVersions("0.159.3", "0.160.0"), -1);
  assert.equal(compareVersions("v2026.9.24", "2026.9.24"), 0);
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("2.0.0-beta.1", "2.0.0"), -1);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
});

test("installed versions come from files, latest from official feeds only", LIMIT, async (context) => {
  const { home, service, network } = await setup(context);
  const before = rows(await service.view());
  assert.deepEqual(Object.keys(before).sort(), ["claude-cli", "codex-cli", "cursor-app", "hermes-cli", "lark-cli-hermes", "office-raccoon-app", "qclaw-app", "workbuddy-app"]);
  assert.deepEqual(before["codex-cli"].installed, { version: "0.150.0", source: "npm", path: "~/.nvm/versions/node/v24.0.0/lib/node_modules/@openai/codex" });
  assert.deepEqual([before["claude-cli"].installed.version, before["claude-cli"].installed.source], ["2.1.283", "cli"]);
  assert.deepEqual([before["hermes-cli"].installed.version, before["lark-cli-hermes"].installed.source], ["2026.9.1", "bundled"]);
  assert.deepEqual([before["codex-cli"].status, before["codex-cli"].reason], ["unknown", "还没有检查过。"]);
  assert.equal(network.calls.length, 0, "viewing never touches the network");

  const after = rows(await service.check());
  assert.deepEqual(
    Object.fromEntries(Object.values(after).map((row) => [row.id, row.status])),
    {
      "codex-cli": "update-available",
      "claude-cli": "up-to-date",
      "hermes-cli": "update-available",
      "workbuddy-app": "unknown",
      "cursor-app": "update-available",
      "qclaw-app": "unknown",
      "office-raccoon-app": "update-available",
      "lark-cli-hermes": "update-available",
    },
  );
  assert.deepEqual(after["office-raccoon-app"].latest, { version: "1.0.20", source: "electron-updater", url: "https://updates.raccoon-fixture.cn/office-agent/mac/latest-mac.yml", releasedAt: "2026-10-01T00:00:00.000Z" });
  assert.deepEqual([after["cursor-app"].latest.version, after["cursor-app"].latest.source], ["3.21.0", "sparkle"]);
  assert.deepEqual([after["hermes-cli"].latest.version, after["hermes-cli"].latest.source], ["2026.9.24", "github"]);
  assert.match(after["qclaw-app"].reason, /占位地址/u);
  assert.match(after["workbuddy-app"].reason, /没有公开的更新源/u);

  // One request per feed, no identifiers, at most 4 in flight.
  assert.equal(network.calls.length, 6);
  assert.ok(network.maxInFlight() <= 4);
  for (const call of network.calls) {
    assert.deepEqual(Object.keys(call.headers).sort(), ["accept", "user-agent"]);
    assert.equal(call.headers["user-agent"], "skill-control-version-check");
  }

  // Remedies: the exact npm of that Node, the official updaters, the app's own updater.
  assert.deepEqual(after["codex-cli"].remedy.commands, [
    { label: "升级", command: "~/.nvm/versions/node/v24.0.0/bin/npm install -g --prefix ~/.nvm/versions/node/v24.0.0 @openai/codex@latest" },
    { label: "检查版本", command: "~/.nvm/versions/node/v24.0.0/bin/npm ls -g --prefix ~/.nvm/versions/node/v24.0.0 @openai/codex --depth=0" },
  ]);
  assert.match(after["codex-cli"].remedy.prompt, /0\.150\.0 → 0\.160\.0/u);
  assert.deepEqual(after["hermes-cli"].remedy.commands.map((command) => command.command), ["git -C ~/.hermes/hermes-agent status --short", "hermes update"]);
  assert.equal(after["office-raccoon-app"].remedy.commands, undefined);
  assert.match(after["office-raccoon-app"].remedy.prompt, /检查更新/u);
  assert.match(after["lark-cli-hermes"].remedy.prompt, /hermes update/u);
  assert.equal(after["claude-cli"].remedy, undefined, "nothing to do when up to date");
  for (const row of Object.values(after)) {
    if (row.remedy) assert.ok(row.remedy.prompt.length <= 1_500);
  }
  assert.equal(JSON.stringify(after).includes(home), false);

  const cache = JSON.parse(await readFile(service.cacheFile, "utf8"));
  assert.equal(cache.version, 1);
  assert.ok(cache.checkedAt);
});

test("offline: no request at all; failures and timeouts become errors", LIMIT, async (context) => {
  const offline = await setup(context, { offline: true });
  const view = await offline.service.check();
  assert.deepEqual([view.offline, offline.network.calls.length], [true, 0]);

  const slow = await setup(context, {
    timeoutMs: 30,
    fetchImpl: (url, init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })))),
  });
  const row = rows(await slow.service.check())["codex-cli"];
  assert.deepEqual([row.status, row.error], ["error", "请求超时。"]);
});

test("start(): checks when the cache is older than a day, otherwise waits", LIMIT, async (context) => {
  let clock = Date.parse("2026-10-07T00:00:00Z");
  const { service, network } = await setup(context, { now: () => clock });
  await mkdir(path.dirname(service.cacheFile), { recursive: true });
  await writeFile(service.cacheFile, JSON.stringify({ version: 1, checkedAt: new Date(clock - 3_600_000).toISOString(), results: {} }));
  await service.start();
  assert.equal(network.calls.length, 0, "a fresh cache is reused");
  service.stop();
  clock += 25 * 3_600_000;
  await service.start();
  const checkedAt = new Date(clock).toISOString();
  const cachedAt = async () => JSON.parse(await readFile(service.cacheFile, "utf8")).checkedAt;
  for (let attempt = 0; attempt < 200 && (await cachedAt()) !== checkedAt; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(network.calls.length, 6);
  const view = await service.view();
  assert.equal(view.nextCheckAt, new Date(Date.parse(view.checkedAt) + 24 * 3_600_000).toISOString());
});

// ---------------------------------------------------------------------------
// One-click updates (v0.2 §2)

const NEWER = {
  "https://registry.npmjs.org/@anthropic-ai%2Fclaude-code/latest": { version: "2.1.300" },
  "https://registry.npmjs.org/openclaw/latest": { version: "2026.10.1" },
};

/** The fixture plus OpenClaw (npm) and Hermes' own npm; Claude Code has a newer release. */
async function oneClickSetup(context, options = {}) {
  const network = fakeFetch();
  const fetchImpl = async (url, init) => (NEWER[url] ? new Response(JSON.stringify(NEWER[url]), { status: 200 }) : network.fetchImpl(url, init));
  const runs = [];
  const run = async (file, args, runOptions) => {
    runs.push({ file, args, ...runOptions });
    if (args.includes("@openai/codex@latest")) {
      await writeFile(path.join(runOptions.cwd, ".nvm", "versions", "node", "v24.0.0", "lib", "node_modules", "@openai", "codex", "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.160.0" }));
    }
    return { exitCode: options.exitCode ?? 0, stdout: `changed 1 package in ${runOptions.cwd}/x\napi_key=ZZ9outputSecret01abcdef\n`, stderr: "" };
  };
  const launches = [];
  const result = await setup(context, { fetchImpl, run, launch: async (bundleId) => launches.push(bundleId), platform: "darwin", pinnedDirectories: [], ...options.service });
  if (options.service?.run) runs.length = 0;
  const node = path.join(result.home, ".nvm", "versions", "node", "v24.0.0");
  await writeFixtureFile(node, "lib/node_modules/openclaw/package.json", JSON.stringify({ name: "openclaw", version: "2026.9.8" }));
  await writeFixtureFile(node, "lib/node_modules/openclaw/openclaw.mjs", "#!/usr/bin/env node\n");
  await symlink(path.join(node, "lib", "node_modules", "openclaw", "openclaw.mjs"), path.join(node, "bin", "openclaw"));
  await chmod(await writeFixtureFile(result.home, ".hermes/node/bin/npm", "#!/bin/sh\n"), 0o755);
  return { ...result, runs, launches };
}

test("one-click update: verified official commands only, shown in the plan first", LIMIT, async (context) => {
  const { home, service } = await oneClickSetup(context);
  const view = rows(await service.check());
  assert.deepEqual(view["codex-cli"].remedy.action, { kind: "agent-update", id: "codex-cli" });
  assert.deepEqual(view["openclaw-cli"].remedy.action, { kind: "agent-update", id: "openclaw-cli" });
  assert.deepEqual(view["claude-cli"].remedy.action, { kind: "agent-update", id: "claude-cli" });
  assert.deepEqual(view["lark-cli-hermes"].remedy.action, { kind: "agent-update", id: "lark-cli-hermes" });
  assert.equal(view["hermes-cli"].remedy.action, undefined, "Hermes: AI prompt only");
  assert.equal(view["cursor-app"].remedy.action, undefined, "apps update themselves");
  assert.deepEqual(view["cursor-app"].openApp, { bundleId: "com.todesktop.230313mzl4w4u92" });
  assert.deepEqual(view["openclaw-cli"].remedy.commands.map((command) => command.command), ["openclaw update", "openclaw --version"]);
  assert.match(view["lark-cli-hermes"].remedy.prompt, /Hermes 自带的 node/u);

  const displays = {};
  for (const id of ["codex-cli", "openclaw-cli", "claude-cli", "lark-cli-hermes"]) {
    const plan = await service.plan({ id });
    assert.match(plan.planId, /^[0-9a-f-]{36}$/u);
    assert.deepEqual(plan.afterCheck, { kind: "version", id });
    assert.ok(plan.effects.length >= 2 && Date.parse(plan.expiresAt) > Date.now());
    displays[id] = plan.steps.map((step) => step.display);
  }
  assert.deepEqual(displays, {
    "codex-cli": ["~/.nvm/versions/node/v24.0.0/bin/npm install -g --prefix ~/.nvm/versions/node/v24.0.0 @openai/codex@latest"],
    "openclaw-cli": ["~/.nvm/versions/node/v24.0.0/bin/openclaw update"],
    "claude-cli": ["~/.local/bin/claude update"],
    "lark-cli-hermes": ["~/.hermes/node/bin/npm install -g --prefix ~/.hermes/node @larksuite/cli@latest"],
  });
  const refused = async (id) => service.plan({ id }).then(() => null, (error) => [error.statusCode, error.code]);
  assert.deepEqual(await refused("hermes-cli"), [409, "refused"]);
  assert.deepEqual(await refused("cursor-app"), [409, "refused"]);
  assert.deepEqual(await refused("workbuddy-app"), [409, "check-required"]);
  assert.deepEqual(await refused("nope"), [404, "not-found"]);
  assert.deepEqual(await refused("../x"), [400, "invalid-request"]);
  assert.equal(JSON.stringify(displays).includes(home), false);
});

test("one-click update: apply runs once without a shell, scrubs output and records history", LIMIT, async (context) => {
  const { home, service, runs } = await oneClickSetup(context);
  await service.check();
  const plan = await service.plan({ id: "codex-cli" });
  await assert.rejects(service.apply({ planId: plan.planId }), (error) => error.code === "confirm-required");
  const result = await service.apply({ planId: plan.planId, confirm: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.version, { before: "0.150.0", after: "0.160.0" });
  assert.equal(runs.length, 1);
  // The npm and prefix that own this copy (real paths: /private/var/… for a /var/… home).
  const node = await realpath(path.join(home, ".nvm", "versions", "node", "v24.0.0"));
  assert.deepEqual([runs[0].file, runs[0].args], [path.join(node, "bin", "npm"), ["install", "-g", "--prefix", node, "@openai/codex@latest"]]);
  assert.deepEqual(Object.keys(runs[0].env).sort(), ["HOME", "LANG", "PATH"], "no inherited environment");
  assert.ok(runs[0].env.PATH.split(path.delimiter).includes(path.join(node, "bin")), "npm finds its own node");
  assert.deepEqual([runs[0].cwd, runs[0].timeoutMs], [home, 300_000]);
  assert.doesNotMatch(JSON.stringify(result), /ZZ9/u);
  assert.equal(JSON.stringify(result).includes(home), false);
  assert.match(result.steps[0].output, /~\/x/u);
  const history = (await readFile(path.join(home, ".agent-skill-manager", "history.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual([history[0].type, history[0].agentId, history[0].restorable, history[0].ok], ["agent-update", "codex", false, true]);
  assert.doesNotMatch(JSON.stringify(history), /ZZ9/u);
  await assert.rejects(service.apply({ planId: plan.planId, confirm: true }), (error) => error.code === "plan-not-found");
});

test("one-click update: failures stop, offline and pinned folders refuse, apps open by bundle id", LIMIT, async (context) => {
  const failing = await oneClickSetup(context, { exitCode: 1 });
  await failing.service.check();
  const failed = await failing.service.apply({ planId: (await failing.service.plan({ id: "openclaw-cli" })).planId, confirm: true });
  assert.deepEqual([failed.ok, failed.steps[0].exitCode, failed.version.after], [false, 1, "2026.9.8"]);

  // A plan made online, applied by an offline service: nothing runs.
  const online = await oneClickSetup(context);
  await online.service.check();
  const offline = createAgentVersionService({
    homeDirectory: online.home,
    stateDirectory: path.join(online.home, ".agent-skill-manager"),
    applicationDirectories: [path.join(online.home, "Applications")],
    searchDirectories: [{ directory: path.join(online.home, ".nvm", "versions", "node", "v24.0.0", "bin") }, { directory: path.join(online.home, ".local", "bin") }],
    offline: true,
    pinnedDirectories: [],
    run: async () => assert.fail("must not run offline"),
  });
  const offlinePlan = await offline.plan({ id: "claude-cli" });
  await assert.rejects(offline.apply({ planId: offlinePlan.planId, confirm: true }), (error) => error.code === "updates-offline");

  const pinned = await oneClickSetup(context, { service: { pinnedDirectories: [path.join(tmpdir(), "elsewhere")] } });
  await pinned.service.check();
  await assert.rejects(pinned.service.plan({ id: "codex-cli" }), (error) => [error.statusCode, error.code].join() === "403,command-not-allowed");

  assert.deepEqual(await online.service.openApp({ id: "cursor-app" }), { opened: true, bundleId: "com.todesktop.230313mzl4w4u92" });
  assert.deepEqual(online.launches, ["com.todesktop.230313mzl4w4u92"]);
  await assert.rejects(online.service.openApp({ id: "codex-cli" }), (error) => error.code === "refused");
  const sandboxed = createAgentVersionService({ homeDirectory: online.home, stateDirectory: path.join(online.home, ".agent-skill-manager"), applicationDirectories: [path.join(online.home, "Applications")], searchDirectories: [], platform: "darwin", pinnedDirectories: ["/nowhere"] });
  await assert.rejects(sandboxed.openApp({ id: "cursor-app" }), (error) => error.code === "command-not-allowed");
});

test("two copies of Claude Code: both listed, the first on the PATH is active", LIMIT, async (context) => {
  const home = await mkdtemp(path.join(tmpdir(), "agent-versions-claude-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const node = path.join(home, ".nvm", "versions", "node", "v24.0.0");
  await writeFixtureFile(node, "lib/node_modules/@anthropic-ai/claude-code/package.json", JSON.stringify({ name: "@anthropic-ai/claude-code", version: "2.1.250" }));
  await writeFixtureFile(node, "lib/node_modules/@anthropic-ai/claude-code/cli.js", "#!/usr/bin/env node\n");
  await mkdir(path.join(node, "bin"), { recursive: true });
  await symlink(path.join(node, "lib", "node_modules", "@anthropic-ai", "claude-code", "cli.js"), path.join(node, "bin", "claude"));
  await writeFixtureFile(home, ".local/share/claude/versions/2.1.283", "binary");
  await mkdir(path.join(home, ".local", "bin"), { recursive: true });
  await symlink(path.join(home, ".local", "share", "claude", "versions", "2.1.283"), path.join(home, ".local", "bin", "claude"));
  const service = createAgentVersionService({
    homeDirectory: home,
    stateDirectory: path.join(home, ".agent-skill-manager"),
    applicationDirectories: [],
    searchDirectories: [{ directory: path.join(home, ".local", "bin") }, { directory: path.join(node, "bin") }],
    offline: true,
  });
  const claude = (await service.view()).agents.filter((row) => row.agentId === "claude");
  assert.deepEqual(
    claude.map((row) => [row.id, row.name, row.installed.source, row.installed.version, row.active]),
    [
      ["claude-cli", "Claude Code（原生安装）", "cli", "2.1.283", true],
      ["claude-cli-2", "Claude Code（npm）", "npm", "2.1.250", false],
    ],
  );
});

test("Hermes: the installed version in the latest tag's scheme (baseVersion for v0.22+, release date before)", LIMIT, async (context) => {
  const semverFeed = fakeFetch();
  const semver = await setup(context, {
    fetchImpl: async (url, init) =>
      url.endsWith("/hermes-agent/releases/latest") ? new Response(JSON.stringify({ tag_name: "v0.22.5", published_at: "2026-10-23T05:28:45Z" }), { status: 200 }) : semverFeed.fetchImpl(url, init),
  });
  await writeFixtureFile(semver.home, ".hermes/hermes-agent/install-stamp.json", JSON.stringify({ baseVersion: "0.21.5" }));
  assert.equal(rows(await semver.service.view())["hermes-cli"].installed.version, "0.21.5", "before a check: baseVersion");
  const checked = rows(await semver.service.check())["hermes-cli"];
  assert.deepEqual([checked.installed.version, checked.latest.version, checked.status], ["0.21.5", "0.22.5", "update-available"]);

  const calendar = await setup(context);
  await writeFixtureFile(calendar.home, ".hermes/hermes-agent/install-stamp.json", JSON.stringify({ baseVersion: "0.21.5" }));
  const old = rows(await calendar.service.check())["hermes-cli"];
  assert.deepEqual([old.installed.version, old.latest.version, old.status], ["2026.9.1", "2026.9.24", "update-available"]);
});

test("background update: returns a job at once, one job per product, redacted output tail, history", LIMIT, async (context) => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { home, service } = await oneClickSetup(context, {
    service: {
      run: async (file, args, options) => {
        options.onOutput(`fetching… api_key=ZZ9jobSecret01abcdef in ${options.cwd}/x\n`);
        await gate;
        await writeFile(path.join(options.cwd, ".nvm", "versions", "node", "v24.0.0", "lib", "node_modules", "@openai", "codex", "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.160.0" }));
        return { exitCode: 0, stdout: "changed 1 package\n", stderr: "" };
      },
    },
  });
  await service.check();
  const started = await service.apply({ planId: (await service.plan({ id: "codex-cli" })).planId, confirm: true, background: true });
  assert.match(started.jobId, /^[0-9a-f-]{36}$/u);
  assert.deepEqual([started.status, started.afterCheck], ["running", { kind: "version", id: "codex-cli" }]);
  for (let attempt = 0; attempt < 100 && service.job(started.jobId).step === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const running = service.job(started.jobId);
  assert.deepEqual([running.status, running.step, running.finishedAt], ["running", 1, null]);
  assert.match(running.outputTail, /api_key=•••••• in ~\/x/u);
  assert.doesNotMatch(JSON.stringify(running), /ZZ9/u);
  assert.equal(JSON.stringify(running).includes(home), false);
  // One job per product: a second plan for the same CLI is refused (and stays usable later).
  const second = await service.plan({ id: "codex-cli" });
  await assert.rejects(service.apply({ planId: second.planId, confirm: true, background: true }), (error) => error.code === "job-running");
  await assert.rejects(service.terminal({ planId: second.planId, confirm: true }), (error) => error.code === "command-not-allowed" || error.code === "job-running");
  release();
  let done = service.job(started.jobId);
  for (let attempt = 0; attempt < 200 && done.status === "running"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    done = service.job(started.jobId);
  }
  assert.deepEqual([done.status, done.steps[0].exitCode, done.version], ["done", 0, { before: "0.150.0", after: "0.160.0" }]);
  assert.ok(Date.parse(done.finishedAt) >= Date.parse(done.startedAt));
  const history = (await readFile(path.join(home, ".agent-skill-manager", "history.jsonl"), "utf8")).trim().split("\n").map((entry) => JSON.parse(entry));
  assert.deepEqual([history.at(-1).mode, history.at(-1).ok], ["background", true]);
  assert.throws(() => service.job("00000000-0000-0000-0000-000000000000"), (error) => error.code === "job-not-found");
});

test("open in terminal: a private one-off script with the plan's exact commands, opened by the injected opener", LIMIT, async (context) => {
  const opened = [];
  const temp = await mkdtemp(path.join(tmpdir(), "agent-versions-terminal-"));
  context.after(() => rm(temp, { recursive: true, force: true }));
  const { home, service, runs } = await oneClickSetup(context, { service: { openFile: async (file, platform) => opened.push({ file, platform }), tempRoot: temp } });
  await service.check();
  const plan = await service.plan({ id: "codex-cli" });
  await assert.rejects(service.terminal({ planId: plan.planId }), (error) => error.code === "confirm-required");
  const result = await service.terminal({ planId: plan.planId, confirm: true });
  assert.deepEqual([result.opened, result.afterCheck, result.historyEntry.mode, result.historyEntry.ok], [true, { kind: "version", id: "codex-cli" }, "terminal", null]);
  assert.equal(runs.length, 0, "the app itself runs nothing");
  assert.equal(opened.length, 1);
  const { file } = opened[0];
  assert.equal(path.basename(file), "skill-control-update.command");
  assert.equal((await stat(file)).mode & 0o777, 0o700);
  assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
  assert.ok(path.dirname(file).startsWith(temp));
  const script = await readFile(file, "utf8");
  const node = await realpath(path.join(home, ".nvm", "versions", "node", "v24.0.0"));
  assert.ok(script.includes(`'${path.join(node, "bin", "npm")}' 'install' '-g' '--prefix' '${node}' '@openai/codex@latest' || status=$?`));
  assert.match(script, /完成，可以关闭这个窗口（退出码 \$status）/u);
  assert.match(script, /^PATH='[^']+'$/mu);
  await assert.rejects(service.terminal({ planId: plan.planId, confirm: true }), (error) => error.code === "plan-not-found");

  // Run the generated script (not in a terminal): it shows the command, runs it and waits for a key.
  await writeFile(path.join(node, "bin", "npm"), '#!/bin/sh\necho "npm was called with: $*"\nexit 3\n');
  await chmod(path.join(node, "bin", "npm"), 0o755);
  const { spawnSync } = await import("node:child_process");
  const ran = spawnSync("/bin/sh", [file], { input: "x", encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin" } });
  assert.match(ran.stdout, /运行：~\/\.nvm\/versions\/node\/v24\.0\.0\/bin\/npm install -g --prefix/u);
  assert.match(ran.stdout, /npm was called with: install -g --prefix .* @openai\/codex@latest/u);
  assert.match(ran.stdout, /退出码 3/u);
  assert.equal(ran.status, 3);
  assert.equal(await stat(file).catch(() => null), null, "the script removes itself");

  // Sandboxes (pinned commands) never open anything without an injected opener.
  const pinned = createAgentVersionService({ homeDirectory: home, stateDirectory: path.join(home, ".agent-skill-manager"), applicationDirectories: [], searchDirectories: [], pinnedDirectories: ["/nowhere"] });
  await assert.rejects(pinned.terminal({ planId: "x", confirm: true }), (error) => error.code === "command-not-allowed");
});

test("terminal scripts quote every value; the Windows script refuses unsafe characters", async () => {
  const { posixQuote, terminalScript } = await import("../server/agent-update-run.mjs");
  assert.equal(posixQuote("it's $HOME `x`"), "'it'\\''s $HOME `x`'");
  const steps = [{ program: "C:\\Program Files\\nodejs\\npm.cmd", args: ["install", "-g", "@openai/codex@latest"], display: "npm install -g @openai/codex@latest" }];
  const windows = terminalScript({ title: "Codex", steps, pathEntries: ["C:\\Program Files\\nodejs"], platform: "win32" });
  assert.equal(windows.name, "skill-control-update.cmd");
  assert.match(windows.content, /"C:\\Program Files\\nodejs\\npm\.cmd" "install" "-g" "@openai\/codex@latest"\r\n/u);
  assert.match(windows.content, /pause\r\n/u);
  assert.throws(() => terminalScript({ title: "x", steps: [{ ...steps[0], args: ["a&calc"] }], pathEntries: [], platform: "win32" }), (error) => error.code === "unsafe-command");
});

test("the streaming runner runs without a shell, streams output and times out", LIMIT, async () => {
  const { runStreaming } = await import("../server/agent-update-run.mjs");
  const chunks = [];
  const echoed = await runStreaming("/bin/echo", ["a;b", "$HOME"], { cwd: tmpdir(), env: { PATH: "/usr/bin:/bin" }, timeoutMs: 5_000, onOutput: (chunk) => chunks.push(chunk) });
  assert.deepEqual([echoed.exitCode, echoed.stdout, chunks.join("")], [0, "a;b $HOME\n", "a;b $HOME\n"]);
  const slow = await runStreaming("/bin/sleep", ["5"], { cwd: tmpdir(), env: { PATH: "/usr/bin:/bin" }, timeoutMs: 50 });
  assert.equal(slow.exitCode, "timeout");
  assert.equal((await runStreaming("/nonexistent/program", [], { cwd: tmpdir(), timeoutMs: 1_000 })).exitCode, 1);
});
