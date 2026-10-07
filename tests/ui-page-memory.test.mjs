import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./helpers/load-ts.mjs";

const memory = await loadTs("app/lib/page-memory.ts");

test("page memory: values survive leaving a page and notify subscribers", () => {
  memory.clearMemory();
  let calls = 0;
  const stop = memory.subscribeMemory("health:expanded:high:broken-link", () => (calls += 1));
  assert.equal(memory.readMemory("health:expanded:high:broken-link", false), false);
  memory.writeMemory("health:expanded:high:broken-link", true);
  memory.writeMemory("health:expanded:high:broken-link", true);
  assert.equal(calls, 1, "unchanged writes do not notify");
  assert.equal(memory.readMemory("health:expanded:high:broken-link", false), true);
  stop();
  memory.writeMemory("health:expanded:high:broken-link", false);
  assert.equal(calls, 1);
});

test("page memory: the opened item stays marked; the arrival flash happens once", () => {
  memory.clearMemory();
  assert.equal(memory.takeArrival("health"), null);
  memory.markOpened("health", "finding-7");
  assert.equal(memory.readMemory(memory.openedKey("health"), null), "finding-7");
  assert.equal(memory.takeArrival("health"), "finding-7");
  assert.equal(memory.takeArrival("health"), null, "only once per 查看详情");
  assert.equal(memory.readMemory(memory.openedKey("health"), null), "finding-7", "the quiet marker stays");
  assert.equal(memory.takeArrival("updates"), null, "pages don't share");
});
