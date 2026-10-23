import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import * as macOps from "../desktop/app-update-mac.mjs";
import { createAppUpdater, LATEST_RELEASE_API, RELEASES_URL } from "../desktop/app-updater.mjs";
import {
  bundleVersion,
  fakeFetch,
  json,
  macManifest,
  makeBundle,
  releaseJson,
  REPO,
  tempDir,
} from "./helpers/app-update-fixtures.mjs";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Controller

const ZIP = Buffer.from("pretend this is Skill-Control-0.2.0-mac-arm64.zip");
const ZIP_NAME = "Skill-Control-0.2.0-mac-arm64.zip";

function macRoutes({ zip = ZIP, manifestZip = ZIP, version = "0.2.0" } = {}) {
  const assetBase = `${REPO}/releases/download/v${version}`;
  return {
    [LATEST_RELEASE_API]: () => json(releaseJson(version, ["latest-mac.yml", ZIP_NAME, `Skill-Control-${version}-mac-x64.zip`])),
    [`${assetBase}/latest-mac.yml`]: () =>
      new Response(macManifest(version, [[ZIP_NAME, manifestZip], [`Skill-Control-${version}-mac-x64.zip`, Buffer.from("x64")]])),
    [`${assetBase}/${ZIP_NAME}`]: () => new Response(zip),
  };
}

async function controllerFixture(t, { routes = macRoutes(), env = {}, mac = {}, ...options } = {}) {
  const root = await tempDir(t, "controller");
  const applications = path.join(root, "Applications");
  const current = await makeBundle(applications, { version: "0.1.0" });
  const trash = path.join(root, "Trash");
  await mkdir(trash);
  const events = [];
  const opened = [];
  const relaunched = [];
  let quits = 0;
  const { fetchImpl, calls } = fakeFetch(routes);
  const updater = createAppUpdater({
    currentVersion: "0.1.0",
    platform: "darwin",
    arch: "arm64",
    packaged: true,
    env,
    fetchImpl,
    stateFile: path.join(root, "userData", "app-update.json"),
    tempRoot: path.join(root, "tmp"),
    executablePath: path.join(current, "Contents", "MacOS", "Skill Control"),
    now: () => Date.parse("2026-10-24T12:00:00Z"),
    openExternal: async (url) => opened.push(url),
    trashItem: async (target) => rename(target, path.join(trash, path.basename(target))),
    quit: () => {
      quits += 1;
    },
    emit: (state) => events.push(state),
    logger: { warn() {} },
    timers: { setTimeout: (callback) => (callback(), 0), setInterval: () => 0, clearTimeout() {}, clearInterval() {} },
    mac: {
      ...macOps,
      // ditto is macOS-only: "extract" by writing the new bundle.
      extractZip: async (_zip, destination) => {
        await makeBundle(destination, { version: "0.2.0" });
      },
      spawnRelaunchHelper: (options_) => relaunched.push(options_),
      ...mac,
    },
    ...options,
  });
  return { root, applications, current, trash, events, opened, relaunched, calls, updater, quits: () => quits };
}

test("offline mode and source runs report unsupported without any request", async (t) => {
  const offline = await controllerFixture(t, { env: { SKILL_MANAGER_UPDATES_OFFLINE: "1" } });
  const state = await offline.updater.check();
  assert.equal(state.status, "unsupported");
  assert.equal(state.reason, "offline");
  assert.equal(state.canInstall, false);
  assert.match(state.manual, /离线/u);
  assert.equal((await offline.updater.download()).status, "unsupported");
  assert.equal((await offline.updater.install()).status, "unsupported");
  await offline.updater.start();
  assert.equal(offline.calls.length, 0);

  const source = await controllerFixture(t, { packaged: false });
  assert.equal((await source.updater.check()).reason, "development");
  assert.equal(source.calls.length, 0);
});

