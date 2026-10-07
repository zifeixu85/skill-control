import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./helpers/load-ts.mjs";

const { copyText, COPIED_FOR_AI } = await loadTs("app/lib/clipboard.ts");

function fakeDocument({ execResult = true, throws = false } = {}) {
  const calls = { appended: 0, removed: 0, selected: 0, exec: [], focused: 0, value: null };
  const previous = { focus: () => (calls.focused += 1) };
  const document = {
    activeElement: previous,
    body: { appendChild: () => (calls.appended += 1) },
    createElement: () => ({
      value: "",
      style: {},
      setAttribute() {},
      select() {
        calls.selected += 1;
        calls.value = this.value;
      },
      remove: () => (calls.removed += 1),
    }),
    execCommand: (command) => {
      calls.exec.push(command);
      if (throws) throw new Error("blocked");
      return execResult;
    },
  };
  return { document, calls };
}

test("clipboard: the desktop bridge wins and nothing else is touched", async () => {
  const seen = [];
  const { document, calls } = fakeDocument();
  const ok = await copyText("hello", {
    bridge: { copyText: async (text) => (seen.push(["bridge", text]), true) },
    clipboard: { writeText: async (text) => seen.push(["clipboard", text]) },
    document,
  });
  assert.equal(ok, true);
  assert.deepEqual(seen, [["bridge", "hello"]]);
  assert.equal(calls.exec.length, 0);
});

test("clipboard: bridge answering false or throwing falls back to navigator.clipboard", async () => {
  for (const bridge of [{ copyText: async () => false }, { copyText: async () => Promise.reject(new Error("ipc")) }]) {
    const seen = [];
    const ok = await copyText("x", { bridge, clipboard: { writeText: async (text) => seen.push(text) }, document: null });
    assert.equal(ok, true);
    assert.deepEqual(seen, ["x"]);
  }
});

test("clipboard: denied navigator.clipboard falls back to a hidden textarea + execCommand", async () => {
  const { document, calls } = fakeDocument();
  const ok = await copyText("命令 a && b", {
    bridge: null,
    clipboard: { writeText: async () => Promise.reject(new Error("NotAllowedError")) },
    document,
  });
  assert.equal(ok, true);
  assert.deepEqual(calls.exec, ["copy"]);
  assert.equal(calls.value, "命令 a && b");
  assert.equal(calls.appended, 1);
  assert.equal(calls.removed, 1, "the textarea is always removed");
  assert.equal(calls.focused, 1, "focus returns to where it was");
});

test("clipboard: every route failing resolves false and never throws", async () => {
  const failing = fakeDocument({ throws: true });
  assert.equal(await copyText("x", { bridge: { copyText: async () => false }, clipboard: null, document: failing.document }), false);
  assert.equal(failing.calls.removed, 1);
  const refused = fakeDocument({ execResult: false });
  assert.equal(await copyText("x", { document: refused.document }), false);
  assert.equal(await copyText("x", {}), false, "no bridge, no clipboard, no document");
  assert.equal(await copyText(undefined, {}), false);
  const noBody = { activeElement: null, body: null, createElement: fakeDocument().document.createElement, execCommand: () => true };
  assert.equal(await copyText("x", { document: noBody }), false, "a missing body is a failure, not a crash");
});

test("clipboard: the shared toast text names the AI tools", () => {
  assert.equal(COPIED_FOR_AI, "已复制，粘贴给你常用的 AI（如 Codex、Claude Code）");
});
