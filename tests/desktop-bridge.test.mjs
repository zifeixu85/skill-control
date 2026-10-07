import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { copyTextAllowed, MAX_COPY_BYTES } from "../desktop/copy-text.mjs";

const require = createRequire(import.meta.url);

test("desktop:copy-text accepts plain text up to 1 MB from our window's top frame only", () => {
  const mainFrame = {};
  const webContents = { mainFrame };
  const window = { webContents };
  const event = { sender: webContents, senderFrame: mainFrame };
  assert.equal(copyTextAllowed(event, window, "提示词"), true);
  assert.equal(copyTextAllowed(event, window, "x".repeat(MAX_COPY_BYTES)), true);
  assert.equal(copyTextAllowed(event, window, "字".repeat(MAX_COPY_BYTES / 3 + 1)), false, "UTF-8 bytes, not characters");
  assert.equal(copyTextAllowed(event, window, 42), false);
  assert.equal(copyTextAllowed(event, window, { toString: () => "x" }), false);
  assert.equal(copyTextAllowed({ sender: {}, senderFrame: mainFrame }, window, "x"), false, "another webContents");
  assert.equal(copyTextAllowed({ sender: webContents, senderFrame: {} }, window, "x"), false, "a subframe");
  assert.equal(copyTextAllowed(event, null, "x"), false, "no window");
});

test("the preload bridge exposes copyText and only sends strings", async () => {
  const calls = [];
  let exposed = null;
  const electronPath = require.resolve("electron");
  const previous = require.cache[electronPath];
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      contextBridge: { exposeInMainWorld: (name, api) => (exposed = { name, api }) },
      ipcRenderer: { invoke: async (channel, value) => (calls.push([channel, value]), true) },
    },
  };
  try {
    delete require.cache[require.resolve("../desktop/preload.cjs")];
    require("../desktop/preload.cjs");
  } finally {
    if (previous) require.cache[electronPath] = previous;
    else delete require.cache[electronPath];
  }
  assert.equal(exposed.name, "skillManagerDesktop");
  assert.equal(await exposed.api.copyText("hello"), true);
  assert.equal(await exposed.api.copyText(7), false);
  assert.deepEqual(calls, [["desktop:copy-text", "hello"]]);
  assert.ok(Object.isFrozen(exposed.api));
});