test("no release, or a latest release older than this build (a pre-release install), is up to date", async (t) => {
  const none = await controllerFixture(t, { routes: {} });
  const state = await none.updater.check();
  assert.equal(state.status, "up-to-date");
  assert.equal(state.error, undefined);
  assert.equal(state.url, RELEASES_URL);

  const older = await controllerFixture(t, { routes: { [LATEST_RELEASE_API]: () => json(releaseJson("0.1.0", [])) }, currentVersion: "0.2.0" });
  const olderState = await older.updater.check();
  assert.equal(olderState.status, "up-to-date");
  assert.equal(olderState.latest, undefined);
  assert.equal(olderState.error, undefined);
});

test("check finds a newer release, remembers it and reuses a check from the last minute", async (t) => {
  const fixture = await controllerFixture(t);
  const state = await fixture.updater.check();
  assert.equal(state.status, "available");
  assert.equal(state.current, "0.1.0");
  assert.equal(state.latest, "0.2.0");
  assert.equal(state.url, `${REPO}/releases/tag/v0.2.0`);
  assert.match(state.notes, /应用内更新/u);
  assert.equal(state.canInstall, true);
  assert.equal(state.checkedAt, "2026-10-24T12:00:00.000Z");
  const requestHeaders = fixture.calls[0].init.headers;
  assert.match(requestHeaders["User-Agent"], /^Skill-Control\/0\.1\.0 /u);
  await fixture.updater.check();
  assert.equal(fixture.calls.length, 1, "reused within a minute");
  assert.equal(fixture.events.at(-1).status, "available");

  const saved = JSON.parse(await readFile(path.join(fixture.root, "userData", "app-update.json"), "utf8"));
  assert.equal(saved.release.version, "0.2.0");
  const { fetchImpl, calls } = fakeFetch({});
  const reloaded = createAppUpdater({
    currentVersion: "0.1.0",
    platform: "darwin",
    arch: "arm64",
    packaged: true,
    env: {},
    fetchImpl,
    stateFile: path.join(fixture.root, "userData", "app-update.json"),
    executablePath: path.join(fixture.current, "Contents", "MacOS", "Skill Control"),
  });
  const cached = await reloaded.status();
  assert.equal(cached.status, "available");
  assert.equal(cached.latest, "0.2.0");
  assert.equal(calls.length, 0, "status() never touches the network");
});

test("download verifies sha512, extracts and validates; install swaps, relaunches and quits", async (t) => {
  const fixture = await controllerFixture(t);
  await fixture.updater.check();
  const ready = await fixture.updater.download();
  assert.equal(ready.status, "ready", ready.error);
  assert.equal(ready.total, ZIP.length);
  assert.equal(ready.percent, 100);
  assert.ok(fixture.events.some((state) => state.status === "downloading"), "progress reaches the window");
  const installed = await fixture.updater.install();
  assert.equal(installed.installing, true);
  assert.equal(await bundleVersion(fixture.current), "0.2.0");
  assert.equal((await readdir(fixture.trash)).length, 1);
  assert.deepEqual(fixture.relaunched, [{ pid: process.pid, appPath: fixture.current }]);
  assert.equal(fixture.quits(), 1);
  assert.deepEqual(await readdir(path.join(fixture.root, "tmp")), [], "the download folder is removed");
});

test("a checksum mismatch stops the download and leaves nothing behind", async (t) => {
  const fixture = await controllerFixture(t, { routes: macRoutes({ zip: Buffer.from("tampered!".padEnd(ZIP.length, "!")) }) });
  await fixture.updater.check();
  const state = await fixture.updater.download();
  assert.equal(state.status, "error");
  assert.match(state.error, /sha512/u);
  assert.deepEqual(await readdir(path.join(fixture.root, "tmp")), []);
  const install = await fixture.updater.install();
  assert.equal(await bundleVersion(fixture.current), "0.1.0");
  assert.equal(install.status, "error");
});

test("a release without latest-mac.yml is an error, not a crash", async (t) => {
  const routes = { [LATEST_RELEASE_API]: () => json(releaseJson("0.2.0", [ZIP_NAME])) };
  const fixture = await controllerFixture(t, { routes });
  await fixture.updater.check();
  const state = await fixture.updater.download();
  assert.equal(state.status, "error");
  assert.match(state.error, /latest-mac\.yml/u);
});

