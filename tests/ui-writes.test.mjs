import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { loadTs } from "./helpers/load-ts.mjs";

const { api, ApiError, TIMEOUTS } = await loadTs("app/lib/api.ts");
const flow = await loadTs("app/lib/plan-flow.ts");
const { createEscapeStack } = await loadTs("app/lib/escape-stack.ts");

// Every write and every plan the client can send. A new api.* write or plan must be added
// here, so the confirm rule below is checked for it too.
const WRITE_ARGS = {
  executeSync: [{ sourceInstanceId: "s", targetAgentIds: ["codex"], mode: "copy" }],
  executeImport: ["imp", ["codex"]],
  applyUpdate: ["plan-1"],
  libraryApply: ["plan-1"],
  applyRestore: ["plan-1"],
  applyUninstall: ["plan-1"],
  restoreTrash: ["trash-1"],
  cliApply: ["plan-1"],
};
const PLAN_ARGS = {
  planSync: [{ sourceInstanceId: "s", targetAgentIds: ["codex"], mode: "copy" }],
  planImport: ["imp", ["codex"]],
  planUpdate: ["unit"],
  libraryPlan: [{ action: "batch" }],
  planRestore: ["h1", ["u1"]],
  planUninstall: ["skill", "codex"],
  cliPlan: ["lark-cli", "wrapper"],
};
const isWrite = (name) => /^(execute|apply|restore)|Apply$/.test(name);
const isPlan = (name) => /^plan|Plan$/.test(name);

function stubFetch(t) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (target, init = {}) => {
    calls.push({ target: String(target), init, body: init.body ? JSON.parse(init.body) : null });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
  return calls;
}

test("every apply / restore sends confirm:true and the confirm header; no plan does", async (t) => {
  const calls = stubFetch(t);
  const writes = Object.keys(api).filter(isWrite);
  const plans = Object.keys(api).filter(isPlan);
  assert.deepEqual(writes.sort(), Object.keys(WRITE_ARGS).sort(), "a write without a test case");
  assert.deepEqual(plans.sort(), Object.keys(PLAN_ARGS).sort(), "a plan without a test case");
  for (const name of writes) {
    calls.length = 0;
    await api[name](...WRITE_ARGS[name]);
    assert.equal(calls.length, 1, name);
    assert.equal(calls[0].init.method, "POST", name);
    assert.equal(calls[0].init.headers["x-skill-manager-confirm"], "yes", `${name} header`);
    assert.equal(calls[0].body.confirm, true, `${name} body`);
  }
  for (const name of plans) {
    calls.length = 0;
    await api[name](...PLAN_ARGS[name]);
    assert.equal(calls.length, 1, name);
    assert.equal(calls[0].init.headers["x-skill-manager-confirm"], undefined, `${name} must not confirm`);
    assert.notEqual(calls[0].body.confirm, true, `${name} must not confirm in the body`);
  }
  calls.length = 0;
  await api.planRestore("h1", ["u1", "u2"]);
  assert.deepEqual(calls[0].body, { historyId: "h1", select: ["u1", "u2"] });
});

test("a plan that never answers fails with a timeout instead of hanging", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  t.mock.method(globalThis, "fetch", (target, init) =>
    new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))),
  );
  const pending = api.libraryPlan({ action: "batch" });
  mock.timers.tick(TIMEOUTS.plan);
  await assert.rejects(pending, (error) => error instanceof ApiError && error.timedOut && error.status === 0);
});

