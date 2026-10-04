import assert from "node:assert/strict";
import test from "node:test";
import { isReversible } from "../server/library-ops.mjs";
import { CodedError, createPlanStore, errorCode } from "../server/plan-store.mjs";

const TTL = 10 * 60_000;

test("a plan runs once; an unknown id is plan-not-found and a late confirm is plan-expired", () => {
  let clock = 1_000_000;
  const store = createPlanStore({ ttlMs: TTL, now: () => clock });
  const once = store.remember({ kind: "restore", value: 1 });
  assert.equal(store.take(once).value, 1);
  const notFound = (error) => error.statusCode === 404 && error.code === "plan-not-found" && /不存在或已过期/u.test(error.message);
  assert.throws(() => store.take(once), notFound, "single use");
  assert.throws(() => store.take("nope"), notFound);
  assert.throws(() => store.take(undefined), notFound);

  const late = store.remember({ kind: "restore" });
  clock += TTL + 1;
  assert.throws(() => store.take(late), (error) => error.statusCode === 404 && error.code === "plan-expired");
  assert.throws(() => store.take(late), (error) => error.code === "plan-expired", "still expired, not unknown");
});

test("a plan of another kind is not handed out and stays usable for its own kind", () => {
  const store = createPlanStore({ ttlMs: TTL, label: "更新计划" });
  const id = store.remember({ kind: "uninstall" });
  assert.throws(() => store.take(id, "restore"), (error) => error.code === "plan-not-found" && error.message.startsWith("更新计划"));
  assert.equal(store.take(id, "uninstall").kind, "uninstall");
});

test("error codes: explicit lowercase codes pass, system codes never do, defaults by status", () => {
  assert.equal(errorCode(new CodedError(409, "x", "stale-plan"), 409), "stale-plan");
  assert.equal(errorCode(Object.assign(new Error("x"), { code: "ENOENT" }), 400), null, "Node error codes stay internal");
  assert.equal(errorCode(Object.assign(new Error("x"), { code: "ENOENT" }), 409), "conflict");
  assert.equal(errorCode(new Error("x"), 404), "not-found");
  assert.equal(errorCode(new Error("x"), 403), "forbidden");
  assert.equal(errorCode(new Error("x"), 500), null);
});

test("reversible ops: what history can undo", () => {
  for (const op of ["move", "stash", "unlink", "link", "write"]) assert.equal(isReversible({ op }), true, op);
  assert.equal(isReversible({ op: "command" }), false, "a command without a config snapshot");
  assert.equal(isReversible({ op: "command", restoreFile: { path: "~/x", backup: "~/y" } }), true);
  assert.equal(isReversible({ op: "snapshot" }), false);
  assert.equal(isReversible(null), false);
});
