import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./helpers/load-ts.mjs";

const update = await loadTs("app/lib/app-update.ts");
const about = await loadTs("app/lib/about.ts");

function fakeBridge(overrides = {}) {
  const calls = [];
  let push = null;
  const bridge = {
    calls,
    emit: (state) => push?.(state),
    status: async () => (calls.push("status"), { status: "available", current: "0.2.0", latest: "v0.2.1", canInstall: true, url: "https://github.com/x/releases/tag/v0.2.1" }),
    check: async () => (calls.push("check"), { status: "up-to-date", current: "0.2.0", checkedAt: "2026-10-24T01:00:00Z", canInstall: true }),
    download: async () => (calls.push("download"), { status: "ready", current: "0.2.0", latest: "0.2.1", canInstall: true }),
    install: async () => (calls.push("install"), { status: "error", error: "无法替换应用，当前版本没有改动。" }),
    onProgress: (callback) => {
      push = callback;
      return () => {
        push = null;
        calls.push("unsubscribe");
      };
    },
    ...overrides,
  };
  return bridge;
}

test("app update: start() reads status() and listens; it never checks the network", async () => {
  const bridge = fakeBridge();
  const store = update.createAppUpdateStore(() => bridge);
  await store.start();
  await store.start();
  assert.deepEqual(bridge.calls, ["status"], "one status read, no check, idempotent");
  assert.equal(store.get().status, "available");
  assert.equal(store.get().latest, "0.2.1", "v prefix dropped");
  assert.equal(update.hasNews(store.get()), true);
  bridge.emit({ status: "downloading", percent: 40, transferred: 4, total: 10 });
  assert.equal(store.get().status, "downloading");
  assert.equal(store.get().progress, 0.4);
  assert.equal(store.get().latest, "0.2.1", "a push keeps fields it doesn't carry");
  bridge.emit({ status: "unsupported", reason: "offline" });
  assert.equal(store.get().status, "offline", "offline is unsupported + reason offline");
  store.reset();
  assert.ok(bridge.calls.includes("unsubscribe"));
});

test("app update: check, download and a failed install apply the returned state", async () => {
  const bridge = fakeBridge();
  const store = update.createAppUpdateStore(() => bridge);
  await store.check();
  assert.equal(store.get().status, "up-to-date");
  assert.equal(store.get().checkedAt, "2026-10-24T01:00:00Z");
  await store.download();
  assert.equal(store.get().status, "ready");
  assert.equal(store.get().progress, 1);
  await store.install();
  assert.equal(store.get().status, "error", "install resolves with an error state instead of staying 'installing'");
  assert.match(store.get().error, /当前版本没有改动/u);
});

test("app update: unsupported reasons, unsafe urls and missing bridges degrade cleanly", async () => {
  const dev = update.normalizeState({ status: "unsupported", reason: "development", current: "0.2.0", canInstall: false });
  assert.equal(dev.status, "unsupported");
  assert.equal(update.REASON_TEXT[dev.reason], "开发版本不检查更新。");
  assert.equal(update.normalizeState({ status: "available", url: "http://evil.example/x" }).url, null);
  assert.equal(update.normalizeState({ status: "ready" }).progress, 1);
  assert.equal(update.normalizeState({ status: "error" }).error, "检查更新失败。");
  const none = update.createAppUpdateStore(() => null);
  assert.equal(none.available(), false);
  await none.start();
  await none.check();
  assert.equal(none.get().status, "unsupported");
  const throwing = update.createAppUpdateStore(() => fakeBridge({ check: async () => Promise.reject(new Error("ipc down")) }));
  await throwing.check();
  assert.equal(throwing.get().status, "error");
  assert.equal(throwing.get().error, "ipc down");
});

test("about: author, links and a version that is never hardcoded", () => {
  assert.equal(about.AUTHOR.name, "A梦");
  assert.equal(about.AUTHOR.website.url, "https://ameng.blog");
  assert.equal(about.LINKS.repository, "https://github.com/zifeixu85/skill-control");
  assert.equal(about.LINKS.issues, "https://github.com/zifeixu85/skill-control/issues");
  assert.equal(about.LICENSE_NAME, "MIT");
  assert.match(about.BUILD_VERSION, /^\d+\.\d+\.\d+/u, "from package.json");
  assert.equal(about.appVersion("v0.2.1"), "0.2.1", "runtime version wins");
  assert.equal(about.appVersion(null), about.BUILD_VERSION);
  for (const url of [about.AUTHOR.website.url, ...Object.values(about.LINKS)]) assert.match(url, /^https:\/\//u);
});