test("error responses carry the service's code; older services without one still work", async (t) => {
  const answers = [
    [409, { error: "~/x 在生成计划后有变化，请重新生成恢复计划。", code: "stale-plan" }],
    [404, { error: "接口不存在。", code: "route-missing" }],
    [404, { error: "接口不存在。" }],
    [409, { error: "已存在", code: "Not A Code" }],
  ];
  t.mock.method(globalThis, "fetch", async () => {
    const [status, body] = answers.shift();
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  const caught = async () => api.applyRestore("p").then(() => assert.fail("must reject"), (error) => error);
  const stale = await caught();
  assert.deepEqual([stale.status, stale.code, stale.unsupported], [409, "stale-plan", false]);
  assert.equal(flow.classifyApplyError(stale), "stale");
  const missing = await caught();
  assert.deepEqual([missing.code, missing.unsupported], ["route-missing", true]);
  assert.equal((await caught()).unsupported, true, "an older service: by message");
  assert.equal((await caught()).code, null, "only well-formed codes are kept");
});

test("plan flow: the service's code decides, message matching is only the fallback", () => {
  const coded = (status, code, message = "x") => new ApiError(message, status, false, false, code);
  assert.equal(flow.classifyApplyError(coded(409, "stale-plan")), "stale");
  assert.equal(flow.classifyApplyError(coded(404, "plan-expired")), "stale");
  assert.equal(flow.classifyApplyError(coded(404, "plan-not-found")), "stale");
  // The code wins over a message that only looks like a stale plan.
  assert.equal(flow.classifyApplyError(coded(409, "updates-offline", "离线，请重新生成")), "failed");
  assert.equal(flow.classifyApplyError(coded(409, "refused", "这条记录已变化")), "failed");
  assert.equal(flow.classifyApplyError(coded(409, "conflict", "原位置已有同名条目，请先处理。")), "failed");
  assert.equal(flow.classifyApplyError(coded(404, "not-found")), "failed", "a missing history entry is not a stale plan");
  assert.equal(flow.classifyApplyError(coded(0, "stale-plan")), "unknown", "no answer stays unknown");
});

const key = (n) => `req#${n}`;
const idOf = (plan) => plan.planId;

test("plan flow: a failed re-plan clears the old plan, and a plan for an older request can't apply", () => {
  let state = flow.initialFlow();
  state = flow.flowReducer(state, { type: "planned", key: key(1), plan: { planId: "p1" } });
  assert.equal(flow.flowView(state, key(1), idOf).canApply, true);
  // The user changes a choice: request 2 starts, the plan for request 1 no longer counts.
  const changed = flow.flowView(state, key(2), idOf);
  assert.equal(changed.planning, true);
  assert.equal(changed.plan, null);
  assert.deepEqual(changed.lastPlan, { planId: "p1" }, "still shown dimmed");
  assert.equal(changed.canApply, false);
  state = flow.flowReducer(state, { type: "plan-failed", key: key(2), message: "boom" });
  const failed = flow.flowView(state, key(2), idOf);
  assert.equal(failed.plan, null);
  assert.equal(failed.lastPlan, null, "the old plan is gone after a failed re-plan");
  assert.equal(failed.planError, "boom");
  assert.equal(failed.canApply, false);
});

test("plan flow: no double submit, empty plan ids and expired plans never apply", () => {
  let state = flow.flowReducer(flow.initialFlow(), { type: "planned", key: key(1), plan: { planId: "p1" } });
  state = flow.flowReducer(state, { type: "apply-started" });
  assert.equal(flow.flowView(state, key(1), idOf).canApply, false, "while applying");
  assert.equal(flow.flowReducer(state, { type: "apply-started" }), state, "second start is ignored");
  state = flow.flowReducer(state, { type: "applied", result: { ok: true } });
  assert.equal(flow.flowView(state, key(1), idOf).canApply, false, "after the result");

  const empty = flow.flowReducer(flow.initialFlow(), { type: "planned", key: key(1), plan: { planId: "" } });
  assert.equal(flow.flowView(empty, key(1), idOf).canApply, false);

  let expiring = flow.flowReducer(flow.initialFlow(), { type: "planned", key: key(1), plan: { planId: "p1" } });
  expiring = flow.flowReducer(expiring, { type: "expired", planId: "p1" });
  const view = flow.flowView(expiring, key(1), idOf);
  assert.equal(view.expired, true);
  assert.equal(view.canApply, false);
});

test("plan flow: 404 / 409 re-plan with a notice, lost connections are 'unknown', other errors stay errors", () => {
  assert.equal(flow.classifyApplyError(new ApiError("计划不存在或已过期", 404)), "stale");
  assert.equal(flow.classifyApplyError(new ApiError("~/x 在生成计划后有变化，请重新生成恢复计划。", 409)), "stale");
  assert.equal(flow.classifyApplyError(new ApiError("离线模式下不执行会联网的更新命令。", 409)), "failed", "a refusal is not a stale plan");
  assert.equal(flow.classifyApplyError(new ApiError("接口不存在。", 404, true)), "failed", "a missing route is not a stale plan");
  assert.equal(flow.classifyApplyError(new ApiError("连不上", 0)), "unknown");
  assert.equal(flow.classifyApplyError(new ApiError("超时", 0, false, true)), "unknown");
  assert.equal(flow.classifyApplyError(new ApiError("坏了", 500)), "failed");
  assert.equal(flow.classifyApplyError(new Error("x")), "failed");

  const planned = flow.flowReducer(flow.initialFlow(), { type: "planned", key: key(1), plan: { planId: "p1" } });
  const started = flow.flowReducer(planned, { type: "apply-started" });
  const stale = flow.flowReducer(started, { type: "apply-failed", failure: "stale", message: flow.applyFailureMessage("stale", new ApiError("计划不存在或已过期（10 分钟），请重新生成。", 404), "x") });
  assert.equal(stale.plan, null);
  assert.equal(stale.applying, false);
  assert.equal(stale.notice, "计划不存在或已过期（10 分钟）。已重新生成计划，请再看一遍。");
  assert.equal(
    flow.applyFailureMessage("stale", new ApiError("~/.claude/skills/x 在生成计划后有变化，请重新生成恢复计划。", 409), "x"),
    "~/.claude/skills/x 在生成计划后有变化。已重新生成计划，请再看一遍。",
  );
  assert.equal(stale.error, "");
  assert.equal(flow.flowView(stale, key(1), idOf).planning, true, "waits for the new plan");

  const unknown = flow.flowReducer(started, { type: "apply-failed", failure: "unknown", message: flow.UNKNOWN_OUTCOME });
  assert.match(unknown.notice, /不知道这次有没有写入/);
  const failed = flow.flowReducer(started, { type: "apply-failed", failure: "failed", message: "坏了" });
  assert.equal(failed.error, "坏了");
  assert.equal(failed.plan, null, "the service dropped the plan; a new one is needed");
});

test("Esc closes only the top layer; a busy layer swallows it instead of letting it fall through", () => {
  const stack = createEscapeStack();
  const closed = [];
  const removeInspector = stack.push(() => closed.push("inspector"));
  const removeSheet = stack.push(() => {}); // a confirm sheet while its write runs
  assert.equal(stack.escape(), true);
  assert.deepEqual(closed, [], "the inspector underneath stays open");
  removeSheet();
  stack.escape();
  assert.deepEqual(closed, ["inspector"]);
  removeInspector();
  assert.equal(stack.escape(), false);
  assert.equal(stack.size(), 0);
});