test("an unwritable location falls back to the release page", async (t) => {
  const fixture = await controllerFixture(t, { mac: { checkReplaceable: async () => ({ ok: false, manual: "不可写" }) } });
  const state = await fixture.updater.check();
  assert.equal(state.status, "available");
  assert.equal(state.canInstall, false);
  assert.equal(state.reason, "location");
  const after = await fixture.updater.download();
  assert.equal(after.status, "available");
  assert.deepEqual(fixture.opened, [`${REPO}/releases/tag/v0.2.0`]);
  assert.equal(fixture.calls.filter((call) => call.url.endsWith(".zip")).length, 0);
  await fixture.updater.install();
  assert.equal(fixture.opened.length, 2);
  assert.equal(await bundleVersion(fixture.current), "0.1.0");
});

test("rate limits are errors on demand; background failures keep a known update", async (t) => {
  let limited = false;
  const routes = { ...macRoutes(), [LATEST_RELEASE_API]: () => (limited ? new Response("", { status: 403 }) : json(releaseJson("0.2.0", ["latest-mac.yml", ZIP_NAME]))) };
  const fixture = await controllerFixture(t, { routes, recentMs: 0 });
  assert.equal((await fixture.updater.check()).status, "available");
  limited = true;
  const background = await fixture.updater.check({ background: true });
  assert.equal(background.status, "available");
  assert.match(background.error, /限制/u);
  const onDemand = await fixture.updater.check();
  assert.equal(onDemand.status, "error");
  assert.match(onDemand.error, /限制/u);
});

test("network failures become a readable error", async (t) => {
  const fixture = await controllerFixture(t, {
    routes: {
      [LATEST_RELEASE_API]: () => {
        throw new TypeError("fetch failed");
      },
    },
  });
  const state = await fixture.updater.check();
  assert.equal(state.status, "error");
  assert.match(state.error, /网络/u);
  await fixture.updater.check();
  assert.equal(fixture.calls.length, 2, "a failed check is retried on demand, not reused");
});

test("start() checks once when the last check is old and not when it is recent", async (t) => {
  const scheduled = [];
  const timers = {
    setTimeout: (callback, ms) => (scheduled.push({ callback, ms }), { unref() {} }),
    setInterval: (callback, ms) => (scheduled.push({ callback, ms, repeat: true }), { unref() {} }),
    clearTimeout() {},
    clearInterval() {},
  };
  const fixture = await controllerFixture(t, { timers });
  await fixture.updater.start();
  assert.deepEqual(scheduled.map((entry) => entry.ms), [15_000, 60 * 60 * 1000]);
  scheduled[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fixture.calls.length, 1);
  scheduled[1].callback();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fixture.calls.length, 1, "checked less than 24 h ago");
  fixture.updater.stop();
});

