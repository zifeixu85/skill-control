import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./helpers/load-ts.mjs";

const dismiss = await loadTs("app/lib/light-dismiss.ts");
const chips = await loadTs("app/lib/chips.ts");

/** A tiny element stand-in: `closest` walks a list of selector-matching ancestors. */
function element(matches = [], { inside = false, connected = true } = {}) {
  return {
    inside,
    isConnected: connected,
    closest: (selector) => (selector.split(", ").some((part) => matches.includes(part)) ? {} : null),
  };
}
const panel = { contains: (node) => Boolean(node?.inside) };

test("light dismiss: a primary press outside closes the panel", () => {
  assert.equal(dismiss.shouldLightDismiss({ target: element(), panel }), true);
});

test("light dismiss: presses that never close the panel", () => {
  const cases = {
    "inside the panel (incl. a selection drag that starts there)": { target: element([], { inside: true }), panel },
    "on a row or card that opens / switches a detail": { target: element(["[data-detail-trigger]"]), panel },
    "on the panel's own resize handle": { target: element(["[data-keep-panel]"]), panel },
    "inside another panel": { target: element(["[data-panel]"]), panel },
    "in a modal sheet": { target: element(["[aria-modal='true']"]), panel },
    "on a sheet's backdrop": { target: element([".scrim"]), panel },
    "on a toast (e.g. 撤销)": { target: element([".toast-region"]), panel },
    "in a popover or menu": { target: element(["[data-popover]"]), panel },
    "with the right mouse button": { target: element(), panel, button: 2 },
    "on a scrollbar": { target: element(), panel, onScrollbar: true },
    "while the panel is busy": { target: element(), panel, busy: true },
    "on a node already removed from the page": { target: element([], { connected: false }), panel },
    "on a non-element target": { target: { nodeType: 3 }, panel },
    "with no panel mounted": { target: element(), panel: null },
  };
  for (const [name, input] of Object.entries(cases)) {
    assert.equal(dismiss.shouldLightDismiss(input), false, name);
  }
});

test("light dismiss: scrollbar hits are the gutter beyond the client box", () => {
  const box = { clientWidth: 300, clientHeight: 200, scrollHeight: 900, scrollWidth: 300 };
  assert.equal(dismiss.onOwnScrollbar(box, 305, 50), true);
  assert.equal(dismiss.onOwnScrollbar(box, 120, 50), false);
  assert.equal(dismiss.onOwnScrollbar({ ...box, scrollHeight: 200 }, 305, 50), false, "no vertical scrollbar");
  assert.equal(dismiss.onOwnScrollbar(null, 1, 1), false);
});

test("chips: status → kind → count, stable within a kind, then +N", () => {
  const list = [
    chips.countChip("skills", 3, " 个技能"),
    { id: "kind", kind: "kind", text: "专家" },
    { id: "in-use", kind: "status", text: "使用中" },
    chips.countChip("used", 171, " 次", "用过 "),
    { id: "packaged", kind: "status", text: "已打包" },
  ];
  const all = chips.arrangeChips(list, 10);
  assert.deepEqual(all.shown.map((chip) => chip.id), ["in-use", "packaged", "kind", "skills", "used"]);
  assert.equal(all.hidden.length, 0);
  const folded = chips.arrangeChips(list, 3);
  assert.deepEqual(folded.shown.map((chip) => chip.id), ["in-use", "packaged"], "+N takes a slot");
  assert.deepEqual(folded.hidden.map((chip) => chip.id), ["kind", "skills", "used"]);
  assert.equal(list[3].text, "用过 171 次");
  assert.deepEqual(list[3].count, { before: "用过 ", value: 171, after: " 次" });
});

test("chips: fitting a row keeps room for +N and always shows one chip", () => {
  assert.equal(chips.fitCount([40, 40, 40], 200, 5, 30), 3, "all fit");
  assert.equal(chips.fitCount([40, 40, 40], 100, 5, 30), 1, "two would fit, but then +N doesn't");
  assert.equal(chips.fitCount([40, 40, 40, 40], 130, 5, 30), 2);
  assert.equal(chips.fitCount([300], 100, 5, 30), 1, "a single long chip truncates");
  assert.equal(chips.fitCount([300, 20], 100, 5, 30), 1);
  assert.equal(chips.fitCount([20, 20, 20, 20, 20], 500, 5, 30, 3), 3, "max caps it");
});

test("plugin chips: kinds before counts, and 只有配置 when a plugin brings nothing", async () => {
  const plugins = await loadTs("app/lib/plugins.ts");
  const full = plugins.pluginInside({ components: { skills: [1, 2], apps: [{}], mcpServers: [{}], hooks: true, commands: [1] } });
  assert.deepEqual(full.map((chip) => chip.id), ["apps", "mcp", "hooks", "skills", "commands"]);
  assert.deepEqual(full[3].count, { before: "", value: 2, after: " 个技能" });
  assert.deepEqual(plugins.pluginInside({ components: {} }).map((chip) => chip.text), ["只有配置"]);
});

test("CLI checks carry a column key and a short cell label", async () => {
  const cli = await loadTs("app/lib/cli-tools.ts");
  const checks = cli.agentChecks(
    { agentId: "codex", pathSource: "终端", resolves: null, workspace: "local", workspaceConfigured: true, keychainReachable: "yes", skill: { name: "lark-doc", inLibrary: true, visible: false }, allowRule: "missing", sandboxNetwork: "blocked" },
    "1.0.97",
  );
  assert.deepEqual(checks.map((check) => [check.key, check.short]), [
    ["command", "找不到"],
    ["workspace", "已配置"],
    ["keychain", "能读到"],
    ["skill", "看不到"],
    ["allow", "每次确认"],
    ["sandbox", "不能联网"],
  ]);
  assert.deepEqual(cli.CHECK_COLUMNS.map((column) => column.key), ["command", "workspace", "keychain", "skill", "allow", "sandbox"]);
});

test("layout contract: sticky panel header and footer, metrics never wrap", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = (name) => readFile(new URL(`../app/styles/${name}`, import.meta.url), "utf8");
  const rule = (text, selector) => {
    // A rule that starts its own line, not ".inspector > .panel {".
    const start = text.indexOf(`\n${selector} {`);
    assert.ok(start >= 0, `missing ${selector}`);
    return text.slice(start, text.indexOf("}", start));
  };
  const inspector = await css("inspector.css");
  assert.match(rule(inspector, ".panel-head"), /position: sticky;[\s\S]*top: 0/);
  assert.match(rule(inspector, ".panel-foot"), /position: sticky;[\s\S]*bottom: 0/);
  assert.match(rule(inspector, ".panel"), /overflow-y: auto/);
  const anatomy = await css("anatomy.css");
  assert.match(rule(anatomy, ".metric"), /white-space: nowrap/);
  assert.match(rule(anatomy, ".it-title"), /white-space: nowrap/);
  assert.match(rule(anatomy, ".card-foot"), /margin-top: auto/);
});
