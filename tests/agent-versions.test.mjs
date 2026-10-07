import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
    { label: "升级", command: "~/.nvm/versions/node/v24.0.0/bin/npm install -g @openai/codex@latest" },
    { label: "检查版本", command: "~/.nvm/versions/node/v24.0.0/bin/npm ls -g @openai/codex --depth=0" },
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
