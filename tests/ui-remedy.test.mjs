import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./helpers/load-ts.mjs";

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

const remedy = await loadTs("app/lib/remedy.ts");
const health = await loadTs("app/lib/health.ts");
const updates = await loadTs("app/lib/updates.ts");

const BOTH = { prompt: "请帮我修复失效的软链接", commands: [{ label: "删除失效链接", command: "rm ~/.claude/skills/x" }, { command: "ls ~/.claude/skills" }] };

test("remedy: tolerant parsing; empty remedies are null", () => {
  assert.equal(remedy.normalizeRemedy(null), null);
  assert.equal(remedy.normalizeRemedy({ prompt: "  ", commands: [{ command: " " }] }), null);
  assert.deepEqual(remedy.normalizeRemedy({ prompt: "p" }), { prompt: "p", commands: [], action: null });
  assert.deepEqual(remedy.normalizeRemedy({ prompt: "p", action: { kind: "agent-update", id: "codex" } }).action, { kind: "agent-update", id: "codex" });
  assert.equal(remedy.normalizeRemedy({ prompt: "p", action: { kind: "agent-update" } }).action, null, "an action needs an id");
  assert.deepEqual(remedy.normalizeRemedy(BOTH).commands, [
    { label: "删除失效链接", command: "rm ~/.claude/skills/x" },
    { label: null, command: "ls ~/.claude/skills" },
  ]);
});

test("remedy: the terminal tab exists only when there are commands; AI is the default", () => {
  const promptOnly = remedy.normalizeRemedy({ prompt: "p" });
  const both = remedy.normalizeRemedy(BOTH);
  const commandsOnly = remedy.normalizeRemedy({ commands: [{ command: "npm i -g x" }] });
  assert.deepEqual(remedy.remedyModes(promptOnly), ["ai"]);
  assert.deepEqual(remedy.remedyModes(both), ["ai", "terminal"]);
  assert.deepEqual(remedy.remedyModes(commandsOnly), ["terminal"]);
  // A remembered "terminal" falls back to AI where there are no commands, and back again.
  assert.equal(remedy.resolveMode("terminal", promptOnly), "ai");
  assert.equal(remedy.resolveMode("terminal", both), "terminal");
  assert.equal(remedy.resolveMode("ai", commandsOnly), "terminal");
  assert.equal(remedy.remedyText(both, "ai"), "请帮我修复失效的软链接");
  assert.equal(remedy.remedyText(both, "terminal"), "# 删除失效链接\nrm ~/.claude/skills/x\n\nls ~/.claude/skills");
});

test("remedy: the chosen tab is remembered in localStorage, and bad or blocked storage is harmless", async () => {
  const storage = fakeStorage({ "skill-control:remedy-mode": "terminal" });
  globalThis.window = { localStorage: storage };
  try {
    const fresh = await loadTs("app/lib/remedy.ts");
    assert.equal(fresh.remedyModeStore.get(), "terminal", "read back on start");
    fresh.remedyModeStore.set("ai");
    assert.equal(storage.data.get("skill-control:remedy-mode"), "ai");

    globalThis.window = { localStorage: fakeStorage({ "skill-control:remedy-mode": "rm -rf" }) };
    assert.equal((await loadTs("app/lib/remedy.ts")).remedyModeStore.get(), "ai", "invalid values fall back to AI");

    globalThis.window = {
      get localStorage() {
        throw new Error("SecurityError");
      },
    };
    const blocked = (await loadTs("app/lib/remedy.ts")).remedyModeStore;
    assert.equal(blocked.get(), "ai");
    blocked.set("terminal");
    assert.equal(blocked.get(), "terminal", "still switches for this session");
  } finally {
    delete globalThis.window;
  }
});

test("remedy: health findings and update units carry remedy; reports carry remedyAll", () => {
  const report = health.normalizeHealthReport({
    findings: [{ id: "a", severity: "high", category: "broken-link", title: "t", remedy: BOTH }, { id: "b", title: "u" }],
    remedyAll: { prompt: "一次处理全部" },
  });
  assert.equal(report.findings[0].remedy.commands.length, 2);
  assert.equal(report.findings[1].remedy, null);
  assert.deepEqual(report.remedyAll, { prompt: "一次处理全部", commands: [], action: null });
  assert.equal(health.normalizeHealthReport({}).remedyAll, null);

  const data = updates.normalizeUpdates({
    units: [{ unitKey: "k", title: "x", status: "update-available", remedy: { prompt: "更新 x" } }],
    remedyAll: { prompt: "全部更新", commands: [{ command: "npx skills update" }] },
  });
  assert.equal(data.units[0].remedy.prompt, "更新 x");
  assert.equal(data.remedyAll.commands[0].command, "npx skills update");
});