test("Windows: electron-updater downloads and installs; portable builds only point to the page", async (t) => {
  const progress = [];
  const handlers = {};
  const fakeUpdater = {
    on: (name, handler) => (handlers[name] = handler),
    checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version: "0.2.0" } }),
    downloadUpdate: async () => {
      handlers["download-progress"]?.({ transferred: 50, total: 100, percent: 50 });
      handlers["download-progress"]?.({ transferred: 100, total: 100, percent: 100 });
      return [];
    },
    quitAndInstall: (silent, runAfter) => progress.push(["quitAndInstall", silent, runAfter]),
  };
  const routes = { [LATEST_RELEASE_API]: () => json(releaseJson("0.2.0", ["latest.yml", "Skill-Control-0.2.0-win-x64-setup.exe"])) };
  const fixture = await controllerFixture(t, {
    routes,
    platform: "win32",
    arch: "x64",
    resourcesPath: "C:\\Program Files\\Skill Control\\resources",
    fileExists: () => true,
    loadElectronUpdater: async (platform) => {
      progress.push(["load", platform]);
      return fakeUpdater;
    },
  });
  const state = await fixture.updater.check();
  assert.equal(state.status, "available");
  assert.match(state.notice, /SmartScreen/u);
  assert.equal(progress.length, 0, "electron-updater is loaded only when downloading");
  const ready = await fixture.updater.download();
  assert.equal(ready.status, "ready");
  assert.equal(fakeUpdater.autoDownload, false);
  assert.equal(fakeUpdater.autoInstallOnAppQuit, false);
  assert.ok(fixture.events.some((event) => event.status === "downloading" && event.percent === 50));
  await fixture.updater.install();
  assert.deepEqual(progress, [["load", "win32"], ["quitAndInstall", false, true]]);

  const portable = await controllerFixture(t, { routes, platform: "win32", arch: "x64", env: { PORTABLE_EXECUTABLE_DIR: "C:\\Apps" } });
  const portableState = await portable.updater.check();
  assert.equal(portableState.status, "available");
  assert.equal(portableState.canInstall, false);
  assert.equal(portableState.reason, "portable");
  await portable.updater.download();
  assert.equal(portable.opened.length, 1);

  const noConfig = await controllerFixture(t, { routes, platform: "linux", arch: "x64", env: { APPIMAGE: "/opt/sc.AppImage" }, resourcesPath: "/opt/r", fileExists: () => false });
  assert.equal((await noConfig.updater.check()).reason, "package");
});

test("install before a download explains itself", async (t) => {
  const fixture = await controllerFixture(t);
  const before = await fixture.updater.install();
  assert.match(before.error, /没有可安装/u);
  await fixture.updater.check();
  const notDownloaded = await fixture.updater.install();
  assert.match(notDownloaded.error, /请先下载/u);
  assert.equal(await bundleVersion(fixture.current), "0.1.0");
});

// ---------------------------------------------------------------------------
// Preload bridge

test("the preload bridge exposes appUpdate: fixed channels, never rejects, onProgress unsubscribes", async () => {
  const invoked = [];
  const listeners = new Map();
  let exposed = null;
  const electronPath = require.resolve("electron");
  const previous = require.cache[electronPath];
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      contextBridge: { exposeInMainWorld: (name, api) => (exposed = { name, api }) },
      ipcRenderer: {
        invoke: async (channel, ...args) => {
          invoked.push([channel, args.length]);
          if (channel === "desktop:app-update-install") throw new Error("handler missing");
          return { status: "up-to-date", current: "0.2.0", canInstall: true };
        },
        on: (channel, listener) => listeners.set(channel, listener),
        removeListener: (channel, listener) => {
          if (listeners.get(channel) === listener) listeners.delete(channel);
        },
      },
    },
  };
  try {
    delete require.cache[require.resolve("../desktop/preload.cjs")];
    require("../desktop/preload.cjs");
  } finally {
    if (previous) require.cache[electronPath] = previous;
    else delete require.cache[electronPath];
  }
  const { appUpdate } = exposed.api;
  assert.ok(Object.isFrozen(appUpdate));
  assert.equal((await appUpdate.check()).status, "up-to-date");
  assert.equal((await appUpdate.status()).current, "0.2.0");
  await appUpdate.download();
  const failed = await appUpdate.install();
  assert.equal(failed.status, "error", "a failed invoke resolves with an error state");
  assert.deepEqual(invoked, [
    ["desktop:app-update-check", 0],
    ["desktop:app-update-status", 0],
    ["desktop:app-update-download", 0],
    ["desktop:app-update-install", 0],
  ]);
  const received = [];
  const unsubscribe = appUpdate.onProgress((state) => received.push(state));
  listeners.get("desktop:app-update-state")({ sender: "secret" }, { status: "downloading", percent: 10 });
  listeners.get("desktop:app-update-state")({}, "not an object");
  assert.deepEqual(received, [{ status: "downloading", percent: 10 }], "the IPC event is never passed on");
  unsubscribe();
  assert.equal(listeners.has("desktop:app-update-state"), false);
  assert.equal(typeof appUpdate.onProgress("nope"), "function");
});
